import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = new URL("../dist/", import.meta.url);
const files = await readdir(new URL("assets/", root), { recursive: true });
const precache = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  ...files
    .filter((file) => /\.(?:js|css|woff2|svg|png|webp)$/.test(file))
    .map((file) => "/assets/" + file.split(path.sep).join("/")),
].sort();
const hash = createHash("sha256");
for (const file of precache) {
  hash.update(file);
  hash.update(
    await readFile(new URL(file === "/" ? "index.html" : file.slice(1), root)),
  );
}
const build = hash.digest("hex").slice(0, 16),
  source = await readFile(new URL("sw.js", root), "utf8");
await writeFile(
  new URL("sw.js", root),
  source
    .replace("__BUILD_VERSION__", build)
    .replace("/*__PRECACHE__*/['/','/offline.html']", JSON.stringify(precache)),
);
console.log("PWA offline shell prepared:", precache.length, "public assets");
