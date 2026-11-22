import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import net from "node:net";
import { once } from "node:events";
import { fixture, post, ok, error, key, password } from "./support.js";
import { stockDay } from "../server/ingredient-batches.js";
import {
  runPrintJobs,
  sendPrinterBytes,
  escposBytes,
} from "../server/printing.js";
import {
  scanStaffAlerts,
  runStaffAlertDeliveries,
} from "../server/staff-alerts.js";
const day = (days) => stockDay(new Date(Date.now() + days * 86400000));
async function supply(f, quantity = 1000, price = 20000) {
  const ingredient = ok(
    await post(f.staff.admin, "/api/staff/inventory/ingredients", {
      name: "Supplier Rice",
      unit: "g",
      initialStock: 0,
      reorderLevel: 100,
    }),
    201,
  ).ingredient;
  ok(
    await post(f.staff.admin, "/api/staff/inventory/batches/enable", {
      ingredientId: ingredient.id,
      expectedRevision: 0,
      batch: { code: "EMPTY", noExpiry: true },
      reason: "Start tracked stock",
    }),
    201,
  );
  const supplier = ok(
    await post(f.staff.admin, "/api/staff/suppliers", {
      name: "Return Supplier",
      email: "",
      active: true,
    }),
    201,
  ).supplier;
  let purchase = ok(
    await post(f.staff.admin, "/api/staff/purchases", {
      supplierId: supplier.id,
      lines: [
        {
          ingredientId: ingredient.id,
          quantity,
          unitPriceMinor: price,
          pricePerQuantity: quantity,
        },
      ],
      dueOn: day(-1),
      requestKey: key(),
    }),
    201,
  ).purchase;
  purchase = ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/action",
      {
        action: "order",
        expectedRevision: purchase.revision,
        reason: "Purchase terms checked",
      },
    ),
  ).purchase;
  purchase = ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/receive",
      {
        expectedRevision: purchase.revision,
        reference: "DEL-1",
        reason: "Physical delivery received",
        requestKey: key(),
        items: [
          {
            ingredientId: ingredient.id,
            quantity,
            batch: { code: "DEL-LOT", expiresOn: day(1), noExpiry: false },
          },
        ],
      },
    ),
  ).purchase;
  return {
    ingredient,
    purchase,
    receipt: await f.store.purchaseReceipts.findOne({
      purchaseId: new ObjectId(purchase.id),
    }),
  };
}
async function returnStock(f, s, quantity) {
  let row = ok(
    await post(f.staff.admin, "/api/staff/supplier-returns", {
      receiptId: String(s.receipt._id),
      items: [{ ingredientId: s.ingredient.id, quantity }],
      reason: "Damaged goods returned to supplier",
      requestKey: key(),
    }),
    201,
  ).return;
  row = ok(
    await post(
      f.staff.admin,
      "/api/staff/supplier-returns/" + row.id + "/decision",
      {
        decision: "approve",
        expectedRevision: row.revision,
        reason: "Supplier accepted the return",
      },
    ),
  ).return;
  const input = {
    expectedRevision: row.revision,
    verified: true,
    reference: "RETURN-1",
    reason: "Goods physically handed back",
    requestKey: key(),
  };
  return {
    row: ok(
      await post(
        f.staff.admin,
        "/api/staff/supplier-returns/" + row.id + "/confirm",
        input,
      ),
    ).return,
    input,
  };
}
test("supplier returns credit received goods once and actual cash refunds cannot exceed overpaid credit", async (t) => {
  const f = await fixture(t),
    s = await supply(f);
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + s.purchase.id + "/payments",
      {
        amountMinor: 20000,
        method: "bank",
        reference: "BANK-1",
        reason: "Supplier paid in full",
        verified: true,
        requestKey: key(),
      },
    ),
    201,
  );
  const returned = await returnStock(f, s, 250);
  ok(
    await post(
      f.staff.admin,
      "/api/staff/supplier-returns/" + returned.row.id + "/confirm",
      returned.input,
    ),
  );
  assert.equal(returned.row.creditNote.amountMinor, 5000);
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(s.ingredient.id) }))
      .stock,
    750,
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/purchases/" + s.purchase.id)).purchase
      .balanceMinor,
    -5000,
  );
  error(await f.staff.kitchen("/api/staff/supplier-returns"), 403);
  const input = {
    amountMinor: 5000,
    method: "cash",
    reference: "CASH-BACK-1",
    reason: "Actual supplier cash refund received",
    verified: true,
    requestKey: key(),
  };
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + s.purchase.id + "/supplier-refunds",
      input,
    ),
    201,
  );
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + s.purchase.id + "/supplier-refunds",
      input,
    ),
    201,
  );
  error(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + s.purchase.id + "/supplier-refunds",
      { ...input, requestKey: key() },
    ),
    409,
    "SUPPLIER_CREDIT_LIMIT",
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/cash-drawer")).unassigned[0]
      .deltaMinor,
    5000,
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/purchases/" + s.purchase.id)).purchase
      .balanceMinor,
    0,
  );
});
test("supplier returns reserve receipt quantities and roll back when their original lot is no longer available", async (t) => {
  const f = await fixture(t),
    s = await supply(f, 3, 100);
  let row = ok(
    await post(f.staff.admin, "/api/staff/supplier-returns", {
      receiptId: String(s.receipt._id),
      items: [{ ingredientId: s.ingredient.id, quantity: 3 }],
      reason: "Supplier agreed all units back",
      requestKey: key(),
    }),
    201,
  ).return;
  error(
    await post(f.staff.admin, "/api/staff/supplier-returns", {
      receiptId: String(s.receipt._id),
      items: [{ ingredientId: s.ingredient.id, quantity: 1 }],
      reason: "Duplicate reservation forbidden",
      requestKey: key(),
    }),
    409,
    "RETURN_LIMIT",
  );
  row = ok(
    await post(
      f.staff.admin,
      "/api/staff/supplier-returns/" + row.id + "/decision",
      {
        decision: "approve",
        expectedRevision: row.revision,
        reason: "Return approved",
      },
    ),
  ).return;
  const lot = await f.store.ingredientBatches.findOne({ code: "DEL-LOT" });
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/inventory/ingredients/" + s.ingredient.id + "/stock",
      {
        kind: "waste",
        quantity: 1,
        batchId: String(lot._id),
        reason: "One spoiled unit discarded",
        requestKey: key(),
      },
    ),
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/supplier-returns/" + row.id + "/confirm",
      {
        expectedRevision: row.revision,
        verified: true,
        reference: "NO-STOCK",
        reason: "Must not return consumed quantity",
        requestKey: key(),
      },
    ),
    409,
    "RETURN_STOCK",
  );
  assert.equal(
    (await f.store.purchases.findOne({ _id: new ObjectId(s.purchase.id) }))
      .returnedMinor,
    undefined,
  );
});
test("partial supplier credit rounding sums to the exact original delivered value", async (t) => {
  const f = await fixture(t),
    s = await supply(f, 3, 100),
    values = [];
  for (let i = 0; i < 3; i++)
    values.push((await returnStock(f, s, 1)).row.creditNote.amountMinor);
  assert.deepEqual(values, [33, 34, 33]);
  assert.equal(
    ok(await f.staff.admin("/api/staff/purchases/" + s.purchase.id)).purchase
      .balanceMinor,
    0,
  );
});
test("automatic KOTs preserve order revisions, enforce roles and label separate reprints", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    order = await f.order(guest, await f.open());
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/action", {
      action: "send",
    }),
  );
  let jobs = ok(await f.staff.kitchen("/api/staff/printing")).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "ready");
  assert.ok(jobs[0].lines.some((line) => line.includes("Dhakai")));
  error(await f.staff.waiter("/api/staff/printing"), 403);
  const job = jobs[0];
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/printing/jobs/" + job.id + "/confirm",
      { verified: true, reason: "Physical paper checked" },
    ),
  );
  const copy = ok(
    await post(
      f.staff.kitchen,
      "/api/staff/printing/jobs/" + job.id + "/reprint",
      {
        reason: "Kitchen requested a clearly marked second copy",
        requestKey: key(),
      },
    ),
    201,
  ).job;
  assert.ok(copy.lines[0].includes("REPRINT"));
  assert.equal(copy.copyOf, job.id);
});
test("ESC/POS transport uses bounded bytes and never automatically repeats uncertain output", async (t) => {
  const captured = [];
  const f = await fixture(t, {
    kitchenPrinter: { host: "127.0.0.1", port: 9100, columns: 42, cut: true },
    printerTransport: async (bytes) => captured.push(bytes),
  });
  ok(
    await post(f.staff.admin, "/api/staff/printing/settings", {
      autoEnabled: true,
      currentPassword: password,
    }),
  );
  const order = await f.order(f.browser(), await f.open());
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/action", {
      action: "send",
    }),
  );
  await runPrintJobs(f.store, f.config);
  assert.equal(captured.length, 1);
  assert.deepEqual([...captured[0].subarray(0, 2)], [27, 64]);
  assert.deepEqual([...captured[0].subarray(-4)], [29, 86, 66, 0]);
  assert.equal((await f.store.printJobs.findOne({})).status, "sent");
  await runPrintJobs(f.store, f.config);
  assert.equal(captured.length, 1);
  const original = await f.store.printJobs.findOne({});
  const copy = ok(
    await post(
      f.staff.admin,
      "/api/staff/printing/jobs/" + original._id + "/reprint",
      {
        reason: "Simulate network uncertainty after explicit copy",
        requestKey: key(),
      },
    ),
    201,
  ).job;
  ok(
    await post(f.staff.admin, "/api/staff/printing/jobs/" + copy.id + "/send", {
      reason: "Operator requested this separate copy",
    }),
  );
  let attempts = 0;
  f.config.printerTransport = async () => {
    attempts++;
    const e = new Error("Lost response after write");
    e.mayHavePrinted = true;
    throw e;
  };
  await runPrintJobs(f.store, f.config);
  await runPrintJobs(f.store, f.config);
  assert.equal(attempts, 1);
  assert.equal(
    (await f.store.printJobs.findOne({ _id: copy.id })).status,
    "uncertain",
  );
  assert.throws(
    () => escposBytes(["বাংলা note"]),
    (e) => e.code === "PRINT_UNICODE",
  );
});
test("TCP printer integration sends ESC/POS bytes to a controlled local socket", async (t) => {
  let bytes = Buffer.alloc(0);
  const server = net.createServer((socket) =>
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const ended = once(server, "connection");
  await sendPrinterBytes(
    { kitchenPrinter: { host: "127.0.0.1", port: server.address().port } },
    escposBytes(["Integration ticket"]),
  );
  const [socket] = await ended;
  if (!socket.destroyed) await once(socket, "close");
  assert.ok(bytes.toString().includes("Integration ticket"));
});
test("staff alerts deduplicate, respect roles, resolve after correction and send one opt-in digest", async (t) => {
  const mails = [],
    f = await fixture(t, {
      staffAlertEmails: ["operations@example.test"],
      mailer: async (message) => mails.push(message),
    }),
    s = await supply(f);
  await f.store.ingredients.updateOne(
    { _id: new ObjectId(s.ingredient.id) },
    { $set: { reorderLevel: 2000 } },
  );
  ok(
    await post(f.staff.admin, "/api/staff/operations-alerts/settings", {
      leadDays: 7,
      emailEnabled: true,
      currentPassword: password,
    }),
  );
  await scanStaffAlerts(f.store, f.config);
  await runStaffAlertDeliveries(f.store, f.config);
  await scanStaffAlerts(f.store, f.config);
  await runStaffAlertDeliveries(f.store, f.config);
  assert.equal(mails.length, 1);
  const admin = ok(await f.staff.admin("/api/staff/operations-alerts"));
  assert.equal(admin.alerts.length, 3);
  assert.equal(
    ok(await f.staff.kitchen("/api/staff/operations-alerts")).alerts.some(
      (a) => a.type === "supplier_overdue",
    ),
    false,
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/operations-alerts")).alerts.some(
      (a) => a.type === "low_stock",
    ),
    false,
  );
  const alert = admin.alerts.find((a) => a.type === "low_stock");
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/operations-alerts/" + alert.id + "/acknowledge",
    ),
  );
  assert.equal(
    ok(await f.staff.kitchen("/api/staff/operations-alerts")).alerts.find(
      (a) => a.id === alert.id,
    ).acknowledged,
    true,
  );
  await f.store.ingredients.updateOne(
    { _id: new ObjectId(s.ingredient.id) },
    { $set: { reorderLevel: 0 } },
  );
  await f.store.settings.updateOne(
    { _id: "staff-alert-scan" },
    { $set: { nextAt: new Date(0) } },
  );
  await scanStaffAlerts(f.store, f.config);
  assert.equal(
    (await f.store.staffAlerts.findOne({ _id: alert.id })).active,
    false,
  );
  assert.equal(mails.length, 1);
});

