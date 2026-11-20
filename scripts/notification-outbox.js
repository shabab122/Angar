import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../server/config.js";
const config = loadConfig();
if (config.production)
  throw new Error("Local notification outboxes are disabled in production.");
for (const [mode, directory] of [
  [config.mail.mode, config.mail.outboxDir],
  [config.sms.mode, config.sms.outboxDir],
]) {
  if (mode !== "outbox") continue;
  const files = (
    await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  )
    .filter((file) => /^\d+-[a-f0-9]+\.json$/.test(file))
    .sort()
    .slice(-10);
  for (const file of files) {
    const message = JSON.parse(
      await readFile(path.join(directory, file), "utf8"),
    );
    console.log(
      "\n" +
        (message.channel || "email") +
        " to " +
        message.to +
        "\n" +
        (message.subject || "") +
        "\n" +
        message.text,
    );
  }
}
