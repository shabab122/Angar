import { mkdir, writeFile } from "node:fs/promises";
import QRCode from "qrcode";
import { loadConfig } from "../server/config.js";
import { connectDatabase } from "../server/db.js";

const config = loadConfig();
const origin = new URL(process.env.PUBLIC_ORIGIN || config.origin);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.href !== origin.origin + "/"
) {
  throw new Error(
    "PUBLIC_ORIGIN must be a plain HTTP(S) origin without a path.",
  );
}
const args = process.argv.slice(2);
const print = args.includes("--print");
const tableNumber = args.find((arg) => arg !== "--print");
if (tableNumber && !/^T\d{2}$/.test(tableNumber))
  throw new Error("Use a table number such as T01.");

const store = await connectDatabase(config);
try {
  const tables = await store.tables
    .find(tableNumber ? { number: tableNumber } : {})
    .sort({ number: 1 })
    .toArray();
  if (!tables.length)
    throw new Error("No matching table. Run the seed command first.");
  if (print) await mkdir("qr-cards", { recursive: true });
  for (const table of tables) {
    const link = new URL("/t/" + table.qrToken, origin).href;
    console.log(
      `${table.number}  ${table.activeVisitId ? "open  " : "closed"}  ${link}`,
    );
    if (!print) continue;
    const image = await QRCode.toDataURL(link, {
      errorCorrectionLevel: "M",
      margin: 4,
      width: 512,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 414" width="100mm" height="129mm">
  <rect x="1" y="1" width="318" height="412" rx="20" fill="#fffaf0" stroke="#943e29" stroke-width="2"/>
  <text x="160" y="48" text-anchor="middle" font-family="Georgia,serif" font-size="25" fill="#261d17">ANGAR KITCHEN</text>
  <text x="160" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="#943e29">TABLE ${table.number.slice(1)}</text>
  <image x="43" y="95" width="234" height="234" href="${image}"/>
  <text x="160" y="357" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#261d17">Scan to view the menu and order</text>
  <text x="160" y="381" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#674f43">Need help? Ask your server.</text>
</svg>`;
    await writeFile("qr-cards/" + table.number + ".svg", svg, "utf8");
  }
  if (print) console.log("Printable table cards saved in qr-cards/.");
} finally {
  await store.client.close();
}