test("approved order changes supersede pending old KOTs and preserve an explicit kitchen revision", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    order = await f.order(guest, await f.open(), 2);
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/action", {
      action: "send",
    }),
  );
  ok(
    await post(
      guest,
      "/api/orders/" + order.id + "/changes",
      {
        type: "edit",
        reason: "Guest reduced one portion",
        expectedRevision: 1,
        note: "Revised kitchen note",
        lines: [{ index: 0, quantity: 1 }],
      },
      { "Idempotency-Key": key() },
    ),
    201,
  );
  const source = await f.store.orders.findOne({ _id: new ObjectId(order.id) });
  ok(
    await post(
      f.staff.admin,
      "/api/staff/orders/" +
        order.id +
        "/changes/" +
        source.changeRequest.id +
        "/decision",
      { decision: "approve", reason: "Kitchen has not started yet" },
    ),
  );
  const jobs = await f.store.printJobs.find({ sourceId: source._id }).toArray();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((j) => j.event === "new").status, "superseded");
  const next = jobs.find((j) => j.event === "changed");
  assert.equal(next.status, "ready");
  assert.ok(next.lines.some((line) => line.includes("Order revision: 3")));
  assert.ok(next.lines.some((line) => line.includes("1 x")));
});

test("recovery retains financial and stock records while disabling printer and staff email side effects", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { createBackup, restoreBackup } = await import("../server/backups.js");
  const directory = await mkdtemp(tmpdir() + "/angar-v26-restore-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, {
      backup: { key: key() + key(), directory: directory + "/backups" },
    }),
    id = "BK-" + key(),
    target = "angar_v26_restore_" + key().slice(0, 12);
  t.after(() =>
    f.store.client
      .db(target)
      .dropDatabase()
      .catch(() => {}),
  );
  await f.store.settings.updateOne(
    { _id: "print-config" },
    { $set: { autoEnabled: true } },
    { upsert: true },
  );
  await f.store.settings.updateOne(
    { _id: "staff-alert-config" },
    { $set: { emailEnabled: true } },
    { upsert: true },
  );
  await f.store.printJobs.insertOne({
    _id: key(),
    status: "queued",
    kind: "kitchen",
  });
  await f.store.staffAlertDeliveries.insertOne({
    _id: key(),
    status: "queued",
  });
  await f.store.expenses.insertOne({
    _id: new ObjectId(),
    requestKey: key(),
    status: "approved",
    amountMinor: 1234,
    paidMinor: 0,
  });
  const supplyData = await supply(f);
  await returnStock(f, supplyData, 250);
  await createBackup(f.store, f.config, id);
  await restoreBackup(
    f.store,
    f.config,
    id,
    target,
    directory + "/restored-media",
  );
  const db = f.store.client.db(target);
  assert.equal(await db.collection("printJobs").countDocuments({}), 0);
  assert.equal(
    await db.collection("staffAlertDeliveries").countDocuments({}),
    0,
  );
  assert.equal(
    (await db.collection("settings").findOne({ _id: "print-config" }))
      .autoEnabled,
    false,
  );
  assert.equal(
    (await db.collection("settings").findOne({ _id: "staff-alert-config" }))
      .emailEnabled,
    false,
  );
  assert.equal((await db.collection("expenses").findOne({})).amountMinor, 1234);
  const stock = await db.collection("ingredients").findOne({});
  assert.equal(stock.stock, 750);
  assert.equal(stock.inventoryValueMinor, 15000);
  assert.equal(
    (await db.collection("supplierReturns").findOne({})).creditNote.amountMinor,
    5000,
  );
});
