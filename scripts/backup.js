import { getBranchRuntime, branchSlug } from "../server/branches.js";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../server/config.js";
import { queueCloudBackup } from "../server/backup-cloud.js";
import { connectDatabase } from "../server/db.js";
import {
  createBackup,
  verifyBackup,
  restoreBackup,
} from "../server/backups.js";
let config = loadConfig();
const args = process.argv.slice(2),
  action = args.shift();
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const root = await connectDatabase(config);
const branchId = value("--branch") || "main";
if (!branchSlug.safeParse(branchId).success)
  throw new Error("Use --branch branch-code.");
const context = await getBranchRuntime(root, config).get(branchId);
const store = context.store;
config = context.config;
try {
  if (action === "create") {
    const id = "BK-" + randomBytes(16).toString("hex");
    const summary = await createBackup(store, config, id),
      restored = await verifyBackup(store, config, id);
    if (
      (await store.settings.findOne({ _id: "backup-config" }))?.offsiteEnabled
    )
      await queueCloudBackup(store, config, id, "cli");
    console.log(
      JSON.stringify(
        { backupId: id, ...summary, verified: restored.verified },
        null,
        2,
      ),
    );
  } else if (action === "verify")
    console.log(
      JSON.stringify(await verifyBackup(store, config, value("--id")), null, 2),
    );
  else if (action === "restore") {
    const target = value("--target-db"),
      id = value("--id");
    if (!target || value("--confirm-new-database") !== target)
      throw new Error(
        "Pass --id BACKUP_ID --target-db NEW_NAME --confirm-new-database NEW_NAME. Restore only creates a separate database and never overwrites an existing one.",
      );
    await mkdir(config.backup.directory, { recursive: true, mode: 0o700 });
    const directory =
      value("--media-dir") ||
      path.join(config.backup.directory, "restored-" + target);
    const { owner, ...result } = await restoreBackup(
      store,
      config,
      id,
      target,
      directory,
    );
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Verify the isolated result before pointing an application at its database and media directory. Existing live data was not replaced.",
    );
  } else
    throw new Error(
      "Use backup:create, backup:verify -- --id BACKUP_ID, or backup:restore with a fresh target database.",
    );
} finally {
  await root.client.close();
}
