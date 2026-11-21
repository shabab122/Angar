import { loadConfig } from "../server/config.js";
import { listCloudBackups, fetchCloudBackup } from "../server/backup-cloud.js";
const config = loadConfig(),
  args = process.argv.slice(2),
  action = args.shift();
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
};
if (action === "list")
  console.log(
    JSON.stringify(await listCloudBackups(config, value("--cursor")), null, 2),
  );
else if (action === "fetch")
  console.log(
    JSON.stringify(await fetchCloudBackup(config, value("--id")), null, 2),
  );
else
  throw new Error(
    "Use backup:remote-list or backup:fetch -- --id YOUR_BACKUP_ID. Existing local files are never overwritten.",
  );
