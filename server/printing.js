import net from "node:net";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash, passwordMatches } from "./security.js";
import { transaction } from "./money.js";
import { billView } from "./bill-view.js";
const clean = (value) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
const reason = z.string().trim().min(3).max(160),
  key = z.string().regex(/^[a-f0-9]{32}$/);
const printerSettings = (config) => {
  const p = config.kitchenPrinter || {};
  return {
    host: p.host || "",
    port: p.port || 9100,
    columns: p.columns || 42,
    cut: Boolean(p.cut),
  };
};
export const printerReady = (config) => {
  const p = printerSettings(config);
  return Boolean(
    p.host &&
      p.host.length <= 253 &&
      /^[A-Za-z0-9.:-]+$/.test(p.host) &&
      Number.isInteger(p.port) &&
      p.port > 0 &&
      p.port <= 65535 &&
      Number.isInteger(p.columns) &&
      p.columns >= 32 &&
      p.columns <= 48,
  );
};
const destinationHash = (config) =>
  hash(JSON.stringify(printerSettings(config)));
const view = (row) => ({
  id: row._id,
  kind: row.kind,
  title: row.title,
  sourceId: String(row.sourceId),
  sourceCode: row.sourceCode,
  event: row.event,
  status: row.status,
  lines: row.lines,
  createdAt: row.createdAt,
  by: row.by,
  attempts: row.attempts || 0,
  message: row.message || "",
  copyOf: row.copyOf || null,
  confirmedBy: row.confirmedBy || null,
  confirmedAt: row.confirmedAt || null,
});
function kitchenLines(order, event) {
  return [
    "ANGAR KITCHEN",
    "KITCHEN TICKET - " + event.toUpperCase(),
    clean(order.code),
    "Order revision: " + (order.revision || 0),
    order.kind ? order.kind.toUpperCase() : "TABLE " + clean(order.tableNumber),
    ...order.items.flatMap((item) => [
      String(item.quantity) + " x " + clean(item.name),
      ...(item.variant ? ["  Size: " + clean(item.variant.name)] : []),
      ...(item.addons || []).map((addon) => "  + " + clean(addon.name)),
    ]),
    ...(order.note ? ["NOTE: " + clean(order.note)] : []),
    "Use the latest revision; check changes.",
  ];
}
export async function queueKitchenTicket(store, order, event, session, by) {
  if (event !== "new")
    await store.printJobs.updateMany(
      {
        sourceId: order._id,
        kind: "kitchen",
        status: {
          $in: ["ready", "queued", "retrying", "failed", "browser_required"],
        },
      },
      {
        $set: {
          status: "superseded",
          message:
            "Superseded by order revision " +
            (order.revision || 0) +
            " (" +
            event +
            "). Use the latest kitchen ticket.",
        },
      },
      { session },
    );
  const id = hash(
      "kot:" + order._id + ":" + (order.revision || 0) + ":" + event,
    ),
    policy = await store.settings.findOne({ _id: "print-config" }, { session });
  const row = {
    _id: id,
    kind: "kitchen",
    title: "Kitchen ticket",
    sourceId: order._id,
    sourceCode: order.code,
    event,
    lines: kitchenLines(order, event),
    status: policy?.autoEnabled ? "queued" : "ready",
    auto: Boolean(policy?.autoEnabled),
    destinationHash: policy?.destinationHash || "",
    attempts: 0,
    nextAt: new Date(),
    createdAt: new Date(),
    by,
  };
  await store.printJobs.updateOne(
    { _id: id },
    { $setOnInsert: row },
    { session, upsert: true },
  );
  return row;
}
export function escposBytes(lines, columns = 42, cut = false) {
  const safe = lines.map(clean);
  if (safe.some((line) => /[^\x20-\x7e]/.test(line)))
    throw new HttpError(
      409,
      "PRINT_UNICODE",
      "This raw printer profile supports English ASCII. Use browser thermal print to preserve Bengali or other Unicode text.",
    );
  const wrapped = safe.flatMap((line) => {
    const result = [];
    let remaining = line;
    while (remaining.length > columns) {
      let end = remaining.lastIndexOf(" ", columns);
      if (end < columns / 2) end = columns;
      result.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trimStart();
    }
    result.push(remaining);
    return result;
  });
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from(wrapped.join("\n") + "\n\n\n", "ascii"),
    ...(cut ? [Buffer.from([0x1d, 0x56, 0x42, 0])] : []),
  ]);
}
export function sendPrinterBytes(config, bytes) {
  if (config.printerTransport) return config.printerTransport(bytes);
  const p = printerSettings(config);
  return new Promise((resolve, reject) => {
    let attempted = false,
      settled = false;
    const socket = net.createConnection({ host: p.host, port: p.port });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) {
        error.mayHavePrinted = attempted;
        reject(error);
      } else resolve();
    };
    socket.setTimeout(8000, () => finish(new Error("Printer timed out")));
    socket.once("error", finish);
    socket.once("connect", () => {
      attempted = true;
      socket.end(bytes, () => finish());
    });
    socket.once("close", () => {
      if (!settled)
        finish(new Error("Printer connection closed before completion"));
    });
  });
}
export async function runPrintJobs(store, config) {
  if (!printerReady(config)) return;
  await store.printJobs.updateMany(
    { status: "sending", leaseUntil: { $lt: new Date() } },
    {
      $set: {
        status: "uncertain",
        message:
          "The server stopped during transmission. Check the physical printer before making another copy.",
      },
    },
  );
  const policy = await store.settings.findOne({ _id: "print-config" });
  const row = await store.printJobs.findOneAndUpdate(
    {
      status: { $in: ["queued", "retrying"] },
      destinationHash: destinationHash(config),
      nextAt: { $lte: new Date() },
      $or: [
        { auto: false },
        { auto: true, ...(policy?.autoEnabled ? {} : { _id: null }) },
      ],
    },
    {
      $set: { status: "sending", leaseUntil: new Date(Date.now() + 60000) },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!row) return;
  try {
    const p = printerSettings(config),
      bytes = escposBytes(row.lines, p.columns, p.cut);
    await sendPrinterBytes(config, bytes);
    await store.printJobs.updateOne(
      { _id: row._id, status: "sending" },
      {
        $set: {
          status: "sent",
          message:
            "Bytes were sent to the configured printer. Confirm the paper output; transport acceptance is not physical print confirmation.",
          sentAt: new Date(),
        },
      },
    );
  } catch (error) {
    const status =
      error.code === "PRINT_UNICODE"
        ? "browser_required"
        : error.mayHavePrinted
          ? "uncertain"
          : row.attempts < 3
            ? "retrying"
            : "failed";
    await store.printJobs.updateOne(
      { _id: row._id, status: "sending" },
      {
        $set: {
          status,
          nextAt: new Date(Date.now() + 30000 * row.attempts),
          message:
            error instanceof HttpError
              ? error.message
              : status === "uncertain"
                ? "Transmission may have reached the printer. Check the paper before requesting a separate copy."
                : "Printer connection failed before transmission. Check its operator-configured address, paper and power.",
        },
      },
    );
  }
}
function receiptLines(bill) {
  const b = billView(bill),
    money = (v) => "BDT " + v.toFixed(2);
  return [
    clean(b.invoice?.businessName || "ANGAR KITCHEN"),
    clean(b.invoice?.address || ""),
    ...(b.invoice?.taxRegistration
      ? ["Tax registration: " + clean(b.invoice.taxRegistration)]
      : []),
    "RECEIPT " + clean(b.receiptNo),
    "Invoice date: " +
      new Date(b.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" }),
    "Status: " + b.status.toUpperCase(),
    b.fulfillmentCode || "TABLE " + clean(b.tableNumber),
    ...b.items.flatMap((item) => [
      String(item.quantity) +
        " x " +
        clean(item.name) +
        " " +
        money(item.subtotal),
      ...(item.variant ? ["  " + clean(item.variant.name)] : []),
      ...(item.addons || []).map((a) => "  + " + clean(a.name)),
    ]),
    "Subtotal: " + money(b.subtotal),
    "Discount: " + money(b.discount || 0),
    "Service: " + money(b.charge),
    "Delivery: " + money(b.deliveryFee),
    b.taxLabel + " " + (b.taxIncluded ? "(included): " : ": ") + money(b.tax),
    "TOTAL: " + money(b.total),
    "Received: " + money(b.paidMinor / 100),
    "Remaining: " + money(b.balanceMinor / 100),
    "Confirmed refunds: " + money(b.refundedMinor / 100),
    "Net collected: " + money(b.netCollectedMinor / 100),
    "Keep the original invoice for details.",
  ];
}
const permitted = (req, row) =>
  row.kind === "kitchen"
    ? ["admin", "kitchen"].includes(req.staff.role)
    : ["admin", "cashier"].includes(req.staff.role);
export function registerPrinting(
  api,
  store,
  config,
  requireAdmin,
  billingRoles,
  requireId,
) {
  api.get("/printing", async (req, res) => {
    if (!["admin", "kitchen", "cashier"].includes(req.staff.role))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Printing belongs to the kitchen or counter.",
      );
    const policy = await store.settings.findOne({ _id: "print-config" });
    const rows = await store.printJobs
      .find(
        req.staff.role === "admin"
          ? {}
          : { kind: req.staff.role === "kitchen" ? "kitchen" : "receipt" },
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    res.json({
      jobs: rows.map(view),
      configured: printerReady(config),
      autoEnabled: Boolean(policy?.autoEnabled),
      profile:
        "English ASCII ESC/POS over configured TCP; browser print supports Unicode",
      columns: printerSettings(config).columns,
    });
  });
  api.post("/printing/settings", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          autoEnabled: z.boolean(),
          currentPassword: z.string().min(1).max(128),
        }),
        req.body,
      ),
      user = await store.staff.findOne({ _id: req.staff._id, active: true });
    if (!(await passwordMatches(input.currentPassword, user.passwordHash)))
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter the administrator password.",
      );
    if (input.autoEnabled && !printerReady(config))
      throw new HttpError(
        503,
        "PRINTER_SETUP",
        "Configure the server's kitchen printer first.",
      );
    await store.settings.updateOne(
      { _id: "print-config" },
      {
        $set: {
          autoEnabled: input.autoEnabled,
          destinationHash: printerReady(config) ? destinationHash(config) : "",
        },
      },
      { upsert: true },
    );
    await store.audit.insertOne({
      type: "printer.policy_updated",
      by: req.staff.username,
      reason: input.autoEnabled
        ? "Automatic kitchen printing enabled"
        : "Automatic kitchen printing disabled",
      at: new Date(),
    });
    res.json({ saved: true });
  });
  api.post("/printing/receipts/:id", billingRoles, async (req, res) => {
    const input = body(z.strictObject({ requestKey: key }), req.body);
    const row = await transaction(store, async (session) => {
      await store.settings.updateOne(
        { _id: "print-request-lock" },
        { $inc: { revision: 1 } },
        { session },
      );
      const bill = await store.bills.findOne(
        { _id: requireId(req.params.id) },
        { session },
      );
      if (!bill || bill.status === "void")
        throw new HttpError(404, "NOT_FOUND", "Invoice not found.");
      const id = hash("receipt:" + input.requestKey),
        old = await store.printJobs.findOne({ _id: id }, { session });
      if (old) {
        if (!old.sourceId.equals(bill._id))
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another invoice.",
          );
        return old;
      }
      const row = {
        _id: id,
        kind: "receipt",
        title: "Thermal receipt",
        sourceId: bill._id,
        sourceCode: bill.receiptNo,
        event: "receipt",
        lines: receiptLines(bill),
        status: "ready",
        auto: false,
        createdAt: new Date(),
        by: req.staff.username,
      };
      await store.printJobs.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "printer.receipt_requested",
          printJobId: id,
          billId: bill._id,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ job: view(row) });
  });
  api.get("/printing/jobs/:id", async (req, res) => {
    const row = await store.printJobs.findOne({ _id: req.params.id });
    if (!row || !permitted(req, row))
      throw new HttpError(404, "NOT_FOUND", "Print job not found.");
    res.json({ job: view(row) });
  });
  api.post("/printing/jobs/:id/confirm", async (req, res) => {
    const input = body(
      z.strictObject({ verified: z.literal(true), reason }),
      req.body,
    );
    await transaction(store, async (session) => {
      const row = await store.printJobs.findOne(
        { _id: req.params.id },
        { session },
      );
      if (!row || !permitted(req, row))
        throw new HttpError(404, "NOT_FOUND", "Print job not found.");
      if (["sending", "superseded"].includes(row.status))
        throw new HttpError(
          409,
          "PRINT_BUSY",
          "Wait for the current printer transmission.",
        );
      if (row.status === "printed") return;
      await store.printJobs.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "printed",
            confirmedBy: req.staff.username,
            confirmedAt: new Date(),
            message: input.reason,
          },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "printer.output_confirmed",
          printJobId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ confirmed: true });
  });
  api.post("/printing/jobs/:id/send", async (req, res) => {
    const input = body(z.strictObject({ reason }), req.body);
    if (!printerReady(config))
      throw new HttpError(
        503,
        "PRINTER_SETUP",
        "Configure the server printer or use browser thermal print.",
      );
    await transaction(store, async (session) => {
      const row = await store.printJobs.findOne(
        { _id: req.params.id },
        { session },
      );
      if (!row || !permitted(req, row))
        throw new HttpError(404, "NOT_FOUND", "Print job not found.");
      if (!["ready", "failed", "browser_required"].includes(row.status))
        throw new HttpError(
          409,
          "PRINT_STATE",
          "Check uncertain or sent output before requesting a separate reprint.",
        );
      escposBytes(
        row.lines,
        printerSettings(config).columns,
        printerSettings(config).cut,
      );
      await store.printJobs.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "queued",
            destinationHash: destinationHash(config),
            auto: false,
            nextAt: new Date(),
            attempts: 0,
          },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "printer.send_requested",
          printJobId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ queued: true });
  });
  api.post("/printing/jobs/:id/reprint", async (req, res) => {
    const input = body(z.strictObject({ reason, requestKey: key }), req.body);
    const result = await transaction(store, async (session) => {
      await store.settings.updateOne(
        { _id: "print-request-lock" },
        { $inc: { revision: 1 } },
        { session },
      );
      const source = await store.printJobs.findOne(
        { _id: req.params.id },
        { session },
      );
      if (!source || !permitted(req, source))
        throw new HttpError(404, "NOT_FOUND", "Print job not found.");
      const id = hash("reprint:" + input.requestKey),
        old = await store.printJobs.findOne({ _id: id }, { session });
      if (old) {
        if (old.copyOf !== source._id || old.copyReason !== input.reason)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another copy.",
          );
        return old;
      }
      const row = {
        _id: id,
        kind: source.kind,
        title: source.title,
        sourceId: source.sourceId,
        sourceCode: source.sourceCode,
        event: "reprint",
        lines: ["*** REPRINT / COPY ***", ...source.lines],
        copyOf: source._id,
        copyReason: input.reason,
        status: "ready",
        auto: false,
        createdAt: new Date(),
        by: req.staff.username,
      };
      await store.printJobs.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "printer.reprint_requested",
          printJobId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ job: view(result) });
  });
}
