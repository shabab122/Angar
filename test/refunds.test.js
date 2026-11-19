import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key } from "./support.js";

async function settled(f, guest) {
  const bill = await f.finalized(guest);
  return ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      reference: "",
      verified: true,
    }),
  ).bill;
}
const request = (f, bill, amount, requestKey = key()) =>
  post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/refunds", {
    paymentId: bill.payments[0].id,
    amountMinor: amount,
    reason: "Customer returned the purchase",
    requestKey,
  });
const approve = (f, refund) =>
  post(f.staff.admin, "/api/staff/refunds/" + refund.id + "/decision", {
    decision: "approve",
    reason: "Return confirmed by manager",
  });
const execute = (f, refund) =>
  post(f.staff.cashier, "/api/staff/refunds/" + refund.id + "/execute", {
    verified: true,
    reference: "RETURN-123",
  });

test("refunds require approval, serialize receipt limits and never reopen the original visit", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    bill = await settled(f, guest),
    retryKey = key();
  const refund = ok(await request(f, bill, 50000, retryKey), 201).refund;
  assert.equal(
    ok(await request(f, bill, 50000, retryKey), 201).refund.id,
    refund.id,
  );
  error(await request(f, bill, 50001, retryKey), 409, "REQUEST_REUSED");
  error(await execute(f, refund), 409, "REFUND_STATE");
  error(
    await post(
      f.staff.cashier,
      "/api/staff/refunds/" + refund.id + "/decision",
      { decision: "approve", reason: "Not permitted" },
    ),
    403,
  );
  const concurrent = await Promise.all([
    request(f, bill, 34000),
    request(f, bill, 34000),
  ]);
  assert.equal(concurrent.filter((row) => row.status === 201).length, 1);
  assert.equal(concurrent.filter((row) => row.status === 409).length, 1);
  const second = concurrent.find((row) => row.status === 201).data.refund;
  ok(await approve(f, refund));
  ok(await approve(f, second));
  ok(await execute(f, refund));
  ok(await execute(f, refund));
  ok(await execute(f, second));
  const final = ok(await guest("/api/bills/" + bill.id)).bill;
  assert.equal(final.status, "paid");
  assert.equal(final.refundedMinor, 84000);
  assert.equal(final.netCollectedMinor, 0);
  assert.equal(final.refunds.length, 2);
  assert.equal(final.balanceMinor, 0);
  assert.equal(final.totalMinor, bill.totalMinor);
  assert.equal(
    (await f.store.tables.findOne({ number: "T01" })).activeVisitId,
    null,
  );
  assert.equal(
    await f.store.audit.countDocuments({ type: "bill.refunded" }),
    2,
  );
});

test("full refunds restore redeemed points and coupon capacity and reverse earned points exactly once", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    customer = await f.account(guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(customer.id) },
    { $set: { points: 40 } },
  );
  ok(
    await post(f.staff.admin, "/api/staff/coupons", {
      code: "RETURN10",
      kind: "percent",
      value: 1000,
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
  const table = await f.open(),
    order = await f.order(guest, table);
  await f.serve(order);
  ok(
    await post(guest, "/api/table/promotions", {
      couponCode: "RETURN10",
      loyaltyPoints: 10,
    }),
  );
  const initial = ok(
    await post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
  ).bill;
  const bill = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + initial.id + "/pay", {
      method: "cash",
      reference: "",
      verified: true,
    }),
  ).bill;
  assert.equal(ok(await guest("/api/account")).customer.points, 37);
  const first = ok(await request(f, bill, 30000), 201).refund;
  ok(await approve(f, first));
  ok(await execute(f, first));
  assert.equal(
    (await f.store.coupons.findOne({ _id: "RETURN10" })).usedCount,
    1,
  );
  const second = ok(
    await request(f, bill, bill.totalMinor - 30000),
    201,
  ).refund;
  ok(await approve(f, second));
  ok(await execute(f, second));
  ok(await execute(f, second));
  assert.equal(ok(await guest("/api/account")).customer.points, 40);
  assert.equal(
    (await f.store.coupons.findOne({ _id: "RETURN10" })).usedCount,
    0,
  );
  assert.equal(
    (await f.store.couponRedemptions.findOne({ _id: new ObjectId(bill.id) }))
      .reversed,
    true,
  );
});

