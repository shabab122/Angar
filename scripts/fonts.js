import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const destination = "public/assets/fonts";
const fonts = [
  ["fraunces", "fraunces-latin-wght-normal.woff2"],
  ["manrope", "manrope-latin-wght-normal.woff2"],
  ["noto-sans-bengali", "noto-sans-bengali-bengali-wght-normal.woff2"],
];
await mkdir(destination, { recursive: true });
await Promise.all(
  fonts.flatMap(([family, file]) => {
    const source = path.join("node_modules", "@fontsource-variable", family);
    return [
      copyFile(path.join(source, "files", file), path.join(destination, file)),
      copyFile(
        path.join(source, "LICENSE"),
        path.join(destination, family + "-LICENSE.txt"),
      ),
    ];
  }),
);
