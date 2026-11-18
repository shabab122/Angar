import { z } from "zod";
import { body, HttpError } from "./http.js";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value + "T00:00:00Z");
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Use a real calendar date in YYYY-MM-DD format.");

export function reportWindow(query, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const input = body(
    z.object({
      start: date.default(today),
      end: date.default(today),
      group: z.enum(["day", "month"]).default("day"),
      section: z
        .enum(["summary", "periods", "items", "payments"])
        .default("periods"),
    }),
    query,
  );
  const start = new Date(input.start + "T00:00:00+06:00");
  const end = new Date(
    new Date(input.end + "T00:00:00+06:00").getTime() + 86400000,
  );
  if (end <= start || end - start > 366 * 86400000)
    throw new HttpError(
      400,
      "INVALID_RANGE",
      "Choose an inclusive range of 1 to 366 days.",
    );
  return { ...input, startAt: start, endAt: end, timezone: "Asia/Dhaka" };
}

export async function salesReport(store, window) {
  // Only settled table bills contribute to sales. Quotes and unpaid orders do not.
  const [data] = await store.bills
    .aggregate([
      {
        $match: {
          status: "paid",
          paidAt: { $gte: window.startAt, $lt: window.endAt },
        },
      },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                revenueMinor: { $sum: "$totalMinor" },
                subtotalMinor: { $sum: "$subtotalMinor" },
                serviceChargeMinor: { $sum: "$chargeMinor" },
                bills: { $sum: 1 },
              },
            },
          ],
          periods: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    date: "$paidAt",
                    format: window.group === "month" ? "%Y-%m" : "%Y-%m-%d",
                    timezone: "Asia/Dhaka",
                  },
                },
                revenueMinor: { $sum: "$totalMinor" },
                bills: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          payments: [
            {
              $group: {
                _id: { $ifNull: ["$payment.method", "unknown"] },
                revenueMinor: { $sum: "$totalMinor" },
                bills: { $sum: 1 },
              },
            },
            { $sort: { revenueMinor: -1, _id: 1 } },
          ],
          popular: [
            { $unwind: "$items" },
            {
              $group: {
                _id: "$items.name",
                quantity: { $sum: "$items.quantity" },
                foodMinor: {
                  $sum: {
                    $round: [{ $multiply: ["$items.subtotal", 100] }, 0],
                  },
                },
              },
            },
            { $sort: { quantity: -1, foodMinor: -1, _id: 1 } },
          ],
        },
      },
    ])
    .toArray();
  const summary = data?.summary[0] || {
    revenueMinor: 0,
    subtotalMinor: 0,
    serviceChargeMinor: 0,
    bills: 0,
  };
  delete summary._id;
  summary.averageBillMinor = summary.bills
    ? Math.round(summary.revenueMinor / summary.bills)
    : 0;
  const periods = new Map(
    (data?.periods || []).map((row) => [
      row._id,
      { period: row._id, revenueMinor: row.revenueMinor, bills: row.bills },
    ]),
  );
  const series = [];
  const emitted = new Set();
  for (
    let day = new Date(window.startAt);
    day < window.endAt;
    day = new Date(day.getTime() + 86400000)
  ) {
    const local = new Date(day.getTime() + 6 * 3600000)
      .toISOString()
      .slice(0, 10);
    const label = window.group === "month" ? local.slice(0, 7) : local;
    if (!emitted.has(label))
      series.push(
        periods.get(label) || { period: label, revenueMinor: 0, bills: 0 },
      );
    emitted.add(label);
  }
  return {
    window: {
      start: window.start,
      end: window.end,
      group: window.group,
      timezone: window.timezone,
    },
    summary,
    series,
    payments: (data?.payments || []).map((row) => ({
      method: row._id,
      revenueMinor: row.revenueMinor,
      bills: row.bills,
    })),
    popular: (data?.popular || []).map((row) => ({
      name: row._id,
      quantity: row.quantity,
      foodMinor: row.foodMinor,
    })),
  };
}

function csvCell(value) {
  const text =
    typeof value === "number"
      ? String(value)
      : String(value ?? "").replace(
          /^[\s]*[=+\-@\t\r]/,
          (prefix) => "'" + prefix,
        );
  return '"' + text.replaceAll('"', '""') + '"';
}
export function reportCsv(report, section) {
  const amount = (minor) => (minor / 100).toFixed(2);
  const tables = {
    summary: [
      [
        "Start (Asia/Dhaka)",
        "End inclusive",
        "Paid bills",
        "Food sales BDT",
        "Service charges BDT",
        "Collected BDT",
        "Average bill BDT",
      ],
      [
        report.window.start,
        report.window.end,
        report.summary.bills,
        amount(report.summary.subtotalMinor),
        amount(report.summary.serviceChargeMinor),
        amount(report.summary.revenueMinor),
        amount(report.summary.averageBillMinor),
      ],
    ],
    periods: [
      ["Period (Asia/Dhaka)", "Paid bills", "Collected BDT"],
      ...report.series.map((row) => [
        row.period,
        row.bills,
        amount(row.revenueMinor),
      ]),
    ],
    items: [
      ["Dish", "Quantity sold", "Food sales BDT (before service charge)"],
      ...report.popular.map((row) => [
        row.name,
        row.quantity,
        amount(row.foodMinor),
      ]),
    ],
    payments: [
      ["Payment method", "Paid bills", "Collected BDT"],
      ...report.payments.map((row) => [
        row.method,
        row.bills,
        amount(row.revenueMinor),
      ]),
    ],
  };
  return (
    "\uFEFF" +
    tables[section].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

export function registerReports(api, store, billingRoles) {
  for (const csv of [false, true])
    api.get(
      "/reports/sales" + (csv ? ".csv" : ""),
      billingRoles,
      async (req, res) => {
        const window = reportWindow(req.query);
        const report = await salesReport(store, window);
        if (!csv) return res.json(report);
        res
          .set(
            "Content-Disposition",
            `attachment; filename="angar-sales-${window.start}-${window.end}-${window.section}.csv"`,
          )
          .type("text/csv; charset=utf-8")
          .send(reportCsv(report, window.section));
      },
    );
}