test("rejected requests release their reservation; spent refunded rewards become a visible debt", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    customer = await f.account(guest),
    bill = await settled(f, guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(customer.id) },
    { $set: { points: 0 } },
  );
  const rejected = ok(await request(f, bill, bill.totalMinor), 201).refund;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/refunds/" + rejected.id + "/decision",
      { decision: "reject", reason: "Incorrect original request" },
    ),
  );
  const refund = ok(await request(f, bill, bill.totalMinor), 201).refund;
  ok(await approve(f, refund));
  ok(await execute(f, refund));
  assert.equal(ok(await guest("/api/account")).customer.points, -8);
});

test("online refunds only adjust ledgers after provider confirmation and duplicate reconciliation is harmless", async (t) => {
  const records = new Map(),
    validations = new Map(),
    refunds = new Map();
  let confirmed = false,
    wrong = false,
    initCalls = 0;
  let loseResponse = true;
  const settings = {
    mode: "sandbox",
    storeId: "refund-test",
    storePassword: "fake-test-only",
    publicOrigin: "https://angar.example.test",
  };
  const transport = async (raw, options) => {
    const url = new URL(raw),
      fields =
        options.method === "POST"
          ? new URLSearchParams(options.body)
          : url.searchParams;
    let data;
    if (url.pathname.endsWith("/gwprocess/v4/api.php")) {
      const id = fields.get("tran_id");
      records.set(id, {
        tran_id: id,
        amount: fields.get("total_amount"),
        currency: "BDT",
        currency_type: "BDT",
        bank_tran_id: "BANK-" + id,
        status: "VALID",
        risk_level: "0",
        val_id: "VAL-" + id,
      });
      validations.set("VAL-" + id, records.get(id));
      data = {
        status: "SUCCESS",
        sessionkey: "SESSION",
        GatewayPageURL: "https://sandbox.sslcommerz.com/checkout/" + id,
      };
    } else if (url.pathname.endsWith("validationserverAPI.php"))
      data = validations.get(fields.get("val_id"));
    else if (fields.has("refund_trans_id")) {
      initCalls++;
      const payment = [...records.values()].find(
        (row) => row.bank_tran_id === fields.get("bank_tran_id"),
      );
      data = {
        APIConnect: "DONE",
        bank_tran_id: payment.bank_tran_id,
        trans_id: payment.tran_id,
        refund_ref_id: "REF-" + fields.get("refund_trans_id"),
        status: "success",
      };
      refunds.set(data.refund_ref_id, data);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("simulated response lost after provider acceptance");
      }
    } else if (fields.has("refund_ref_id")) {
      const prior = refunds.get(fields.get("refund_ref_id"));
      data = {
        ...prior,
        tran_id: wrong ? "OTHER" : prior.trans_id,
        status: confirmed ? "refunded" : "processing",
      };
    } else
      data = {
        APIConnect: "DONE",
        element: [records.get(fields.get("tran_id"))],
      };
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const f = await fixture(t, { gateway: settings, gatewayFetch: transport }),
    guest = f.browser(),
    initial = await f.finalized(guest);
  const online = ok(
    await post(guest, "/api/bills/" + initial.id + "/online-payments", {
      amountMinor: initial.totalMinor,
      requestKey: key(),
      name: "Refund Member",
      email: "refund@example.test",
      phone: "01700000000",
      consent: true,
    }),
    201,
  ).transaction;
  const ipn = await guest("/api/payments/sslcommerz/ipn", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    raw: new URLSearchParams({
      tran_id: online.id,
      val_id: "VAL-" + online.id,
    }).toString(),
  });
  ok(ipn);
  const bill = ok(await guest("/api/bills/" + initial.id)).bill,
    refund = ok(await request(f, bill, 30000), 201).refund;
  ok(await approve(f, refund));
  error(await execute(f, refund), 503, "GATEWAY_UNAVAILABLE");
  assert.equal(
    (await f.store.refunds.findOne({ _id: refund.id })).status,
    "unknown",
  );
  ok(await execute(f, refund));
  assert.equal(initCalls, 2);
  assert.equal(refunds.size, 1);
  const recheck = () =>
    post(f.staff.cashier, "/api/staff/refunds/" + refund.id + "/reconcile");
  assert.equal(ok(await recheck()).refund.status, "processing");
  assert.equal(ok(await guest("/api/bills/" + bill.id)).bill.refundedMinor, 0);
  wrong = true;
  error(await recheck(), 409, "REFUND_MISMATCH");
  wrong = false;
  confirmed = true;
  assert.equal(ok(await recheck()).refund.status, "refunded");
  ok(await recheck());
  ok(await execute(f, refund));
  assert.equal(
    ok(await guest("/api/bills/" + bill.id)).bill.refundedMinor,
    30000,
  );
  assert.equal(initCalls, 2);
  assert.equal(refunds.size, 1);
});
