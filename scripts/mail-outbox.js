import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../server/config.js";
const config = loadConfig();
if (config.production || config.mail.mode !== "outbox")
  throw new Error("This command is only for local MAIL_MODE=outbox testing.");
let files = [];
try {
  files = (await readdir(config.mail.outboxDir))
    .filter((file) => /^\d+-[a-f0-9]+\.json$/.test(file))
    .sort()
    .slice(-10);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!files.length)
  console.log(
    "No local test emails yet. Request a verification or password-reset email in your account.",
  );
for (const file of files) {
  const message = JSON.parse(
    await readFile(path.join(config.mail.outboxDir, file), "utf8"),
  );
  console.log(
    "\nTo: " + message.to + "\n" + message.subject + "\n" + message.text,
  );
}
