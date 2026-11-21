import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { reportWindow } from "./reports.js";

export function csvDocument(rows) {
  const cell = (value) => {
    const raw = String(value ?? "");
    const safe =
      typeof value === "string" && /^[\s]*[=+@\-\t\r]/.test(raw)
        ? "'" + raw
        : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
const refs = [
  "billId",
  "orderId",
  "refundId",
  "staffId",
  "ingredientId",
  "dishId",
  "fulfillmentId",
  "sourceId",
  "purchaseId",
  "supplierId",
  "batchId",
  "shiftId",
  "backupId",
];
const safeText = (value, max = 200) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max)
    : "";
export function auditView(row) {
  return {
    id: String(row._id),
    at: row.at,
    type: safeText(row.type, 100),
    by: safeText(row.by, 40) || "system",
    reason: safeText(row.reason),
    amountMinor: Number.isSafeInteger(row.amountMinor) ? row.amountMinor : null,
    references: Object.fromEntries(
      refs
        .filter((key) => row[key] !== undefined)
        .map((key) => [key, safeText(String(row[key]), 100)]),
    ),
  };
}
function query(input) {
  const parsed = body(
    z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      type: z.string().trim().max(100).default(""),
      actor: z.string().trim().max(40).default(""),
      q: z.string().trim().max(80).default(""),
      cursor: z.string().max(200).default(""),
    }),
    input,
  );
  const window = reportWindow({
    ...(parsed.start ? { start: parsed.start } : {}),
    ...(parsed.end ? { end: parsed.end } : {}),
  });
  const filter = { at: { $gte: window.startAt, $lt: window.endAt } };
  if (parsed.type) filter.type = parsed.type;
  if (parsed.actor) filter.by = parsed.actor;
  if (parsed.q) {
    const match = {
      $regex: parsed.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
    filter.$or = ["type", "by", "reason"].map((key) => ({ [key]: match }));
  }
  if (parsed.cursor) {
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(parsed.cursor, "base64url").toString());
      if (
        !/^[a-f0-9]{24}$/i.test(cursor.id) ||
        !Number.isFinite(new Date(cursor.at).getTime())
      )
        throw Error();
    } catch {
      throw new HttpError(
        400,
        "AUDIT_CURSOR",
        "Refresh the activity list before opening another page.",
      );
    }
    filter.$and = [
      {
        $or: [
          { at: { $lt: new Date(cursor.at) } },
          { at: new Date(cursor.at), _id: { $lt: new ObjectId(cursor.id) } },
        ],
      },
    ];
  }
  return { parsed, filter, window };
}
export function registerAuditDashboard(api, store, requireAdmin) {
  api.get("/audit", requireAdmin, async (req, res) => {
    const { filter, window } = query(req.query),
      rows = await store.audit
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .limit(51)
        .toArray();
    const more = rows.length > 50;
    rows.length = Math.min(rows.length, 50);
    const last = rows.at(-1),
      types = await store.audit.distinct("type");
    res.json({
      records: rows.map(auditView),
      types: types
        .filter((value) => typeof value === "string")
        .sort()
        .slice(0, 250),
      timezone: "Asia/Dhaka",
      start: window.start,
      end: window.end,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({ id: String(last._id), at: last.at }),
          ).toString("base64url")
        : null,
    });
  });
  api.get("/audit/export.csv", requireAdmin, async (req, res) => {
    const { filter, window } = query({ ...req.query, cursor: "" }),
      rows = await store.audit
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .limit(10001)
        .toArray();
    if (rows.length > 10000)
      throw new HttpError(
        409,
        "EXPORT_LIMIT",
        "Narrow the filters to export at most 10,000 activity records.",
      );
    await store.audit.insertOne({
      type: "audit.exported",
      by: req.staff.username,
      reason: "Activity export " + window.start + " to " + window.end,
      records: rows.length,
      at: new Date(),
    });
    res
      .type("text/csv")
      .attachment("angar-activity-" + window.start + ".csv")
      .send(
        csvDocument([
          [
            "Time (UTC)",
            "Action",
            "Actor",
            "Reason",
            "Amount BDT",
            "References",
          ],
          ...rows.map(auditView).map((row) => [
            row.at?.toISOString(),
            row.type,
            row.by,
            row.reason,
            row.amountMinor === null ? "" : row.amountMinor / 100,
            Object.entries(row.references)
              .map(([k, v]) => k + ": " + v)
              .join("; "),
          ]),
        ]),
      );
  });
}
