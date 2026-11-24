import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key } from "./support.js";
import { stockDay } from "../server/ingredient-batches.js";
async function ingredient(f, stock = 1000) {
  return ok(
    await post(f.staff.admin, "/api/staff/inventory/ingredients", {
      name: "Counted Rice",
      unit: "g",
      initialStock: stock,
      reorderLevel: 100,
    }),
    201,
  ).ingredient;
}
async function count(f, rice) {
  return ok(
    await post(f.staff.kitchen, "/api/staff/stocktakes", {
      ingredientIds: [rice.id],
      reason: "Physical available stock counted",
      requestKey: key(),
    }),
    201,
  ).stocktake;
}
async function value(f, rice) {
  ok(
    await post(f.staff.admin, "/api/staff/finance/valuation/" + rice.id, {
      expectedRevision: rice.revision,
      unitPriceMinor: 20000,
      pricePerQuantity: 1000,
      reason: "Opening purchase invoice checked",
    }),
  );
}
async function recipe(f, rice) {
  ok(
    await post(f.staff.admin, "/api/staff/inventory/recipes/mutton-kacchi", {
      expectedRevision: 0,
      enabled: true,
      base: [{ ingredientId: rice.id, quantity: 100 }],
      variants: [],
      addons: [],
      reason: "Cook verified portion ingredients",
    }),
  );
}
test("stocktakes require reviewed counts, reject stale stock and apply a verified recount once", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f);
  error(await f.staff.cashier("/api/staff/stocktakes"), 403);
  let take = await count(f, rice);
  error(
    await post(
      f.staff.kitchen,
      "/api/staff/stocktakes/" + take.id + "/submit",
      { expectedRevision: take.revision },
    ),
    409,
    "COUNT_INCOMPLETE",
  );
  take = ok(
    await post(f.staff.kitchen, "/api/staff/stocktakes/" + take.id + "/count", {
      ingredientId: rice.id,
      expectedRevision: take.revision,
      counted: 970,
    }),
  ).stocktake;
  take = ok(
    await post(
      f.staff.kitchen,
      "/api/staff/stocktakes/" + take.id + "/submit",
      { expectedRevision: take.revision },
    ),
  ).stocktake;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/inventory/ingredients/" + rice.id + "/stock",
      {
        kind: "receive",
        quantity: 10,
        reason: "New delivery during count",
        requestKey: key(),
      },
    ),
  );
  const review = {
    decision: "approve",
    expectedRevision: take.revision,
    reason: "Manager reviewed count",
    requestKey: key(),
  };
  error(
    await post(
      f.staff.admin,
      "/api/staff/stocktakes/" + take.id + "/decision",
      review,
    ),
    409,
    "COUNT_STALE",
  );
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) })).stock,
    1010,
  );
  take = ok(
    await post(
      f.staff.kitchen,
      "/api/staff/stocktakes/" + take.id + "/refresh",
      {
        ingredientId: rice.id,
        expectedRevision: take.revision,
        reason: "Delivery arrived; recount required",
      },
    ),
  ).stocktake;
  take = ok(
    await post(f.staff.kitchen, "/api/staff/stocktakes/" + take.id + "/count", {
      ingredientId: rice.id,
      expectedRevision: take.revision,
      counted: 980,
    }),
  ).stocktake;
  take = ok(
    await post(
      f.staff.kitchen,
      "/api/staff/stocktakes/" + take.id + "/submit",
      { expectedRevision: take.revision },
    ),
  ).stocktake;
  const approved = {
    ...review,
    expectedRevision: take.revision,
    requestKey: key(),
  };
  ok(
    await post(
      f.staff.admin,
      "/api/staff/stocktakes/" + take.id + "/decision",
      approved,
    ),
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/stocktakes/" + take.id + "/decision",
      approved,
    ),
  );
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) })).stock,
    980,
  );
  assert.equal(
    await f.store.stockMovements.countDocuments({
      kind: "stocktake_adjustment",
    }),
    1,
  );
});
test("batch stocktake balances include zero counts and concurrent approvals cannot both apply", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f, 100);
  ok(
    await post(f.staff.admin, "/api/staff/inventory/batches/enable", {
      ingredientId: rice.id,
      expectedRevision: 0,
      batches: [
        { code: "LOT-A", quantity: 40, noExpiry: true },
        { code: "LOT-B", quantity: 60, noExpiry: true },
      ],
      reason: "Two physical lots counted",
    }),
    201,
  );
  let take = await count(f, rice),
    line = take.items[0];
  take = ok(
    await post(f.staff.kitchen, "/api/staff/stocktakes/" + take.id + "/count", {
      ingredientId: rice.id,
      expectedRevision: take.revision,
      batches: line.batches.map((b, i) => ({
        batchId: b.id,
        counted: i ? 90 : 0,
      })),
    }),
  ).stocktake;
  take = ok(
    await post(
      f.staff.kitchen,
      "/api/staff/stocktakes/" + take.id + "/submit",
      { expectedRevision: take.revision },
    ),
  ).stocktake;
  const input = {
    decision: "approve",
    expectedRevision: take.revision,
    reason: "Reviewed missing and found quantities",
    requestKey: key(),
  };
  const results = await Promise.all([
    post(
      f.staff.admin,
      "/api/staff/stocktakes/" + take.id + "/decision",
      input,
    ),
    post(
      f.staff.admin,
      "/api/staff/stocktakes/" + take.id + "/decision",
      input,
    ),
  ]);
  results.forEach((r) => ok(r));
  const batches = await f.store.ingredientBatches
    .find({})
    .sort({ code: 1 })
    .toArray();
  assert.deepEqual(
    batches.map((b) => b.remaining),
    [0, 90],
  );
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) })).stock,
    90,
  );
});
test("weighted inventory cost is reserved and returned at its original snapshot before cooking", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f);
  await value(f, rice);
  await recipe(f, rice);
  const guest = f.browser(),
    order = await f.order(guest, await f.open(), 2);
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/action", {
      action: "send",
    }),
  );
  let row = await f.store.orders.findOne({ _id: new ObjectId(order.id) });
  assert.equal(row.inventory.costs[0].amountMinor, 4000);
  ok(
    await post(
      f.staff.admin,
      "/api/staff/inventory/ingredients/" + rice.id + "/stock",
      {
        kind: "receive",
        quantity: 1000,
        costMinor: 40000,
        reason: "Higher priced rice received",
        requestKey: key(),
      },
    ),
  );
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/cancel", {
      reason: "Guest cancelled before cooking",
    }),
    204,
  );
  row = await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) });
  assert.equal(row.stock, 2000);
  assert.equal(row.inventoryValueMinor, 60000);
  assert.equal(await f.store.inventoryConsumptions.countDocuments({}), 0);
});
test("approved operating expenses require actual payment, serialize limits and adjust the shared cash drawer", async (t) => {
  const f = await fixture(t);
  const expense = ok(
    await post(f.staff.cashier, "/api/staff/expenses", {
      category: "salary",
      payee: "Shift Cook",
      amountMinor: 10000,
      incurredOn: stockDay(),
      notes: "Verified shift allowance",
      requestKey: key(),
    }),
    201,
  ).expense;
  const payment = {
    amountMinor: 6000,
    method: "cash",
    reference: "",
    reason: "Actual partial wage paid",
    verified: true,
    requestKey: key(),
  };
  error(
    await post(
      f.staff.cashier,
      "/api/staff/expenses/" + expense.id + "/payments",
      payment,
    ),
    409,
    "EXPENSE_PAYMENT_LIMIT",
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/expenses/" + expense.id + "/decision",
      {
        decision: "approve",
        expectedRevision: expense.revision,
        reason: "Work and allowance checked",
      },
    ),
  );
  ok(
    await post(f.staff.cashier, "/api/staff/cash-drawer/open", {
      openingMinor: 20000,
      reason: "Cash counted before shift",
      verified: true,
      requestKey: key(),
    }),
    201,
  );
  const competingPayment = { ...payment, requestKey: key() };
  const responses = await Promise.all([
    post(
      f.staff.admin,
      "/api/staff/expenses/" + expense.id + "/payments",
      payment,
    ),
    post(
      f.staff.cashier,
      "/api/staff/expenses/" + expense.id + "/payments",
      competingPayment,
    ),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/expenses/" + expense.id + "/payments",
      responses[0].status === 201 ? payment : competingPayment,
    ),
    201,
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/cash-drawer")).active.expectedMinor,
    14000,
  );
  assert.equal(await f.store.expensePayments.countDocuments({}), 1);
});
test("profit separates settled revenue, original ingredient consumption, recorded waste, expenses and missing legacy costs", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f);
  await value(f, rice);
  await recipe(f, rice);
  const bill = await f.finalized(f.browser());
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
  );
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/inventory/ingredients/" + rice.id + "/stock",
      {
        kind: "waste",
        quantity: 50,
        reason: "Actual preparation waste",
        requestKey: key(),
      },
    ),
  );
  let expense = ok(
    await post(f.staff.cashier, "/api/staff/expenses", {
      category: "rent",
      payee: "Restaurant Rent",
      amountMinor: 10000,
      incurredOn: stockDay(),
      notes: "Period rent invoice",
      requestKey: key(),
    }),
    201,
  ).expense;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/expenses/" + expense.id + "/decision",
      {
        decision: "approve",
        expectedRevision: expense.revision,
        reason: "Rent invoice approved",
      },
    ),
  );
  const report = ok(await f.staff.admin("/api/staff/finance/profit"));
  assert.equal(report.summary.salesMinor, 84000);
  assert.equal(report.summary.costMinor, 4000);
  assert.equal(report.summary.wasteMinor, 1000);
  assert.equal(report.summary.expenseMinor, 10000);
  assert.equal(report.summary.operatingResultMinor, 69000);
  assert.equal(report.summary.costCoverageComplete, true);
  assert.equal(
    (await f.staff.cashier("/api/staff/finance/profit.csv")).status,
    200,
  );
  error(await f.staff.kitchen("/api/staff/finance/profit"), 403);
  await f.store.inventoryConsumptions.deleteMany({});
  assert.equal(
    ok(await f.staff.admin("/api/staff/finance/profit")).summary
      .costCoverageComplete,
    false,
  );
});
