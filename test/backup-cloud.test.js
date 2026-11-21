import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, post, ok, error, key, password } from "./support.js";
import { createBackup, runBackupJobs, openBackup } from "../server/backups.js";
import {
  copyBackupToCloud,
  runCloudBackupJobs,
  queueCloudBackup,
  listCloudBackups,
  fetchCloudBackup,
} from "../server/backup-cloud.js";

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "angar-cloud-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const objects = new Map(),
    calls = [],
    control = { corrupt: false, fail: false };
  const service = {
    send: async (command) => {
      calls.push(command);
      const input = command.input;
      if (control.fail) throw Error("Controlled provider connection failure");
      if (command.constructor.name === "PutObjectCommand") {
        assert.equal(input.IfNoneMatch, "*");
        assert.equal(input.ACL, undefined);
        if (objects.has(input.Key)) {
          const error = new Error("Exists");
          error.name = "PreconditionFailed";
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
        objects.set(input.Key, {
          Body: Buffer.from(input.Body),
          Metadata: { ...input.Metadata },
        });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const row = objects.get(input.Key);
        if (!row) throw Error("Missing controlled object");
        return {
          ...row,
          Body: control.corrupt
            ? Buffer.from("corrupt controlled object")
            : Buffer.from(row.Body),
          ContentLength: row.Body.length,
        };
      }
      return {
        Contents: [...objects].map(([Key, row]) => ({
          Key,
          Size: row.Body.length,
          LastModified: new Date(),
        })),
      };
    },
  };
  const f = await fixture(t, {
    backup: {
      key: randomBytes(32).toString("hex"),
      directory: path.join(directory, "backups"),
    },
    backupS3: {
      bucket: "private-test-backups",
      region: "us-east-1",
      prefix: "restaurant/",
      endpoint: "https://s3.example.test",
      accessKeyId: "test-id",
      secretAccessKey: "test-secret",
    },
    backupS3Client: service,
  });
  return { ...f, directory, objects, calls, control };
}
test("off-site copies upload only encrypted bundles, verify actual downloaded bytes and safely repeat the same object", async (t) => {
  const f = await setup(t),
    id = "BK-" + key();
  await createBackup(f.store, f.config, id);
  error(await f.staff.cashier("/api/staff/backup-cloud"), 403);
  ok(
    await post(f.staff.admin, "/api/staff/backup-cloud/settings", {
      enabled: true,
      currentPassword: password,
    }),
  );
  await f.store.backupJobs.insertOne({
    _id: id,
    type: "create",
    status: "completed",
    createdAt: new Date(),
  });
  await runCloudBackupJobs(f.store, f.config);
  const row = await f.store.backupSyncJobs.findOne({ backupId: id });
  assert.equal(row.status, "verified");
  assert.equal(
    row.result.bytes,
    (await readFile(path.join(f.config.backup.directory, id + ".akbackup")))
      .length,
  );
  assert.equal(
    [...f.objects.values()][0].Body.includes(Buffer.from("Test Member")),
    false,
  );
  await copyBackupToCloud(f.config, id);
  assert.equal(f.objects.size, 1);
  assert.equal(
    JSON.stringify(ok(await f.staff.admin("/api/staff/backup-cloud"))).includes(
      "test-secret",
    ),
    false,
  );
  assert.equal((await listCloudBackups(f.config)).backups[0].id, id);
  await unlink(path.join(f.config.backup.directory, id + ".akbackup"));
  assert.equal((await fetchCloudBackup(f.config, id)).authenticated, true);
  assert.equal((await openBackup(f.config, id)).id, id);
});
test("corrupted copies fail verification and a different local recovery file is never overwritten", async (t) => {
  const f = await setup(t),
    id = "BK-" + key();
  await createBackup(f.store, f.config, id);
  await queueCloudBackup(f.store, f.config, id);
  f.control.corrupt = true;
  await runCloudBackupJobs(f.store, f.config);
  assert.equal(
    (await f.store.backupSyncJobs.findOne({ backupId: id })).status,
    "failed",
  );
  await assert.rejects(
    fetchCloudBackup(f.config, id),
    (error) => error.code === "CLOUD_INTEGRITY",
  );
  f.control.corrupt = false;
  const file = path.join(f.config.backup.directory, id + ".akbackup");
  await writeFile(file, "existing controlled local file");
  await assert.rejects(
    fetchCloudBackup(f.config, id),
    (error) => error.code === "CLOUD_EXISTS",
  );
  assert.equal(await readFile(file, "utf8"), "existing controlled local file");
});
test("local retention keeps unverified off-site sources and retries remain tied to the original destination", async (t) => {
  const f = await setup(t);
  ok(
    await post(f.staff.admin, "/api/staff/backups/settings", {
      enabled: false,
      everyHours: 24,
      keep: 1,
      currentPassword: password,
    }),
  );
  ok(
    await post(f.staff.admin, "/api/staff/backup-cloud/settings", {
      enabled: true,
      currentPassword: password,
    }),
  );
  const first = ok(await post(f.staff.admin, "/api/staff/backups"), 202).job;
  await runBackupJobs(f.store, f.config);
  const second = ok(await post(f.staff.admin, "/api/staff/backups"), 202).job;
  await runBackupJobs(f.store, f.config);
  assert.ok(
    (
      await readFile(
        path.join(f.config.backup.directory, first.id + ".akbackup"),
      )
    ).length > 0,
  );
  f.control.fail = true;
  await runCloudBackupJobs(f.store, f.config);
  const job = await f.store.backupSyncJobs.findOne({ backupId: first.id });
  assert.equal(job.status, "retrying");
  await f.store.backupSyncJobs.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "uploading",
        attempts: 5,
        leaseUntil: new Date(Date.now() - 1000),
      },
    },
  );
  await runCloudBackupJobs(f.store, f.config);
  assert.equal(
    (await f.store.backupSyncJobs.findOne({ _id: job._id })).status,
    "failed",
  );
  f.config.backupS3.bucket = "another-private-bucket";
  error(
    await post(f.staff.admin, "/api/staff/backup-cloud/" + job._id + "/retry", {
      reason: "Must retain original destination",
    }),
    409,
    "CLOUD_STATE",
  );
  assert.equal(f.objects.size, 0);
  assert.ok(second.id);
});
