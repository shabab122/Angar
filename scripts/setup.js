import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as webpush from "web-push";

const location = new URL("../.env", import.meta.url);
const template = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
let existing = "";
try {
  existing = await readFile(location, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const defaults = template
  .split("\n")
  .filter((line) => line && !line.startsWith("#"));
let content = existing || template;
for (const line of defaults) {
  const [key] = line.split("=");
  const pattern = new RegExp("^" + key + "=(.*)$", "m");
  const match = content.match(pattern);
  const secret =
    key === "COOKIE_SECRET" ||
    key === "BACKUP_ENCRYPTION_KEY" ||
    /^STAFF_.*_PASSWORD$/.test(key);
  if (!match) content += (content.endsWith("\n") ? "" : "\n") + line + "\n";
  if (secret && (!match || !match[1].trim())) {
    content = content.replace(
      pattern,
      key +
        "=" +
        randomBytes(
          key === "COOKIE_SECRET" || key === "BACKUP_ENCRYPTION_KEY" ? 32 : 18,
        ).toString(key === "BACKUP_ENCRYPTION_KEY" ? "hex" : "base64url"),
    );
  }
}
const publicKey = content.match(/^PUSH_VAPID_PUBLIC_KEY=(.*)$/m)?.[1]?.trim();
const privateKey = content.match(/^PUSH_VAPID_PRIVATE_KEY=(.*)$/m)?.[1]?.trim();
if (!publicKey && !privateKey) {
  const pair = webpush.generateVAPIDKeys();
  content = content
    .replace(
      /^PUSH_VAPID_PUBLIC_KEY=.*$/m,
      "PUSH_VAPID_PUBLIC_KEY=" + pair.publicKey,
    )
    .replace(
      /^PUSH_VAPID_PRIVATE_KEY=.*$/m,
      "PUSH_VAPID_PRIVATE_KEY=" + pair.privateKey,
    );
} else if (!publicKey || !privateKey)
  throw new Error(
    "Provide a complete VAPID key pair; setup will not silently replace one configured key.",
  );
await writeFile(location, content, { mode: 0o600 });
console.log(
  "Prepared .env. Existing values were retained. Read generated staff passwords in this local file.",
);
