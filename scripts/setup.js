import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

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
  const secret = key === "COOKIE_SECRET" || /^STAFF_.*_PASSWORD$/.test(key);
  if (!match) content += (content.endsWith("\n") ? "" : "\n") + line + "\n";
  if (secret && (!match || !match[1].trim())) {
    content = content.replace(
      pattern,
      key +
        "=" +
        randomBytes(key === "COOKIE_SECRET" ? 32 : 18).toString("base64url"),
    );
  }
}
await writeFile(location, content, { mode: 0o600 });
console.log(
  "Prepared .env. Existing values were retained. Read generated staff passwords in this local file.",
);
