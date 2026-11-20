import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key } from "./support.js";
import {
  fulfillmentDefaults,
  fulfillmentTotals,
} from "../server/fulfillment.js";
import { reportWindow, salesReport } from "../server/reports.js";

const day = () =>
  new Date(Date.now() + 86400000 + 6 * 3600000).toISOString().slice(0, 10) +
  "T12:00:00+06:00";
const cart = () => ({
  kind: "pickup",
  zoneId: "",
  scheduledAt: day(),
  items: [{ dishId: "mutton-kacchi", quantity: 2, expectedPrice: 420 }],
  couponCode: "",
  loyaltyPoints: 0,
});
async function enable(f, overrides = {}) {
  const current = ok(await f.staff.admin("/api/staff/fulfillment/settings"));
  return ok(
    await post(f.staff.admin, "/api/staff/fulfillment/settings", {
      ...fulfillmentDefaults,
      pickupEnabled: true,
      deliveryEnabled: true,
      zones: [
        {
          id: "dhanmondi",
          name: "Dhanmondi",
          feeMinor: 6000,
          minimumFoodMinor: 50000,
          estimatedMinutes: 30,
        },
      ],
      ...overrides,
      expectedRevision: current.revision,
      reason: "Staff confirmed service areas",
    }),
  );
}
async function payload(guest, values = {}) {
  const input = { ...cart(), ...values },
    quote = ok(await post(guest, "/api/fulfillment/quote", input)).quote;
  return {
    ...input,
    quoteHash: quote.quoteHash,
    name: "Takeaway Guest",
    phone: "01700000000",
    ...(input.kind === "delivery"
      ? {
          address: {
            line: "House 12 Road 4",
            area: "Dhanmondi",
            note: "Call on arrival",
          },
        }
      : {}),
    note: "No extra chilli",
    requestKey: key(),
  };
}
const place = async (guest, values = {}) =>
  ok(
    await post(guest, "/api/fulfillment/orders", await payload(guest, values)),
    201,
  ).order;
const action = (client, row, kind, extra = {}) =>
  post(client, "/api/staff/fulfillment/orders/" + row.id + "/action", {
    action: kind,
    expectedRevision: row.revision,
    ...extra,
  });
const own = async (guest, id) =>
  ok(await guest("/api/fulfillment/orders")).orders.find(
    (row) => row.id === id,
  );
async function inventory(f) {
  const id = new ObjectId();
  await f.store.ingredients.insertOne({
    _id: id,
    name: "Rice",
    unit: "g",
    stock: 1000,
    reorderLevel: 200,
    revision: 0,
  });
  await f.store.recipes.insertOne({
    _id: "mutton-kacchi",
    enabled: true,
    base: [{ ingredientId: id.toString(), quantity: 100 }],
    variants: [],
    addons: [],
  });
  return async () => (await f.store.ingredients.findOne({ _id: id })).stock;
}

test("off-premise ordering is opt-in, quotes reject tampering and concurrent retry creates only one request", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  assert.equal(
    ok(await guest("/api/fulfillment/options")).pickupEnabled,
    false,
  );
  error(
    await post(guest, "/api/fulfillment/quote", cart()),
    409,
    "FULFILLMENT_DISABLED",
  );
  error(
    await post(f.staff.cashier, "/api/staff/fulfillment/settings", {}),
    403,
  );
  await enable(f);
  error(
    await post(guest, "/api/fulfillment/quote", {
      ...cart(),
      items: [{ ...cart().items[0], expectedPrice: 1 }],
    }),
    409,
    "PRICE_CHANGED",
  );
  error(
    await post(guest, "/api/fulfillment/quote", {
      ...cart(),
      kind: "delivery",
      zoneId: "unknown",
    }),
    400,
    "DELIVERY_ZONE",
  );
  error(
    await post(guest, "/api/fulfillment/quote", {
      ...cart(),
      kind: "delivery",
      zoneId: "dhanmondi",
      items: [{ ...cart().items[0], quantity: 1 }],
    }),
    409,
    "DELIVERY_MINIMUM",
  );
  const input = await payload(guest, { kind: "delivery", zoneId: "dhanmondi" });
  const results = await Promise.all([
    post(guest, "/api/fulfillment/orders", input),
    post(guest, "/api/fulfillment/orders", input),
  ]);
  assert.equal(ok(results[0], 201).order.id, ok(results[1], 201).order.id);
  assert.equal(await f.store.fulfillments.countDocuments({}), 1);
  error(
    await post(guest, "/api/fulfillment/orders", {
      ...input,
      note: "Different request",
    }),
    409,
    "REQUEST_REUSED",
  );
  const stale = await payload(guest);
  await enable(f, { applyServiceCharge: true });
  error(
    await post(guest, "/api/fulfillment/orders", stale),
    409,
    "QUOTE_CHANGED",
  );
  const soldOut = await payload(guest);
  await f.store.dishes.updateOne(
    { _id: "mutton-kacchi" },
    { $set: { available: false } },
  );
  error(
    await post(guest, "/api/fulfillment/orders", soldOut),
    409,
    "ITEM_UNAVAILABLE",
  );
});

