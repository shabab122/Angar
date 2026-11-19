import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { test } from "node:test";
import { fixture, key, ok, error, password, post, patch } from "./support.js";

const coupon = (code, fields = {}) => ({
  code,
  kind: "percent",
  value: 1000,
  minSpendMinor: 0,
  maxDiscountMinor: 0,
  startsAt: new Date(Date.now() - 86400000).toISOString(),
  endsAt: new Date(Date.now() + 86400000).toISOString(),
  usageLimit: 10,
  perCustomerLimit: 1,
  enabled: true,
  public: true,
  ...fields,
});
const receipt = (amountMinor, fields = {}) => ({
  method: "cash",
  reference: "",
  verified: true,
  amountMinor,
  requestKey: key(),
  ...fields,
});

test("customer history remains private across browsers and logout; reorder uses current prices", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    second = f.browser(),
    stranger = f.browser();
  const table = await f.open(),
    placed = await f.order(guest, table);
  const customer = await f.account(guest);
  const stored = await f.store.customers.findOne({
    _id: new ObjectId(customer.id),
  });
  assert.notEqual(stored.passwordHash, password);
  assert.equal(stored.password, undefined);
  assert.equal(ok(await guest("/api/account/history")).orders[0].id, placed.id);
  ok(
    await post(second, "/api/account/login", {
      email: customer.email,
      password,
    }),
  );
  assert.equal(ok(await second("/api/orders")).orders[0].id, placed.id);
  error(await stranger("/api/account/history"), 401, "CUSTOMER_REQUIRED");
  const outsider = await f.account(stranger);
  error(
    await post(stranger, "/api/account/orders/" + placed.id + "/reorder"),
    404,
    "NOT_FOUND",
  );
  assert.equal(ok(await stranger("/api/orders")).orders.length, 0);
  await f.store.dishes.updateOne(
    { _id: "mutton-kacchi" },
    { $set: { price: 450 } },
  );
  const reorder = ok(
    await post(second, "/api/account/orders/" + placed.id + "/reorder"),
  );
  assert.equal(reorder.items[0].expectedPrice, 450);
  assert.equal(reorder.warnings.length, 1);
  await f.store.dishes.updateOne(
    { _id: "mutton-kacchi" },
    { $set: { available: false } },
  );
  assert.equal(
    ok(await post(second, "/api/account/orders/" + placed.id + "/reorder"))
      .items.length,
    0,
  );
  ok(await post(guest, "/api/account/logout"), 204);
  assert.equal(ok(await guest("/api/orders")).orders.length, 0);
  ok(
    await post(guest, "/api/account/login", {
      email: customer.email,
      password,
    }),
  );
  ok(
    await post(guest, "/api/account/password", {
      currentPassword: password,
      newPassword: "Replacement-password-123!",
    }),
    204,
  );
  assert.equal(ok(await second("/api/account")).customer, null);
  assert.equal(ok(await guest("/api/account")).customer.id, customer.id);
  error(
    await post(second, "/api/account/login", {
      email: customer.email,
      password,
    }),
    401,
    "LOGIN_FAILED",
  );
  assert.notEqual(outsider.id, customer.id);
});

