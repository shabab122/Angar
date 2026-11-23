import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fixture, post, ok, password, key, error } from "./support.js";
import { getBranchRuntime, branchDatabase } from "../server/branches.js";
import { connectDatabase } from "../server/db.js";
import { createBackup, openBackup, restoreBackup } from "../server/backups.js";
const run = promisify(execFile);
test("branch backups have separate scope and restored branches require a single reviewed binding to restored identities", async (t) => {
  const directory = await mkdtemp(tmpdir() + "/angar-branch-recovery-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory + "/photos");
  const f = await fixture(t, {
    uploadDir: directory + "/photos",
    backup: {
      key: randomBytes(32).toString("hex"),
      directory: directory + "/backups",
    },
  });
  ok(
    await post(f.staff.admin, "/api/branches", {
      id: "uttara",
      name: "Uttara",
      address: "Uttara",
      tables: 2,
      copyMenu: true,
      currentPassword: password,
      requestKey: key(),
    }),
    201,
  );
  const child = await getBranchRuntime(f.store, f.config).get("uttara");
  const mainRestore = "ak_main_restore_" + key(),
    childRestore = "ak_child_restore_" + key();
  let recovered;
  try {
    await child.store.ingredients.insertOne({
      _id: "branch-stock",
      name: "Branch stock",
      stock: 321,
    });
    await child.store.courierJobs.insertOne({
      _id: "driver-state",
      source: "staff",
      status: "in_transit",
      driverTokenHash: "f".repeat(64),
      deliveryCode: "123456",
      deliveryCodeHash: "a".repeat(64),
      location: { lat: 23, lng: 90 },
      locationAt: new Date(),
    });
    const mainId = "BK-" + key(),
      childId = "BK-" + key();
    await createBackup(f.store, f.config, mainId);
    await createBackup(child.store, child.config, childId);
    const mainArchive = await openBackup(f.config, mainId),
      childArchive = await openBackup(child.config, childId);
    assert.ok(mainArchive.collections.some((row) => row.name === "staff"));
    assert.ok(!childArchive.collections.some((row) => row.name === "staff"));
    assert.ok(!childArchive.collections.some((row) => row.name === "branches"));
    assert.ok(child.config.backupS3.prefix.endsWith("branches/uttara/"));
    await restoreBackup(
      f.store,
      f.config,
      mainId,
      mainRestore,
      directory + "/restored-main",
    );
    await restoreBackup(
      child.store,
      child.config,
      childId,
      childRestore,
      directory + "/restored-branch",
    );
    assert.equal(
      (await f.store.branches.findOne({ _id: "uttara" })).active,
      true,
    );
    assert.equal(
      (
        await f.store.client
          .db(mainRestore)
          .collection("branches")
          .findOne({ _id: "uttara" })
      ).state,
      "recovery_required",
    );
    const restoredJob = await f.store.client
      .db(childRestore)
      .collection("courierJobs")
      .findOne({ _id: "driver-state" });
    assert.equal(restoredJob.driverTokenHash, undefined);
    assert.equal(restoredJob.location, undefined);
    assert.equal(restoredJob.deliveryCode, undefined);
    const config = { ...f.config, mongoDatabase: mainRestore };
    recovered = await connectDatabase(config);
    await assert.rejects(
      getBranchRuntime(recovered, config).get("uttara"),
      (e) => e.code === "BRANCH_UNAVAILABLE",
    );
    const args = [
      "--env-file-if-exists=.env",
      "scripts/branch-recover.js",
      "--branch",
      "uttara",
      "--database",
      childRestore,
      "--confirm-branch",
      "uttara",
      "--reason",
      "Verified isolated restoration for this test",
    ];
    const env = { ...process.env, MONGODB_DB: mainRestore };
    await run(process.execPath, args, { cwd: process.cwd(), env });
    const active = await getBranchRuntime(recovered, config).get("uttara");
    assert.equal(active.store.db.databaseName, childRestore);
    assert.equal(
      (await active.store.ingredients.findOne({ _id: "branch-stock" })).stock,
      321,
    );
    assert.equal(await active.store.staff.countDocuments({}), 4);
    assert.equal(
      (
        await f.store.client
          .db(childRestore)
          .collection("_restoreGuard")
          .findOne({ verified: true })
      ).bindingIdentity,
      mainRestore,
    );
    await assert.rejects(
      run(process.execPath, args, { cwd: process.cwd(), env }),
    );
  } finally {
    await f.store.client.db(mainRestore).dropDatabase();
    await f.store.client.db(childRestore).dropDatabase();
    await recovered?.client.close();
    await child.store.db.dropDatabase();
  }
});
test("unrelated occupied branch databases are not overwritten and interrupted provisioning can resume with its original request", async (t) => {
  const f = await fixture(t),
    request = {
      id: "uttara",
      name: "Uttara",
      address: "Uttara",
      tables: 2,
      copyMenu: true,
      currentPassword: password,
      requestKey: key(),
    },
    occupied = f.store.client.db(
      branchDatabase(f.config.mongoDatabase, "banani"),
    );
  await occupied
    .collection("unrelated")
    .insertOne({ _id: "keep", value: "original" });
  let child;
  try {
    error(
      await post(f.staff.admin, "/api/branches", {
        ...request,
        id: "banani",
        requestKey: key(),
      }),
      409,
      "BRANCH_DATABASE",
    );
    assert.equal(
      (await occupied.collection("unrelated").findOne({ _id: "keep" })).value,
      "original",
    );
    ok(await post(f.staff.admin, "/api/branches", request), 201);
    child = await getBranchRuntime(f.store, f.config).get("uttara");
    await f.store.branches.updateOne(
      { _id: "uttara" },
      { $set: { state: "provisioning", active: false } },
    );
    const management = ok(
      await f.staff.admin("/api/branches/manage"),
    ).branches.find((row) => row.id === "uttara");
    assert.equal(management.provisioning.requestKey, request.requestKey);
    ok(await post(f.staff.admin, "/api/branches", request), 201);
    assert.equal(await child.store.tables.countDocuments({}), 2);
    assert.match(
      (await child.store.settings.findOne({ _id: "restaurant" })).invoice
        .prefix,
      /^BR\d{4}$/,
    );
    ok(
      await post(f.staff.admin, "/api/branches/select", { branchId: "uttara" }),
    );
    error(
      await f.staff.admin("/api/staff/audit/export.csv?branch=main"),
      409,
      "BRANCH_CHANGED",
    );
    const exportResponse = await f.staff.admin(
      "/api/staff/audit/export.csv?branch=uttara",
    );
    assert.equal(exportResponse.status, 200);
    await f.store.branches.updateOne(
      { _id: "uttara" },
      { $set: { active: false, state: "recovery_required" } },
    );
    error(await f.staff.admin("/api/menu"), 404, "BRANCH_UNAVAILABLE");
    assert.equal((await f.staff.admin("/menu")).status, 200);
    assert.equal(ok(await f.staff.admin("/api/branches")).current, "main");
    assert.equal(
      ok(await f.staff.admin("/api/menu")).dishes.find(
        (d) => d._id === "mutton-kacchi",
      ).price,
      420,
    );
  } finally {
    await child?.store.db.dropDatabase();
    await occupied.dropDatabase();
  }
});