test("pickup reserves stock once, keeps private ownership and requires full payment before collection without closing a table", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    outsider = f.browser();
  await enable(f);
  const stock = await inventory(f),
    table = await f.open();
  let order = await place(guest);
  assert.equal(await stock(), 1000);
  error(await action(f.staff.waiter, order, "accept"), 403);
  const stale = order;
  order = ok(await action(f.staff.admin, order, "accept")).order;
  assert.equal(await stock(), 800);
  assert.equal(order.bill.status, "finalized");
  error(
    await action(f.staff.admin, stale, "accept"),
    409,
    "FULFILLMENT_UPDATED",
  );
  assert.equal(await stock(), 800);
  assert.equal(ok(await outsider("/api/fulfillment/orders")).orders.length, 0);
  error(await outsider("/api/bills/" + order.bill.id), 404);
  const kitchen = ok(await f.staff.kitchen("/api/staff/fulfillment/orders"))
    .orders[0];
  assert.equal(kitchen.phone, undefined);
  assert.equal(kitchen.bill, null);
  error(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + order.bill.id + "/splits",
      {
        expectedRevision: order.bill.revision,
        mode: "equal",
        parts: [{ label: "One" }, { label: "Two" }],
      },
    ),
    409,
    "SPLIT_UNAVAILABLE",
  );
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + order.bill.id + "/pay", {
      method: "cash",
      verified: true,
      amountMinor: 10000,
      requestKey: key(),
    }),
    409,
    "FULL_PAYMENT_REQUIRED",
  );
  order = ok(await action(f.staff.kitchen, order, "prepare")).order;
  order = ok(await action(f.staff.kitchen, order, "ready")).order;
  error(
    await action(f.staff.waiter, order, "collect"),
    409,
    "PAYMENT_REQUIRED",
  );
  const payment = {
    method: "cash",
    verified: true,
    amountMinor: order.total * 100,
    requestKey: key(),
  };
  const bill = ok(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + (await own(guest, order.id)).bill.id + "/pay",
      payment,
    ),
  ).bill;
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + bill.id + "/pay",
      payment,
    ),
  );
  assert.equal(bill.payments.length, 1);
  order = await own(guest, order.id);
  order = ok(await action(f.staff.waiter, order, "collect")).order;
  assert.equal(order.status, "collected");
  assert.equal(await stock(), 800);
  ok(await guest("/api/receipts/" + bill.id));
  error(await outsider("/api/receipts/" + bill.id), 404);
  assert.equal(
    (await f.store.tables.findOne({ _id: table._id })).activeVisitId.toString(),
    table.activeVisitId.toString(),
  );
  assert.equal(
    ok(await f.staff.cashier("/api/staff/billing")).recent.length,
    0,
  );
});