test("coupons and loyalty are reserved once; points are earned only after the full bill is settled", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    customer = await f.account(guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(customer.id) },
    { $set: { points: 100 } },
  );
  error(
    await post(f.staff.kitchen, "/api/staff/coupons", coupon("MEMBER10")),
    403,
    "FORBIDDEN",
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/coupons",
      coupon("MEMBER10", { usageLimit: 1 }),
    ),
  );
  const table = await f.open(),
    order = await f.order(guest, table);
  error(
    await post(guest, "/api/table/promotions", {
      couponCode: "MEMBER10",
      loyaltyPoints: 101,
    }),
    409,
    "POINTS_UNAVAILABLE",
  );
  const promotion = ok(
    await post(guest, "/api/table/promotions", {
      couponCode: "MEMBER10",
      loyaltyPoints: 20,
    }),
  );
  assert.equal(promotion.totals.discountMinor, 10400);
  await f.serve(order);
  const bill = ok(
    await post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
  ).bill;
  assert.equal(bill.totalMinor, 73600);
  assert.equal(bill.discount, 104);
  ok(await post(f.staff.cashier, "/api/staff/billing/T01/finalize"));
  assert.equal(
    (await f.store.coupons.findOne({ _id: "MEMBER10" })).usedCount,
    1,
  );
  assert.equal(ok(await guest("/api/account/loyalty")).points, 80);
  const first = receipt(10000);
  const responses = await Promise.all([
    post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", first),
    post(f.staff.admin, "/api/staff/bills/" + bill.id + "/pay", first),
  ]);
  responses.forEach((response) => ok(response));
  assert.equal(responses[0].data.bill.paidMinor, 10000);
  assert.equal(
    (await f.store.tables.findOne({ number: "T01" })).activeVisitId.toString(),
    table.activeVisitId.toString(),
  );
  assert.equal(ok(await guest("/api/account/loyalty")).points, 80);
  const last = receipt(63600, { method: "card", reference: "Terminal-001" });
  const settled = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", last),
  ).bill;
  assert.equal(settled.status, "paid");
  assert.equal(settled.balanceMinor, 0);
  assert.equal(settled.payment.method, "mixed");
  assert.equal(
    (await f.store.tables.findOne({ number: "T01" })).activeVisitId,
    null,
  );
  assert.equal(ok(await guest("/api/account/loyalty")).points, 87);
  ok(await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", last));
  assert.equal(ok(await guest("/api/account/loyalty")).ledger.length, 2);
  const second = f.browser();
  await f.account(second);
  const table2 = await f.open("T02");
  await f.order(second, table2);
  error(
    await post(second, "/api/table/promotions", {
      couponCode: "MEMBER10",
      loyaltyPoints: 0,
    }),
    409,
    "COUPON_LIMIT",
  );
  const expired = coupon("EXPIRED", {
    startsAt: new Date(Date.now() - 172800000).toISOString(),
    endsAt: new Date(Date.now() - 86400000).toISOString(),
  });
  ok(await post(f.staff.admin, "/api/staff/coupons", expired));
  error(
    await post(second, "/api/table/promotions", {
      couponCode: "EXPIRED",
      loyaltyPoints: 0,
    }),
    409,
    "COUPON_EXPIRED",
  );
  const report = ok(await f.staff.cashier("/api/staff/reports/sales"));
  assert.equal(report.summary.revenueMinor, 73600);
  assert.equal(report.summary.subtotalMinor, 73600);
  assert.equal(
    report.payments.reduce((sum, row) => sum + row.revenueMinor, 0),
    73600,
  );
  assert.deepEqual(report.payments.map((row) => row.method).sort(), [
    "card",
    "cash",
  ]);
});

test("equal splits preserve odd paisa, concurrent partial receipts cannot overpay, and the table closes last", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    { $set: { serviceChargeBps: 333 } },
    { upsert: true },
  );
  let bill = await f.finalized(guest);
  assert.equal(bill.totalMinor, 86797);
  bill = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/splits", {
      mode: "equal",
      expectedRevision: bill.revision,
      parts: [{ label: "Alice" }, { label: "Bob" }, { label: "Carol" }],
    }),
  ).bill;
  assert.deepEqual(
    bill.splits.map((part) => part.amountMinor),
    [28933, 28932, 28932],
  );
  error(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + bill.id + "/pay",
      receipt(100),
    ),
    400,
    "SPLIT_REQUIRED",
  );
  const splitId = bill.splits[0].id;
  error(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + bill.id + "/pay",
      receipt(30000, { splitId }),
    ),
    409,
    "PAYMENT_AMOUNT",
  );
  const payment = receipt(10000, { splitId });
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + bill.id + "/pay",
      payment,
    ),
  );
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      ...payment,
      amountMinor: 9000,
    }),
    409,
    "REQUEST_REUSED",
  );
  const race = await Promise.all([
    post(
      f.staff.cashier,
      "/api/staff/bills/" + bill.id + "/pay",
      receipt(15000, { splitId }),
    ),
    post(
      f.staff.admin,
      "/api/staff/bills/" + bill.id + "/pay",
      receipt(15000, { splitId }),
    ),
  ]);
  assert.equal(race.filter((response) => response.status === 200).length, 1);
  assert.equal(race.filter((response) => response.status === 409).length, 1);
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/splits", {
      mode: "none",
      expectedRevision: bill.revision,
      parts: [],
    }),
    409,
    "SPLIT_LOCKED",
  );
  bill = ok(await f.staff.cashier("/api/staff/bills/" + bill.id)).bill;
  for (const part of bill.splits)
    if (part.amountMinor > part.paidMinor)
      bill = ok(
        await post(
          f.staff.cashier,
          "/api/staff/bills/" + bill.id + "/pay",
          receipt(part.amountMinor - part.paidMinor, { splitId: part.id }),
        ),
      ).bill;
  assert.equal(bill.status, "paid");
  assert.equal(
    bill.payments.reduce((sum, row) => sum + row.amountMinor, 0),
    86797,
  );
});

