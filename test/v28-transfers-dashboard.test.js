import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key, password } from "./support.js";
import {
  branch,
  ingredient,
  createTransfer,
  action,
  receive,
} from "./v28-support.js";
import { stockDay } from "../server/ingredient-batches.js";
test("transfers preserve exact weighted cost across partial receipts and do not create sales or expenses", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    a = await ingredient(f.store, { stock: 100, value: 1001 }),
    b = await ingredient(child.store),
    receiver = f.browser();
  ok(await post(receiver, "/api/branches/select", { branchId: "uttara" }));
  ok(await post(receiver, "/api/staff/login", { username: "admin", password }));
  let row = await createTransfer(f.staff.kitchen, "uttara", a, b);
  error(
    await post(
      f.staff.kitchen,
      "/api/staff/stock-transfers/" + row.id + "/action",
      {
        action: "approve",
        expectedRevision: 0,
        reason: "Kitchen tries approval",
      },
    ),
    403,
  );
  row = await action(f.staff.admin, row, "approve");
  row = await action(f.staff.kitchen, row, "dispatch");
  assert.equal((await f.store.ingredients.findOne({ _id: a._id })).stock, 0);
  assert.equal(
    (await child.store.ingredients.findOne({ _id: b._id })).stock,
    0,
  );
  assert.equal(
    ok(await f.staff.admin("/api/organization/dashboard")).totals
      .inTransitKnownValueMinor,
    1001,
  );
  const requestKey = key();
  row = ok(
    await receive(receiver, row, 1, "bulk", { requestKey }),
    201,
  ).transfer;
  ok(
    await receive(receiver, { ...row, revision: 2 }, 1, "bulk", { requestKey }),
    201,
  );
  assert.equal(
    (await child.store.ingredients.findOne({ _id: b._id })).stock,
    1,
  );
  row = ok(await receive(receiver, row, 98), 201).transfer;
  row = ok(await receive(receiver, row, 1), 201).transfer;
  assert.equal(row.status, "received");
  const dest = await child.store.ingredients.findOne({ _id: b._id });
  assert.equal(dest.inventoryValueMinor, 1001);
  assert.equal(dest.costComplete, true);
  assert.equal(
    await child.store.transferEntries.countDocuments({ direction: "in" }),
    3,
  );
  const dashboard = ok(await f.staff.admin("/api/organization/dashboard"));
  assert.equal(dashboard.totals.knownStockValueMinor, 1001);
  assert.equal(dashboard.totals.inTransitKnownValueMinor, 0);
  assert.equal(dashboard.totals.salesMinor, 0);
  assert.equal(dashboard.totals.expenseMinor, 0);
  error(await receive(receiver, row, 1), 409, "TRANSFER_UPDATED");
  assert.equal(await child.store.expenses.countDocuments({}), 0);
});
test("dispatch and receipt races cannot double spend, double credit or cross branch scope", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    a = await ingredient(f.store, { stock: 100, value: 1000 }),
    b = await ingredient(child.store),
    receiver = f.browser();
  ok(await post(receiver, "/api/branches/select", { branchId: "uttara" }));
  ok(await post(receiver, "/api/staff/login", { username: "admin", password }));
  let row = await action(
    f.staff.admin,
    await createTransfer(f.staff.admin, "uttara", a, b),
    "approve",
  );
  const input = {
    action: "dispatch",
    expectedRevision: row.revision,
    verified: true,
    reason: "One physical dispatch",
  };
  const sent = await Promise.all([
    post(
      f.staff.admin,
      "/api/staff/stock-transfers/" + row.id + "/action",
      input,
    ),
    post(
      f.staff.kitchen,
      "/api/staff/stock-transfers/" + row.id + "/action",
      input,
    ),
  ]);
  assert.deepEqual(sent.map((r) => r.status).sort(), [200, 409]);
  row = sent.find((r) => r.status === 200).data.transfer;
  error(await receive(f.staff.admin, row, 100), 404, "NOT_FOUND");
  const responses = await Promise.all([
    receive(receiver, row, 100),
    receive(receiver, row, 100),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (await child.store.ingredients.findOne({ _id: b._id })).stock,
    100,
  );
  assert.equal(
    await f.store.transferEntries.countDocuments({ direction: "out" }),
    1,
  );
  error(await f.staff.cashier("/api/staff/stock-transfers"), 403);
});
test("FEFO transfers retain batch expiry and origin, and expired-in-transit goods require quarantine", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    a = await ingredient(f.store, { stock: 100, value: 1234, tracked: true }),
    b = await ingredient(child.store, { tracked: true });
  const soon = stockDay(new Date(Date.now() + 86400000)),
    later = stockDay(new Date(Date.now() + 10 * 86400000));
  await f.store.ingredientBatches.insertMany([
    {
      _id: new ObjectId(),
      ingredientId: a._id,
      code: "SOON",
      expiresOn: soon,
      remaining: 40,
      originalQuantity: 40,
      revision: 0,
      blocked: false,
      createdAt: new Date(),
    },
    {
      _id: new ObjectId(),
      ingredientId: a._id,
      code: "LATER",
      expiresOn: later,
      remaining: 60,
      originalQuantity: 60,
      revision: 0,
      blocked: false,
      createdAt: new Date(),
    },
  ]);
  let row = await action(
    f.staff.admin,
    await action(
      f.staff.admin,
      await createTransfer(f.staff.admin, "uttara", a, b, 70),
      "approve",
    ),
    "dispatch",
  );
  assert.deepEqual(
    row.lines[0].lots.map((l) => [l.code, l.quantity]),
    [
      ["SOON", 40],
      ["LATER", 30],
    ],
  );
  const receiver = f.browser();
  ok(await post(receiver, "/api/branches/select", { branchId: "uttara" }));
  ok(await post(receiver, "/api/staff/login", { username: "admin", password }));
  row = ok(
    await receive(receiver, row, 20, row.lines[0].lots[0].key),
    201,
  ).transfer;
  let lot = await child.store.ingredientBatches.findOne({
    originBatchCode: "SOON",
  });
  assert.equal(lot.expiresOn, soon);
  assert.equal(lot.sourceBranch, "main");
  assert.equal(lot.remaining, 20);
  await f.store.transfers.updateOne(
    { _id: new ObjectId(row.id) },
    { $set: { "lines.0.lots.1.expiresOn": "2000-01-01" } },
  );
  row = ok(await receiver("/api/staff/stock-transfers")).transfers[0];
  error(
    await receive(receiver, row, 30, row.lines[0].lots[1].key),
    409,
    "TRANSFER_EXPIRED",
  );
  ok(
    await receive(receiver, row, 30, row.lines[0].lots[1].key, {
      acceptQuarantine: true,
    }),
    201,
  );
  lot = await child.store.ingredientBatches.findOne({
    originBatchCode: "LATER",
  });
  assert.equal(lot.blocked, true);
  assert.equal(lot.needsReview, true);
  assert.equal(lot.expiresOn, "2000-01-01");
});
test("transfer validation, cancellation, idempotency and catalogue do not expose destination balances", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    a = await ingredient(f.store, { stock: 100, value: 1000 }),
    b = await ingredient(child.store, { stock: 900, value: 9000 });
  const options = ok(
    await f.staff.kitchen("/api/staff/stock-transfers/options?to=uttara"),
  );
  assert.equal("stock" in options.target[0], false);
  assert.equal("inventoryValueMinor" in options.target[0], false);
  const input = {
    toBranch: "uttara",
    lines: [
      {
        sourceIngredientId: String(a._id),
        targetIngredientId: String(b._id),
        quantity: 50,
      },
    ],
    reason: "Test transfer input",
    requestKey: key(),
  };
  const responses = await Promise.all([
    post(f.staff.admin, "/api/staff/stock-transfers", input),
    post(f.staff.kitchen, "/api/staff/stock-transfers", input),
  ]);
  responses.forEach((r) => ok(r, 201));
  assert.equal(responses[0].data.transfer.id, responses[1].data.transfer.id);
  error(
    await post(f.staff.admin, "/api/staff/stock-transfers", {
      ...input,
      reason: "Different request",
    }),
    409,
    "REQUEST_REUSED",
  );
  let row = await action(f.staff.admin, responses[0].data.transfer, "cancel");
  assert.equal(row.status, "cancelled");
  assert.equal((await f.store.ingredients.findOne({ _id: a._id })).stock, 100);
  await child.store.ingredients.updateOne(
    { _id: b._id },
    { $set: { unit: "ml" } },
  );
  error(
    await post(f.staff.admin, "/api/staff/stock-transfers", {
      ...input,
      requestKey: key(),
    }),
    409,
    "TRANSFER_INGREDIENTS",
  );
});
test("restored transfers stay frozen until both local journals match the shared ledger", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f),
    a = await ingredient(f.store, { stock: 100, value: 1000 }),
    b = await ingredient(child.store);
  let row = await action(
    f.staff.admin,
    await action(
      f.staff.admin,
      await createTransfer(f.staff.admin, "uttara", a, b),
      "approve",
    ),
    "dispatch",
  );
  await f.store.transfers.updateOne(
    { _id: new ObjectId(row.id) },
    { $set: { needsRecovery: true } },
  );
  const request = {
    expectedRevision: row.revision,
    currentPassword: password,
    sourceVerified: true,
    destinationVerified: true,
    reason: "Journals and physical counts match",
  };
  await f.store.transferEntries.updateOne(
    { transferId: new ObjectId(row.id) },
    { $set: { quantity: 99 } },
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/stock-transfers/" + row.id + "/recovery",
      request,
    ),
    409,
    "TRANSFER_JOURNAL_MISMATCH",
  );
  await f.store.transferEntries.updateOne(
    { transferId: new ObjectId(row.id) },
    { $set: { quantity: 100 } },
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/stock-transfers/" + row.id + "/recovery",
      request,
    ),
  );
  assert.equal(
    (await f.store.transfers.findOne({ _id: new ObjectId(row.id) }))
      .needsRecovery,
    false,
  );
});
test("consolidation compares real branch reports, labels missing costs and rejects unrelated staff", async (t) => {
  const f = await fixture(t),
    child = await branch(t, f);
  await f.store.bills.insertOne({
    status: "paid",
    paidAt: new Date(),
    totalMinor: 12000,
    subtotalMinor: 12000,
    chargeMinor: 0,
    items: [],
  });
  await child.store.bills.insertOne({
    status: "paid",
    paidAt: new Date(),
    totalMinor: 8000,
    subtotalMinor: 8000,
    chargeMinor: 0,
    items: [],
  });
  await ingredient(f.store, { stock: 100, value: 1000 });
  await ingredient(child.store, { stock: 200, complete: false, unit: "ml" });
  await child.store.cashMovements.insertOne({
    at: new Date(),
    deltaMinor: 8000,
  });
  const data = ok(await f.staff.admin("/api/organization/dashboard"));
  assert.equal(data.complete, true);
  assert.equal(data.totals.salesMinor, 20000);
  assert.equal(data.totals.cashInMinor, 8000);
  assert.equal(data.totals.unknownCostIngredients, 1);
  assert.equal(data.costCoverageComplete, false);
  assert.equal(
    data.branches.find((r) => r.branchId === "main").stock.units.g.stock,
    100,
  );
  error(
    await f.staff.cashier("/api/organization/dashboard"),
    403,
    "PLATFORM_ADMIN_REQUIRED",
  );
  const csv = await f.staff.admin("/api/organization/dashboard.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Branch uttara/);
  await f.store.branches.updateOne(
    { _id: "uttara" },
    { $set: { state: "recovery_required" } },
  );
  const partial = ok(await f.staff.admin("/api/organization/dashboard"));
  assert.equal(partial.complete, false);
  assert.equal(partial.totals.salesMinor, 12000);
  assert.equal(
    partial.branches.find((r) => r.branchId === "uttara").status,
    "unavailable",
  );
});