test("delivery supports dispatch before cash collection, itemizes taxed fees and refunds every component exactly", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  await enable(f, { taxableDeliveryFee: true });
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    {
      $set: {
        tax: {
          enabled: true,
          label: "VAT",
          rateBps: 500,
          mode: "exclusive",
          base: "food",
        },
      },
    },
  );
  let order = await place(guest, { kind: "delivery", zoneId: "dhanmondi" });
  assert.equal(order.quote.deliveryFeeMinor, 6000);
  assert.equal(order.quote.taxMinor, 4500);
  assert.equal(order.quote.totalMinor, 94500);
  for (const [role, kind] of [
    ["admin", "accept"],
    ["kitchen", "prepare"],
    ["kitchen", "ready"],
    ["waiter", "dispatch"],
  ])
    order = ok(
      await action(
        f.staff[role],
        order,
        kind,
        kind === "dispatch"
          ? { courierName: "Delivery Staff", courierPhone: "01700000001" }
          : {},
      ),
    ).order;
  error(
    await action(f.staff.waiter, order, "deliver"),
    409,
    "PAYMENT_REQUIRED",
  );
  let bill = (await own(guest, order.id)).bill;
  bill = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      reference: "COD verified",
      verified: true,
      requestKey: key(),
    }),
  ).bill;
  order = await own(guest, order.id);
  order = ok(await action(f.staff.waiter, order, "deliver")).order;
  assert.equal(order.status, "delivered");
  assert.equal(bill.deliveryFee, 60);
  const report = await salesReport(f.store, reportWindow({}));
  assert.equal(report.summary.revenueMinor, 94500);
  assert.equal(report.accounting.deliveryFeesMinor, 6000);
  for (const amount of [10001, 84499]) {
    const refund = ok(
      await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/refunds", {
        paymentId: bill.payments[0].id,
        amountMinor: amount,
        reason: "Delivery return approved",
        requestKey: key(),
      }),
      201,
    ).refund;
    ok(
      await post(
        f.staff.admin,
        "/api/staff/refunds/" + refund.id + "/decision",
        { decision: "approve", reason: "Return verified by restaurant" },
      ),
    );
    ok(
      await post(
        f.staff.cashier,
        "/api/staff/refunds/" + refund.id + "/execute",
        { verified: true, reference: "Cash returned" },
      ),
    );
  }
  const returned = await f.store.bills.findOne({ _id: new ObjectId(bill.id) });
  assert.deepEqual(returned.refundComponents, [84000, 0, 4500, 6000]);
  assert.equal(returned.refundedMinor, 94500);
  assert.equal(
    returned.refunds.reduce(
      (sum, row) => sum + row.creditNote.deliveryFeeMinor,
      0,
    ),
    6000,
  );
});

test("unpaid cancellation releases reserved ingredients and benefits once; preparation stock stays consumed", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    member = await f.account(guest);
  await enable(f);
  const stock = await inventory(f);
  await f.store.customers.updateOne(
    { _id: new ObjectId(member.id) },
    { $set: { points: 10 } },
  );
  let row = await place(guest, { loyaltyPoints: 10 });
  row = ok(await action(f.staff.admin, row, "accept")).order;
  assert.equal(ok(await guest("/api/account")).customer.points, 0);
  error(
    await post(guest, "/api/fulfillment/orders/" + row.id + "/cancel", {
      reason: "Guest requested return",
    }),
    409,
  );
  row = ok(
    await action(f.staff.admin, row, "cancel", {
      reason: "Guest requested cancellation before cooking",
    }),
  ).order;
  assert.equal(row.bill.status, "void");
  assert.equal(row.bill.balanceMinor, 0);
  assert.equal(await stock(), 1000);
  assert.equal(ok(await guest("/api/account")).customer.points, 10);
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + row.bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
    409,
    "BILL_NOT_FINAL",
  );
  row = await place(guest);
  row = ok(await action(f.staff.admin, row, "accept")).order;
  row = ok(await action(f.staff.kitchen, row, "prepare")).order;
  row = ok(
    await action(f.staff.admin, row, "cancel", {
      reason: "Guest cancelled after preparation",
    }),
  ).order;
  assert.equal(await stock(), 800);
  const placed = await place(guest);
  ok(
    await post(guest, "/api/fulfillment/orders/" + placed.id + "/cancel", {
      reason: "Changed pickup plan",
    }),
  );
  assert.equal(await stock(), 800);
});