test("customer/item/amount splits validate all quantities and totals before any receipt", async (t) => {
  const f = await fixture(t),
    first = f.browser(),
    second = f.browser(),
    table = await f.open();
  const a = await f.order(first, table, 2),
    b = await f.order(second, table, 1);
  await f.serve(a);
  await f.serve(b);
  let bill = ok(
    await post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
  ).bill;
  bill = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/splits", {
      mode: "customer",
      expectedRevision: bill.revision,
    }),
  ).bill;
  assert.deepEqual(
    bill.splits.map((part) => part.amountMinor).sort((a, b) => a - b),
    [42000, 84000],
  );
  const [lineA, lineB] = bill.items;
  const invalid = {
    mode: "items",
    expectedRevision: bill.revision,
    parts: [
      {
        label: "One",
        lines: [
          { lineId: lineA.lineId, quantity: 2 },
          { lineId: lineB.lineId, quantity: 1 },
        ],
      },
      { label: "Two", lines: [{ lineId: lineA.lineId, quantity: 1 }] },
    ],
  };
  error(
    await post(
      f.staff.cashier,
      "/api/staff/bills/" + bill.id + "/splits",
      invalid,
    ),
    400,
    "INVALID_SPLIT",
  );
  bill = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/splits", {
      ...invalid,
      parts: [
        {
          label: "One",
          lines: [
            { lineId: lineA.lineId, quantity: 1 },
            { lineId: lineB.lineId, quantity: 1 },
          ],
        },
        { label: "Two", lines: [{ lineId: lineA.lineId, quantity: 1 }] },
      ],
    }),
  ).bill;
  assert.equal(
    bill.splits.reduce((sum, part) => sum + part.amountMinor, 0),
    bill.totalMinor,
  );
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/splits", {
      mode: "amount",
      expectedRevision: bill.revision,
      parts: [
        { label: "One", amountMinor: 100 },
        { label: "Two", amountMinor: 200 },
      ],
    }),
    400,
    "INVALID_SPLIT",
  );
  error(
    await post(f.staff.waiter, "/api/staff/bills/" + bill.id + "/splits", {
      mode: "none",
      expectedRevision: bill.revision,
    }),
    403,
    "FORBIDDEN",
  );
});

test("concurrent coupon redemption respects global limits and full discounts create zero-balance receipts", async (t) => {
  const f = await fixture(t),
    first = f.browser(),
    second = f.browser();
  await f.account(first);
  await f.account(second);
  ok(
    await post(
      f.staff.admin,
      "/api/staff/coupons",
      coupon("ONLYONE", { usageLimit: 1, kind: "fixed", value: 10000 }),
    ),
  );
  const aTable = await f.open("T01"),
    bTable = await f.open("T02"),
    a = await f.order(first, aTable),
    b = await f.order(second, bTable);
  await f.serve(a);
  await f.serve(b);
  ok(
    await post(first, "/api/table/promotions", {
      couponCode: "ONLYONE",
      loyaltyPoints: 0,
    }),
  );
  ok(
    await post(second, "/api/table/promotions", {
      couponCode: "ONLYONE",
      loyaltyPoints: 0,
    }),
  );
  const results = await Promise.all([
    post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
    post(f.staff.admin, "/api/staff/billing/T02/finalize"),
  ]);
  assert.equal(results.filter((response) => response.status === 200).length, 1);
  assert.equal(results.filter((response) => response.status === 409).length, 1);
  assert.equal(
    await f.store.couponRedemptions.countDocuments({ couponCode: "ONLYONE" }),
    1,
  );
  const freeGuest = f.browser();
  await f.account(freeGuest);
  const freeTable = await f.open("T03"),
    freeOrder = await f.order(freeGuest, freeTable);
  await f.serve(freeOrder);
  ok(
    await post(
      f.staff.admin,
      "/api/staff/coupons",
      coupon("FREEFOOD", { value: 10000 }),
    ),
  );
  ok(
    await post(freeGuest, "/api/table/promotions", {
      couponCode: "FREEFOOD",
      loyaltyPoints: 0,
    }),
  );
  const free = ok(
    await post(f.staff.cashier, "/api/staff/billing/T03/finalize"),
  ).bill;
  assert.equal(free.totalMinor, 0);
  assert.equal(free.status, "paid");
  assert.equal(free.payment.method, "discount");
  assert.equal(
    (await f.store.tables.findOne({ number: "T03" })).activeVisitId,
    null,
  );
});
