import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key } from "./support.js";
import { hash } from "../server/security.js";

test("event deposit refunds reserve funds, require approval and do not alter food sales or member rewards", async (t) => {
  const f = await fixture(t),
    id = new ObjectId();
  await f.store.events.insertOne({
    _id: id,
    code: "EV-REFUND",
    depositReceived: 1000,
    depositReference: "DEP-123",
    status: "confirmed",
    startsAt: new Date(Date.now() + 86400000),
    history: [],
  });
  const endpoint = "/api/staff/refund-sources/event/" + id;
  const input = {
    amountMinor: 60000,
    reason: "Guest requested partial return",
    returnMethod: "bkash",
    requestKey: key(),
  };
  const row = ok(await post(f.staff.cashier, endpoint, input), 201).refund;
  assert.equal(
    ok(await post(f.staff.cashier, endpoint, input), 201).refund.id,
    row.id,
  );
  error(
    await post(f.staff.cashier, endpoint, {
      ...input,
      amountMinor: 40001,
      requestKey: key(),
    }),
    409,
    "REFUND_LIMIT",
  );
  error(
    await post(f.staff.cashier, "/api/staff/refunds/" + row.id + "/execute", {
      verified: true,
      reference: "RETURN-1",
    }),
    409,
    "REFUND_STATE",
  );
  ok(
    await post(f.staff.admin, "/api/staff/refunds/" + row.id + "/decision", {
      decision: "approve",
      reason: "Manager approved refund",
    }),
  );
  const refunded = ok(
    await post(f.staff.cashier, "/api/staff/refunds/" + row.id + "/execute", {
      verified: true,
      reference: "RETURN-1",
    }),
  ).refund;
  assert.equal(refunded.creditNote.depositMinor, 60000);
  assert.equal(refunded.creditNote.taxMinor, 0);
  assert.equal((await f.store.events.findOne({ _id: id })).status, "confirmed");
  assert.equal(
    (await f.store.events.findOne({ _id: id })).depositRefundedMinor,
    60000,
  );
  assert.equal(await f.store.loyaltyLedger.countDocuments({}), 0);
  assert.equal(
    ok(await f.staff.cashier("/api/staff/reports/sales")).accounting
      .refundsMinor,
    0,
  );
  error(
    await post(f.staff.cashier, endpoint, {
      ...input,
      amountMinor: 40000,
      requestKey: key(),
      cancelEvent: true,
    }),
    403,
  );
  ok(
    await post(f.staff.admin, endpoint, {
      ...input,
      amountMinor: 40000,
      requestKey: key(),
      cancelEvent: true,
    }),
    201,
  );
  assert.equal((await f.store.events.findOne({ _id: id })).status, "cancelled");
});

test("verified overpayment refunds return through the original merchant and cannot reduce the paid food invoice", async (t) => {
  const gateway = {
    mode: "sandbox",
    storeId: "extra-test",
    storePassword: "controlled-test-only",
    publicOrigin: "https://angar.example.test",
  };
  const bank = "BANK-EXCESS",
    intentId = "AKEXCESS123456789012";
  const transport = async (raw) => {
    const query = new URL(raw).searchParams;
    const data = {
      APIConnect: "DONE",
      bank_tran_id: bank,
      tran_id: intentId,
      trans_id: intentId,
      refund_ref_id:
        query.get("refund_ref_id") || "REF-" + query.get("refund_trans_id"),
      status: query.has("refund_ref_id") ? "refunded" : "success",
    };
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const f = await fixture(t, { gateway, gatewayFetch: transport }),
    guest = f.browser(),
    initial = await f.finalized(guest);
  const bill = ok(
    await post(f.staff.cashier, "/api/staff/bills/" + initial.id + "/pay", {
      method: "cash",
      reference: "",
      verified: true,
    }),
  ).bill;
  await f.store.gatewayTransactions.insertOne({
    _id: intentId,
    billId: new ObjectId(bill.id),
    clientKey: key(),
    mode: "sandbox",
    merchantKey: hash("sandbox:" + gateway.storeId),
    bankTransactionId: bank,
    status: "overpayment_review",
    amountMinor: 10000,
    verifiedAt: new Date(),
  });
  const row = ok(
    await post(
      f.staff.cashier,
      "/api/staff/refund-sources/overpayment/" + intentId,
      {
        amountMinor: 10000,
        reason: "Late excess funds returned",
        requestKey: key(),
      },
    ),
    201,
  ).refund;
  ok(
    await post(f.staff.admin, "/api/staff/refunds/" + row.id + "/decision", {
      decision: "approve",
      reason: "Original bank reference verified",
    }),
  );
  ok(
    await post(f.staff.cashier, "/api/staff/refunds/" + row.id + "/execute", {
      verified: true,
      reference: "",
    }),
  );
  assert.equal(
    (await f.store.gatewayTransactions.findOne({ _id: intentId }))
      .refundedMinor || 0,
    0,
  );
  ok(
    await post(f.staff.cashier, "/api/staff/refunds/" + row.id + "/reconcile"),
  );
  ok(
    await post(f.staff.cashier, "/api/staff/refunds/" + row.id + "/reconcile"),
  );
  const original = ok(await guest("/api/bills/" + bill.id)).bill;
  assert.equal(original.paidMinor, bill.totalMinor);
  assert.equal(original.refundedMinor, 0);
  const excess = await f.store.gatewayTransactions.findOne({ _id: intentId });
  assert.equal(excess.refundedMinor, 10000);
  assert.equal(excess.status, "overpayment_review");
  const sources = ok(
    await f.staff.cashier("/api/staff/refund-sources"),
  ).sources;
  assert.equal(sources.find((row) => row.id === intentId).refundableMinor, 0);
});
