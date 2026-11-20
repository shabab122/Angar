import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ObjectId, MongoClient } from "mongodb";
import { fixture, post, ok, error, key, password } from "./support.js";
import {
  createBackup,
  openBackup,
  restoreBackup,
  verifyBackup,
  runBackupJobs,
} from "../server/backups.js";

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "angar-backup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const media = path.join(directory, "media");
  await mkdir(media);
  const f = await fixture(t, {
    backup: {
      key: randomBytes(32).toString("hex"),
      directory: path.join(directory, "backups"),
    },
    uploadDir: media,
  });
  return { ...f, directory, media };
}
test("encrypted backups round-trip MongoDB types, indexes and photos into an isolated verified restore", async (t) => {
  const f = await setup(t),
    id = "BK-" + key(),
    photo = randomBytes(18).toString("hex") + ".webp";
  await writeFile(
    path.join(f.media, photo),
    Buffer.from("controlled test photo bytes"),
  );
  const reviewId = new ObjectId();
  await f.store.notificationPreferences.insertOne({
    _id: "guest:restore-test",
    email: true,
    sms: true,
    push: true,
    generation: 0,
    sinceAt: new Date(),
  });
  await f.store.reviews.insertOne({
    _id: reviewId,
    orderId: new ObjectId(),
    dishId: "test",
    imageFile: photo,
    createdAt: new Date(),
    rating: 5,
  });
  const summary = await createBackup(f.store, f.config, id);
  assert.equal(summary.photos, 1);
  const file = path.join(f.config.backup.directory, id + ".akbackup"),
    bytes = await readFile(file);
  assert.equal(
    bytes.includes(Buffer.from("controlled test photo bytes")),
    false,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const target = "angar_recovery_test_" + key(),
    media = path.join(f.directory, "restored");
  t.after(async () => {
    const client = await new MongoClient(f.config.mongoUri).connect();
    try {
      await client.db(target).dropDatabase();
    } finally {
      await client.close();
    }
  });
  const restored = await restoreBackup(f.store, f.config, id, target, media);
  assert.equal(restored.verified, true);
  const document = await f.store.client
    .db(target)
    .collection("reviews")
    .findOne({ _id: reviewId });
  assert.ok(document.createdAt instanceof Date);
  assert.ok(document._id instanceof ObjectId);
  assert.deepEqual(
    await readFile(path.join(media, photo)),
    Buffer.from("controlled test photo bytes"),
  );
  assert.equal(
    await f.store.client
      .db(target)
      .collection("staffSessions")
      .countDocuments({}),
    0,
  );
  const restoredPreferences = await f.store.client
    .db(target)
    .collection("notificationPreferences")
    .findOne({ _id: "guest:restore-test" });
  assert.equal(restoredPreferences.email, false);
  assert.equal(restoredPreferences.sms, false);
  assert.equal(restoredPreferences.push, false);
  await assert.rejects(
    restoreBackup(
      f.store,
      f.config,
      id,
      f.config.mongoDatabase,
      path.join(f.directory, "bad"),
    ),
    (e) => e.code === "RESTORE_TARGET",
  );
  await assert.rejects(
    restoreBackup(
      f.store,
      f.config,
      id,
      target,
      path.join(f.directory, "another"),
    ),
    (e) => e.code === "RESTORE_EXISTS",
  );
  assert.equal((await verifyBackup(f.store, f.config, id)).verified, true);
});
test("backup corruption and a wrong key fail before a target database is created", async (t) => {
  const f = await setup(t),
    id = "BK-" + key();
  await createBackup(f.store, f.config, id);
  await assert.rejects(
    openBackup(
      {
        ...f.config,
        backup: { ...f.config.backup, key: randomBytes(32).toString("hex") },
      },
      id,
    ),
    (e) => e.code === "BACKUP_INTEGRITY",
  );
  const file = path.join(f.config.backup.directory, id + ".akbackup"),
    bytes = await readFile(file);
  bytes[40] ^= 1;
  await writeFile(file, bytes);
  const target = "angar_corrupt_test_" + key();
  await assert.rejects(
    restoreBackup(f.store, f.config, id, target, path.join(f.directory, "bad")),
    (e) => e.code === "BACKUP_INTEGRITY",
  );
  assert.equal(
    (await f.store.client.db(target).listCollections().toArray()).length,
    0,
  );
});
test("backup schedules and manual jobs are admin-only and restore drills complete without changing live data", async (t) => {
  const f = await setup(t);
  error(await f.staff.cashier("/api/staff/backups"), 403);
  ok(
    await post(f.staff.admin, "/api/staff/backups/settings", {
      enabled: true,
      everyHours: 24,
      keep: 2,
      currentPassword: password,
    }),
  );
  const job = ok(await post(f.staff.admin, "/api/staff/backups"), 202).job;
  await runBackupJobs(f.store, f.config);
  assert.equal(
    (await f.store.backupJobs.findOne({ _id: job.id })).status,
    "completed",
  );
  assert.equal(
    (await f.store.backupJobs.findOne({ _id: job.id })).result.verified,
    true,
  );
  const drill = ok(
    await post(f.staff.admin, "/api/staff/backups/" + job.id + "/verify"),
    202,
  ).job;
  await runBackupJobs(f.store, f.config);
  assert.equal(
    (await f.store.backupJobs.findOne({ _id: drill.id })).status,
    "completed",
  );
  assert.equal(await f.store.staff.countDocuments({ active: true }), 4);
  assert.equal(
    (await f.store.settings.findOne({ _id: "backup-config" })).enabled,
    true,
  );
});

test("a due automatic schedule verifies its snapshot and retention removes only older completed bundles", async (t) => {
  const f = await setup(t);
  ok(
    await post(f.staff.admin, "/api/staff/backups/settings", {
      enabled: true,
      everyHours: 1,
      keep: 1,
      currentPassword: password,
    }),
  );
  const ids = [];
  for (let index = 0; index < 2; index++) {
    await f.store.settings.updateOne(
      { _id: "backup-config" },
      { $set: { nextAt: new Date(Date.now() - 1000) } },
    );
    await runBackupJobs(f.store, f.config);
    const row = await f.store.backupJobs.findOne(
      { requestedBy: "schedule", removedAt: { $exists: false } },
      { sort: { createdAt: -1 } },
    );
    assert.equal(row.status, "completed");
    assert.equal(row.result.verified, true);
    ids.push(row._id);
  }
  assert.notEqual(ids[0], ids[1]);
  await assert.rejects(
    stat(path.join(f.config.backup.directory, ids[0] + ".akbackup")),
    (error) => error.code === "ENOENT",
  );
  assert.ok(
    (
      await stat(path.join(f.config.backup.directory, ids[1] + ".akbackup"))
    ).isFile(),
  );
  assert.ok(
    (await f.store.settings.findOne({ _id: "backup-config" })).nextAt >
      new Date(),
  );
  assert.equal(await f.store.staff.countDocuments({ active: true }), 4);
});
