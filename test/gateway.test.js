import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, key, ok, error, post } from "./support.js";

function provider() {
  const records = new Map(),
    validations = new Map(),
    requests = [];
  const settings = {
    mode: "sandbox",
    storeId: "isolated-store",
    storePassword: "isolated-gateway-secret",
    publicOrigin: "https://angar-callback.example.test",
  };
  const fetch = async (raw, options) => {
    const url = new URL(raw),
      fields =
        options.method === "POST"
          ? new URLSearchParams(options.body)
          : url.searchParams;
    requests.push({ path: url.pathname, fields });
    assert.equal(fields.get("store_id"), settings.storeId);
    assert.equal(fields.get("store_passwd"), settings.storePassword);
    let result;
    if (url.pathname.endsWith("/gwprocess/v4/api.php")) {
      const id = fields.get("tran_id");
      records.set(id, {
        tran_id: id,
        amount: fields.get("total_amount"),
        currency: "BDT",
        currency_type: "BDT",
        status: "PENDING",
        risk_level: "0",
        bank_tran_id: "BANK-" + id,
      });
      result = {
        status: "SUCCESS",
        sessionkey: "SESSION-" + id,
        GatewayPageURL: "https://sandbox.sslcommerz.com/checkout/" + id,
      };
    } else if (url.pathname.endsWith("validationserverAPI.php"))
      result = validations.get(fields.get("val_id")) || {
        status: "INVALID_TRANSACTION",
      };
    else {
      const row = records.get(fields.get("tran_id"));
      result = {
        APIConnect: "DONE",
        no_of_trans_found: row ? 1 : 0,
        element: row ? [row] : [],
      };
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const mark = (id, values = {}) => {
    const row = {
      ...records.get(id),
      status: "VALID",
      val_id: "VAL-" + id,
      card_no: "4111111111111111",
      ...values,
    };
    records.set(id, row);
    validations.set(row.val_id, row);
    return row;
  };
  return { settings, fetch, records, mark, requests };
}
const start = (guest, bill, amountMinor = bill.totalMinor) =>
  post(guest, "/api/bills/" + bill.id + "/online-payments", {
    requestKey: key(),
    amountMinor,
    name: "Test Guest",
    email: "guest@example.test",
    phone: "01700000000",
    consent: true,
  });
const ipn = (client, id, valId, status = "VALID") =>
  client("/api/payments/sslcommerz/ipn", {
    method: "POST",
    raw: new URLSearchParams({ tran_id: id, val_id: valId, status }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

test("verified IPNs credit exactly once; held online amounts cannot also be paid at the counter", async (t) => {
  const p = provider(),
    f = await fixture(t, { gateway: p.settings, gatewayFetch: p.fetch }),
    guest = f.browser(),
    stranger = f.browser();
  const bill = await f.finalized(guest),
    intent = ok(await start(guest, bill), 201).transaction;
  assert.equal(intent.status, "pending");
  assert.match(intent.checkoutUrl, /^https:\/\/sandbox\.sslcommerz\.com/);
  const held = ok(await f.staff.cashier("/api/staff/bills/" + bill.id)).bill;
  assert.equal(held.reservedMinor, bill.totalMinor);
  assert.equal(held.availableMinor, 0);
  error(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      reference: "",
      verified: true,
    }),
    409,
    "PAYMENT_AMOUNT",
  );
  error(await stranger("/api/online-payments/" + intent.id), 404, "NOT_FOUND");
  error(await ipn(stranger, intent.id, "UNVERIFIED"), 409, "PAYMENT_MISMATCH");
  assert.equal(
    (await f.store.bills.findOne({ receiptNo: bill.receiptNo })).paidMinor,
    0,
  );
  const success = p.mark(intent.id);
  const duplicated = await Promise.all([
    ipn(stranger, intent.id, success.val_id),
    ipn(stranger, intent.id, success.val_id),
  ]);
  duplicated.forEach((response) => ok(response));
  const paid = ok(await guest("/api/bills/" + bill.id)).bill;
  assert.equal(paid.status, "paid");
  assert.equal(paid.payments.length, 1);
  assert.equal(paid.balanceMinor, 0);
  assert.equal(paid.reservedMinor, 0);
  assert.equal(await f.store.audit.countDocuments({ type: "bill.receipt" }), 1);
  const stored = await f.store.gatewayTransactions.findOne({ _id: intent.id });
  assert.equal(stored.bankTransactionId, success.bank_tran_id);
  assert.ok(!JSON.stringify(stored).includes("4111111111111111"));
  assert.ok(!JSON.stringify(stored).includes(p.settings.storePassword));
});

test("wrong amounts/currencies and browser failures cannot create credits or release pending funds", async (t) => {
  const p = provider(),
    f = await fixture(t, { gateway: p.settings, gatewayFetch: p.fetch }),
    guest = f.browser();
  const bill = await f.finalized(guest),
    intent = ok(await start(guest, bill, 20000), 201).transaction;
  const invalid = p.mark(intent.id, { amount: "1.00" });
  error(await ipn(guest, intent.id, invalid.val_id), 409, "PAYMENT_MISMATCH");
  const currency = p.mark(intent.id, { amount: "200.00", currency: "USD" });
  error(await ipn(guest, intent.id, currency.val_id), 409, "PAYMENT_MISMATCH");
  p.records.set(intent.id, { ...p.records.get(intent.id), status: "PENDING" });
  const cancel = await guest(
    "/api/payments/sslcommerz/return/" + intent.id + "?status=CANCELLED",
  );
  assert.equal(cancel.status, 303);
  assert.equal(
    ok(await guest("/api/bills/" + bill.id)).bill.reservedMinor,
    20000,
  );
  p.records.set(intent.id, { ...p.records.get(intent.id), status: "FAILED" });
  const reconciled = ok(
    await post(
      f.staff.cashier,
      "/api/staff/online-payments/" + intent.id + "/reconcile",
    ),
  ).transaction;
  assert.equal(reconciled.status, "failed");
  const balance = ok(await guest("/api/bills/" + bill.id)).bill;
  assert.equal(balance.reservedMinor, 0);
  assert.equal(balance.paidMinor, 0);
});

test("provider risk flags require admin review and repeated reconciliation cannot duplicate a payment", async (t) => {
  const p = provider(),
    f = await fixture(t, { gateway: p.settings, gatewayFetch: p.fetch }),
    guest = f.browser();
  const bill = await f.finalized(guest),
    intent = ok(await start(guest, bill), 201).transaction;
  const risk = p.mark(intent.id, { risk_level: "1" });
  ok(await ipn(guest, intent.id, risk.val_id));
  assert.equal(
    ok(await guest("/api/online-payments/" + intent.id)).transaction.status,
    "review",
  );
  assert.equal(ok(await guest("/api/bills/" + bill.id)).bill.paidMinor, 0);
  error(
    await post(
      f.staff.cashier,
      "/api/staff/online-payments/" + intent.id + "/approve-risk",
      { reason: "Customer verified" },
    ),
    403,
    "FORBIDDEN",
  );
  const reviewed = ok(
    await post(
      f.staff.admin,
      "/api/staff/online-payments/" + intent.id + "/approve-risk",
      { reason: "Customer and receipt verified with merchant" },
    ),
  ).transaction;
  assert.equal(reviewed.status, "paid");
  ok(await post(guest, "/api/online-payments/" + intent.id + "/reconcile"));
  assert.equal(
    ok(await guest("/api/bills/" + bill.id)).bill.payments.length,
    1,
  );
});

test("unconfigured gateways fail explicitly and no merchant secret is exposed by public options", async (t) => {
  const f = await fixture(t, {
      gateway: {
        mode: "sandbox",
        storeId: "",
        storePassword: "",
        publicOrigin: "",
      },
    }),
    guest = f.browser();
  const bill = await f.finalized(guest);
  const options = ok(await guest("/api/payments/options"));
  assert.equal(options.enabled, false);
  assert.equal(options.storePassword, undefined);
  error(await start(guest, bill), 503, "GATEWAY_SETUP");
  assert.equal(await f.store.gatewayTransactions.countDocuments({}), 0);
});

test("checkout retry creates one provider session and another table participant cannot open its payment link", async (t) => {
  const p = provider(),
    f = await fixture(t, { gateway: p.settings, gatewayFetch: p.fetch });
  const first = f.browser(),
    second = f.browser(),
    table = await f.open();
  const firstOrder = await f.order(first, table, 1),
    secondOrder = await f.order(second, table, 1);
  await f.serve(firstOrder);
  await f.serve(secondOrder);
  const bill = ok(
    await post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
  ).bill;
  const input = {
    requestKey: key(),
    amountMinor: 20000,
    name: "Payer",
    email: "payer@example.test",
    phone: "01700000000",
    consent: true,
  };
  const initial = ok(
    await post(first, "/api/bills/" + bill.id + "/online-payments", input),
    201,
  ).transaction;
  const retry = ok(
    await post(first, "/api/bills/" + bill.id + "/online-payments", input),
  ).transaction;
  assert.equal(retry.id, initial.id);
  assert.equal(
    p.requests.filter((request) =>
      request.path.endsWith("/gwprocess/v4/api.php"),
    ).length,
    1,
  );
  error(
    await post(first, "/api/bills/" + bill.id + "/online-payments", {
      ...input,
      amountMinor: 10000,
    }),
    409,
    "REQUEST_REUSED",
  );
  ok(await second("/api/bills/" + bill.id));
  error(await second("/api/online-payments/" + initial.id), 404, "NOT_FOUND");
  assert.equal(
    ok(await first("/api/bills/" + bill.id)).bill.reservedMinor,
    20000,
  );
});

test("unconfirmed checkout creation keeps its hold, while authoritative creation rejection releases it", async (t) => {
  const p = provider();
  let mode = "timeout";
  const transport = async (url, options) => {
    if (new URL(url).pathname.endsWith("/gwprocess/v4/api.php")) {
      if (mode === "timeout")
        throw new Error("simulated transport interruption");
      return new Response(JSON.stringify({ status: "FAILED" }), {
        status: 200,
      });
    }
    return p.fetch(url, options);
  };
  const f = await fixture(t, { gateway: p.settings, gatewayFetch: transport }),
    guest = f.browser();
  const firstBill = await f.finalized(guest, "T01");
  error(await start(guest, firstBill, 10000), 503, "GATEWAY_UNAVAILABLE");
  assert.equal(
    ok(await guest("/api/bills/" + firstBill.id)).bill.reservedMinor,
    10000,
  );
  assert.equal(
    (
      await f.store.gatewayTransactions.findOne({
        billId: (
          await f.store.bills.findOne({ receiptNo: firstBill.receiptNo })
        )._id,
      })
    ).status,
    "unknown",
  );
  mode = "rejected";
  const secondBill = await f.finalized(guest, "T02");
  error(await start(guest, secondBill, 10000), 502, "GATEWAY_REJECTED");
  assert.equal(
    ok(await guest("/api/bills/" + secondBill.id)).bill.reservedMinor,
    0,
  );
});

test("a late verified payment after a released failure is retained for overpayment review", async (t) => {
  const p = provider(),
    f = await fixture(t, { gateway: p.settings, gatewayFetch: p.fetch }),
    guest = f.browser();
  const bill = await f.finalized(guest),
    attempt = ok(await start(guest, bill), 201).transaction;
  p.records.set(attempt.id, { ...p.records.get(attempt.id), status: "FAILED" });
  ok(
    await post(
      f.staff.cashier,
      "/api/staff/online-payments/" + attempt.id + "/reconcile",
    ),
  );
  const cash = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      reference: "",
      verified: true,
    }),
  ).bill;
  assert.equal(cash.status, "paid");
  const late = p.mark(attempt.id);
  ok(await ipn(guest, attempt.id, late.val_id));
  assert.equal(
    ok(await guest("/api/online-payments/" + attempt.id)).transaction.status,
    "overpayment_review",
  );
  const final = ok(await guest("/api/bills/" + bill.id)).bill;
  assert.equal(final.balanceMinor, 0);
  assert.equal(final.payments.length, 1);
  assert.equal(final.payment.method, "cash");
});

test("one bank transaction cannot credit two bills and a rejected reuse rolls back the second receipt", async (t) => {
  const p = provider(),
    f = await fixture(t, { gateway: p.settings, gatewayFetch: p.fetch }),
    guest = f.browser();
  const firstBill = await f.finalized(guest, "T01"),
    first = ok(await start(guest, firstBill), 201).transaction;
  const confirmed = p.mark(first.id);
  ok(await ipn(guest, first.id, confirmed.val_id));
  const secondBill = await f.finalized(guest, "T02"),
    second = ok(await start(guest, secondBill), 201).transaction;
  const reused = p.mark(second.id, { bank_tran_id: confirmed.bank_tran_id });
  error(await ipn(guest, second.id, reused.val_id), 409, "PAYMENT_REUSED");
  const uncredited = ok(await guest("/api/bills/" + secondBill.id)).bill;
  assert.equal(uncredited.paidMinor, 0);
  assert.equal(uncredited.payments.length, 0);
  assert.equal(uncredited.reservedMinor, secondBill.totalMinor);
  assert.equal(await f.store.audit.countDocuments({ type: "bill.receipt" }), 1);
  assert.ok((await f.store.tables.findOne({ number: "T02" })).activeVisitId);
});
