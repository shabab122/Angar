import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, patch, ok, error, key } from "./support.js";
import { stockDay } from "../server/ingredient-batches.js";

const date = (days) => stockDay(new Date(Date.now() + days * 86400000));
async function ingredient(f, stock = 0) {
  return ok(
    await post(f.staff.admin, "/api/staff/inventory/ingredients", {
      name: "Test Rice",
      unit: "g",
      initialStock: stock,
      reorderLevel: 50,
    }),
    201,
  ).ingredient;
}
async function enable(f, ingredient, code = "OPENING", expiresOn = date(2)) {
  return ok(
    await post(f.staff.admin, "/api/staff/inventory/batches/enable", {
      ingredientId: ingredient.id,
      expectedRevision: ingredient.revision,
      batch: { code, expiresOn, noExpiry: false },
      reason: "Counted opening batch and checked expiry",
    }),
    201,
  ).batch;
}
async function receive(f, ingredient, quantity, code, expiresOn) {
  return post(
    f.staff.admin,
    "/api/staff/inventory/ingredients/" + ingredient.id + "/stock",
    {
      kind: "receive",
      quantity,
      reason: "Delivered stock counted",
      reference: code,
      requestKey: key(),
      batch: { code, expiresOn, noExpiry: false },
    },
  );
}
async function recipe(f, ingredient) {
  ok(
    await post(f.staff.admin, "/api/staff/inventory/recipes/mutton-kacchi", {
      expectedRevision: 0,
      enabled: true,
      base: [{ ingredientId: ingredient.id, quantity: 100 }],
      variants: [],
      addons: [],
      reason: "Kitchen verified per-portion recipe",
    }),
  );
}
const move = (f, order, action, reason = "") =>
  post(
    f.staff[action === "start" ? "kitchen" : "admin"],
    "/api/staff/orders/" + order.id + "/action",
    { action, reason },
  );