test("inclusive delivery tax balances and fully discounted pickup completes payment without a table visit", async (t) => {
  const totals = fulfillmentTotals(
    10000,
    {
      serviceChargeBps: 1000,
      tax: {
        enabled: true,
        mode: "inclusive",
        base: "food_and_service",
        rateBps: 1500,
        label: "VAT",
      },
    },
    { applyServiceCharge: true, taxableDeliveryFee: true },
    5000,
  );
  assert.equal(totals.totalMinor, 16000);
  assert.equal(
    totals.accountingFoodMinor +
      totals.accountingChargeMinor +
      totals.accountingDeliveryFeeMinor +
      totals.taxMinor,
    totals.totalMinor,
  );
  const f = await fixture(t),
    guest = f.browser();
  await f.account(guest);
  await enable(f);
  ok(
    await post(f.staff.admin, "/api/staff/coupons", {
      code: "FREEPICKUP",
      kind: "percent",
      value: 10000,
      minSpendMinor: 0,
      maxDiscountMinor: 0,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
      usageLimit: 1,
      perCustomerLimit: 1,
      enabled: true,
      public: true,
    }),
  );
  let row = await place(guest, { couponCode: "FREEPICKUP" });
  row = ok(await action(f.staff.admin, row, "accept")).order;
  assert.equal(row.bill.totalMinor, 0);
  assert.equal(row.bill.status, "paid");
  assert.equal(row.paymentStatus, "paid");
  row = ok(await action(f.staff.kitchen, row, "prepare")).order;
  assert.equal(row.status, "preparing");
});

test("verified full online checkout settles pickup once and its pending hold blocks cancellation or duplicate receipts", async (t) => {
  const records = new Map(),
    gateway = {
      mode: "sandbox",
      storeId: "pickup-test",
      storePassword: "controlled-local-secret",
      publicOrigin: "https://angar.example.test",
    };
  const transport = async (raw, options) => {
    const url = new URL(raw),
      fields =
        options.method === "POST"
          ? new URLSearchParams(options.body)
          : url.searchParams;
    let result;
    if (url.pathname.endsWith("/gwprocess/v4/api.php")) {
      const id = fields.get("tran_id");
      records.set(id, {
        tran_id: id,
        val_id: "VAL-" + id,
        amount: fields.get("total_amount"),
        currency: "BDT",
        currency_type: "BDT",
        status: "VALID",
        risk_level: "0",
        bank_tran_id: "BANK-" + id,
      });
      result = {
        status: "SUCCESS",
        sessionkey: "SESSION-" + id,
        GatewayPageURL: "https://sandbox.sslcommerz.com/checkout/" + id,
      };
    } else if (url.pathname.endsWith("validationserverAPI.php"))
      result = [...records.values()].find(
        (row) => row.val_id === fields.get("val_id"),
      );
    else
      result = {
        APIConnect: "DONE",
        element: records.has(fields.get("tran_id"))
          ? [records.get(fields.get("tran_id"))]
          : [],
      };
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const f = await fixture(t, { gateway, gatewayFetch: transport }),
    guest = f.browser();
  await f.account(guest);
  await enable(f);
  let row = await place(guest);
  row = ok(await action(f.staff.admin, row, "accept")).order;
  const checkout = {
    requestKey: key(),
    amountMinor: row.bill.totalMinor,
    name: "Pickup Member",
    email: "member@example.test",
    phone: "01700000000",
    consent: true,
  };
  error(
    await post(guest, "/api/bills/" + row.bill.id + "/online-payments", {
      ...checkout,
      amountMinor: 10000,
    }),
    409,
    "FULL_PAYMENT_REQUIRED",
  );
  const intent = ok(
    await post(
      guest,
      "/api/bills/" + row.bill.id + "/online-payments",
      checkout,
    ),
    201,
  ).transaction;
  error(
    await action(f.staff.admin, row, "cancel", {
      reason: "Hold must be resolved first",
    }),
    409,
    "PAYMENT_PENDING",
  );
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + row.bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
    409,
    "PAYMENT_AMOUNT",
  );
  const ipn = () =>
    guest("/api/payments/sslcommerz/ipn", {
      method: "POST",
      raw: new URLSearchParams({
        tran_id: intent.id,
        val_id: "VAL-" + intent.id,
        status: "VALID",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  ok(await ipn());
  ok(await ipn());
  row = await own(guest, row.id);
  assert.equal(row.bill.status, "paid");
  assert.equal(row.paymentStatus, "paid");
  assert.equal(row.bill.payments.length, 1);
  assert.equal(ok(await guest("/api/account")).customer.points, 8);
  assert.equal(
    await f.store.tables.countDocuments({
      activeVisitId: { $type: "objectId" },
    }),
    0,
  );
});