test("batch tracking preserves opening stock, allocates earliest expiry first and never uses expired or quarantined stock", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    rice = await ingredient(f, 100);
  const opening = await enable(f, rice);
  ok(await receive(f, rice, 200, "EARLIER", date(1)));
  ok(await receive(f, rice, 500, "EXPIRED", date(-1)));
  await recipe(f, rice);
  let order = await f.order(guest, await f.open(), 2);
  ok(await move(f, order, "send"));
  const row = await f.store.orders.findOne({ _id: new ObjectId(order.id) });
  assert.equal(row.inventory.batchAllocations[0].code, "EARLIER");
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) })).stock,
    600,
  );
  const view = ok(await f.staff.kitchen("/api/staff/inventory/batches"));
  assert.equal(view.ingredients[0].usableStock, 100);
  assert.equal(
    view.batches.find((row) => row.code === "EXPIRED").expired,
    true,
  );
  const large = await f.order(guest, await f.open("T02"), 2);
  error(await move(f, large, "send"), 409, "BATCH_STOCK_LOW");
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) })).stock,
    600,
  );
  ok(
    await post(
      guest,
      "/api/orders/" + order.id + "/changes",
      {
        type: "cancel",
        reason: "Plans changed before cooking",
        expectedRevision: 1,
      },
      { "Idempotency-Key": key() },
    ),
    201,
  );
  const changed = await f.store.orders.findOne({ _id: new ObjectId(order.id) });
  ok(
    await post(
      f.staff.admin,
      "/api/staff/orders/" +
        order.id +
        "/changes/" +
        changed.changeRequest.id +
        "/decision",
      { decision: "approve", reason: "Cancellation accepted" },
    ),
  );
  assert.equal(
    (await f.store.ingredientBatches.findOne({ code: "EARLIER" })).remaining,
    200,
  );
  assert.equal(
    (await f.store.ingredientBatches.findOne({ _id: new ObjectId(opening.id) }))
      .remaining,
    100,
  );
});
test("quarantined reservations cannot start cooking and manual waste removes the selected expired batch only", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f, 500),
    opening = await enable(f, rice),
    guest = f.browser();
  await recipe(f, rice);
  const order = await f.order(guest, await f.open());
  ok(await move(f, order, "send"));
  let batch = await f.store.ingredientBatches.findOne({
    _id: new ObjectId(opening.id),
  });
  ok(
    await post(
      f.staff.admin,
      "/api/staff/inventory/batches/" + opening.id + "/status",
      {
        expectedRevision: batch.revision,
        expiresOn: date(2),
        noExpiry: false,
        blocked: true,
        reason: "Supplier recalled this lot",
      },
    ),
  );
  error(await move(f, order, "start"), 409, "BATCH_UNUSABLE");
  ok(await receive(f, rice, 50, "OLD", date(-1)));
  const old = await f.store.ingredientBatches.findOne({ code: "OLD" });
  const waste = {
    kind: "waste",
    quantity: 50,
    reason: "Expired stock discarded",
    reference: "DISPOSE-1",
    requestKey: key(),
    batchId: String(old._id),
  };
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/inventory/ingredients/" + rice.id + "/stock",
      waste,
    ),
  );
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/inventory/ingredients/" + rice.id + "/stock",
      waste,
    ),
  );
  assert.equal(
    (await f.store.ingredientBatches.findOne({ _id: old._id })).remaining,
    0,
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/inventory/ingredients/" + rice.id + "/stock",
      {
        kind: "receive",
        quantity: 10,
        reason: "No provenance provided",
        requestKey: key(),
      },
    ),
    400,
    "BATCH_REQUIRED",
  );
});
test("supplier deliveries create stock and payable value once; partial supplier payments cannot exceed received goods", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f);
  await enable(f, rice);
  const supplier = ok(
    await post(f.staff.admin, "/api/staff/suppliers", {
      name: "Test Supplier",
      contact: "Stock Desk",
      phone: "01700000000",
      email: "supplier@example.test",
      address: "Dhaka",
      notes: "",
      active: true,
    }),
    201,
  ).supplier;
  error(await f.staff.kitchen("/api/staff/suppliers"), 403);
  const create = {
    supplierId: supplier.id,
    lines: [
      {
        ingredientId: rice.id,
        quantity: 1000,
        unitPriceMinor: 20000,
        pricePerQuantity: 1000,
      },
    ],
    dueOn: date(7),
    notes: "Count delivery before payment",
    requestKey: key(),
  };
  let purchase = ok(
    await post(f.staff.admin, "/api/staff/purchases", create),
    201,
  ).purchase;
  assert.equal(
    ok(await post(f.staff.admin, "/api/staff/purchases", create), 201).purchase
      .id,
    purchase.id,
  );
  purchase = ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/action",
      {
        action: "order",
        expectedRevision: purchase.revision,
        reason: "Order approved by manager",
      },
    ),
  ).purchase;
  const payment = {
    amountMinor: 5000,
    method: "bank",
    reference: "BANK-REC-1",
    reason: "Verified supplier payment",
    verified: true,
    requestKey: key(),
  };
  error(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + purchase.id + "/payments",
      payment,
    ),
    409,
    "SUPPLIER_PAYMENT_LIMIT",
  );
  const delivered = {
    expectedRevision: purchase.revision,
    reference: "DELIVERY-1",
    reason: "Quantity and lot checked",
    requestKey: key(),
    items: [
      {
        ingredientId: rice.id,
        quantity: 500,
        batch: { code: "PO-LOT-1", expiresOn: date(5), noExpiry: false },
      },
    ],
  };
  purchase = ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/receive",
      delivered,
    ),
  ).purchase;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/receive",
      delivered,
    ),
  );
  assert.equal(purchase.receivedMinor, 10000);
  assert.equal(purchase.status, "partially_received");
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) })).stock,
    500,
  );
  purchase = ok(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + purchase.id + "/payments",
      payment,
    ),
    201,
  ).purchase;
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/purchases/" + purchase.id + "/payments",
      payment,
    ),
    201,
  );
  assert.equal(purchase.balanceMinor, 5000);
  error(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/receive",
      {
        ...delivered,
        expectedRevision: purchase.revision,
        requestKey: key(),
        items: [{ ...delivered.items[0], quantity: 501 }],
      },
    ),
    409,
    "PURCHASE_QUANTITY",
  );
  purchase = ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/action",
      {
        action: "cancel",
        expectedRevision: purchase.revision,
        reason: "Remaining goods unavailable",
      },
    ),
  ).purchase;
  assert.equal(purchase.balanceMinor, 5000);
  assert.equal(purchase.receivedMinor, 10000);
  assert.equal(
    ok(await f.staff.cashier("/api/staff/suppliers")).suppliers[0].balanceMinor,
    5000,
  );
});

test("opening lots must balance exactly and expiry filters include the last usable Dhaka calendar day", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f, 100);
  const opening = {
    ingredientId: rice.id,
    expectedRevision: rice.revision,
    reason: "Physical opening stock counted by lot",
    batches: [
      { code: "TODAY", quantity: 40, expiresOn: date(0), noExpiry: false },
      { code: "OLD", quantity: 30, expiresOn: date(-1), noExpiry: false },
      { code: "SHELF", quantity: 30, expiresOn: null, noExpiry: true },
    ],
  };
  error(
    await post(f.staff.admin, "/api/staff/inventory/batches/enable", {
      ...opening,
      batches: opening.batches.slice(0, 2),
    }),
    409,
    "BATCH_OPENING_BALANCE",
  );
  assert.equal(await f.store.ingredientBatches.countDocuments({}), 0);
  assert.equal(
    (await f.store.ingredients.findOne({ _id: new ObjectId(rice.id) }))
      .batchTracked,
    undefined,
  );
  ok(
    await post(f.staff.admin, "/api/staff/inventory/batches/enable", opening),
    201,
  );
  const view = ok(await f.staff.kitchen("/api/staff/inventory/batches"));
  assert.equal(view.ingredients[0].usableStock, 70);
  assert.equal(view.alerts.expired, 1);
  assert.equal(view.alerts.soon, 1);
  assert.equal(view.batches.find((row) => row.code === "TODAY").expired, false);
  assert.deepEqual(
    ok(
      await f.staff.kitchen("/api/staff/inventory/batches?filter=expired"),
    ).batches.map((row) => row.code),
    ["OLD"],
  );
  assert.deepEqual(
    ok(
      await f.staff.kitchen("/api/staff/inventory/batches?filter=soon"),
    ).batches.map((row) => row.code),
    ["TODAY"],
  );
});

test("partial receipt rounding stays exact and concurrent cash supplier payments cannot spend the balance twice", async (t) => {
  const f = await fixture(t),
    rice = await ingredient(f);
  const supplier = ok(
    await post(f.staff.admin, "/api/staff/suppliers", {
      name: "Exact Supplier",
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
          ingredientId: rice.id,
          quantity: 3,
          unitPriceMinor: 100,
          pricePerQuantity: 3,
        },
      ],
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
        reason: "Agreed price checked",
      },
    ),
  ).purchase;
  const values = [];
  for (let i = 0; i < 3; i++) {
    purchase = ok(
      await post(
        f.staff.admin,
        "/api/staff/purchases/" + purchase.id + "/receive",
        {
          expectedRevision: purchase.revision,
          reference: "SMALL-" + i,
          reason: "One unit counted",
          requestKey: key(),
          items: [{ ingredientId: rice.id, quantity: 1 }],
        },
      ),
    ).purchase;
    values.push(purchase.receivedMinor);
  }
  assert.deepEqual(values, [33, 67, 100]);
  ok(
    await post(f.staff.cashier, "/api/staff/cash-drawer/open", {
      openingMinor: 100,
      reason: "One taka physically counted",
      verified: true,
      requestKey: key(),
    }),
    201,
  );
  const payment = {
    amountMinor: 100,
    method: "cash",
    reference: "",
    reason: "Supplier received one taka",
    verified: true,
  };
  const results = await Promise.all([
    post(f.staff.admin, "/api/staff/purchases/" + purchase.id + "/payments", {
      ...payment,
      requestKey: key(),
    }),
    post(f.staff.cashier, "/api/staff/purchases/" + purchase.id + "/payments", {
      ...payment,
      requestKey: key(),
    }),
  ]);
  assert.deepEqual(results.map((row) => row.status).sort(), [201, 409]);
  assert.equal(
    (await f.store.purchases.findOne({ _id: new ObjectId(purchase.id) }))
      .paidMinor,
    100,
  );
  const drawer = ok(await f.staff.cashier("/api/staff/cash-drawer"));
  assert.equal(drawer.active.expectedMinor, 0);
  assert.equal(drawer.active.cashOutMinor, 100);
  assert.equal(await f.store.supplierPayments.countDocuments({}), 1);
});
