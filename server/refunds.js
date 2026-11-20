import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction, allocateMinor } from "./money.js";
import { gatewayClient } from "./gateway.js";
import { billView } from "./bill-view.js";
import {
  completeSourceRefund,
  registerRefundSources,
} from "./refund-sources.js";

const HELD = ["requested", "approved", "processing", "unknown", "refunded"];
const reason = z.string().trim().min(3).max(200);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
export const receiptPayments = (bill) =>
  bill.payments?.length
    ? bill.payments
    : bill.payment && bill.status === "paid"
      ? [
          {
            id: "legacy",
            method: bill.payment.method,
            reference: bill.payment.reference || "",
            amountMinor: bill.totalMinor,
            at: bill.paidAt,
          },
        ]
      : [];
const view = (row) => ({
  id: row._id,
  billId: row.billId?.toString() || null,
  source: row.source || "bill",
  sourceId: row.sourceId?.toString() || null,
  receiptNo: row.receiptNo,
  tableNumber: row.tableNumber,
  paymentId: row.paymentId,
  method: row.method,
  amountMinor: row.amountMinor,
  reason: row.reason,
  status: row.status,
  requestedBy: row.requestedBy,
  approvedBy: row.approvedBy || "",
  decisionReason: row.decisionReason || "",
  createdAt: row.createdAt,
  refundedAt: row.refundedAt,
  reference: row.reference || "",
  message: row.message || "",
  providerReference: row.providerReference || "",
  creditNote: row.creditNote || null,
});

async function loyaltyRefund(store, bill, totalRefunded, refundId, session) {
  const previous = bill.loyaltyRefunds || {},
    next = { ...previous };
  const earned = await store.loyaltyLedger
    .find({ billId: bill._id, key: /^earn:/ }, { session })
    .toArray();
  for (const row of earned) {
    const customerKey = row.customerId.toString(),
      key = "earn:" + customerKey;
    const target = Math.floor((row.delta * totalRefunded) / bill.totalMinor),
      delta = target - (previous[key] || 0);
    if (delta > 0) {
      // A spent reward can leave a negative balance. Future earnings repay it;
      // redemption never spends a negative balance.
      await store.customers.updateOne(
        { _id: row.customerId },
        { $inc: { points: -delta } },
        { session },
      );
      await store.loyaltyLedger.insertOne(
        {
          key: "refund-earn:" + refundId + ":" + customerKey,
          customerId: row.customerId,
          billId: bill._id,
          delta: -delta,
          reason: "Earned points reversed after refund",
          at: new Date(),
        },
        { session },
      );
    }
    next[key] = target;
  }
  if (bill.loyaltyPoints && bill.promotionCustomerId) {
    const target = Math.floor(
        (bill.loyaltyPoints * totalRefunded) / bill.totalMinor,
      ),
      delta = target - (previous.redeemed || 0);
    if (delta > 0) {
      await store.customers.updateOne(
        { _id: bill.promotionCustomerId },
        { $inc: { points: delta } },
        { session },
      );
      await store.loyaltyLedger.insertOne(
        {
          key: "refund-redeem:" + refundId,
          customerId: bill.promotionCustomerId,
          billId: bill._id,
          delta,
          reason: "Redeemed points restored after refund",
          at: new Date(),
        },
        { session },
      );
    }
    next.redeemed = target;
  }
  if (
    totalRefunded === bill.totalMinor &&
    bill.couponCode &&
    !bill.couponRefunded
  ) {
    const redeemed = await store.couponRedemptions.findOneAndUpdate(
      { _id: bill._id, reversed: { $ne: true } },
      { $set: { reversed: true, reversedAt: new Date() } },
      { session },
    );
    if (redeemed)
      await store.coupons.updateOne(
        { _id: bill.couponCode, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1, revision: 1 } },
        { session },
      );
  }
  return next;
}

async function completeRefund(store, refundId, reference, by) {
  return transaction(store, async (session) => {
    const refund = await store.refunds.findOneAndUpdate(
      { _id: refundId },
      { $inc: { revision: 1 } },
      { session, returnDocument: "after" },
    );
    if (refund.status === "refunded") return refund;
    if (!["approved", "processing", "unknown"].includes(refund.status))
      throw new HttpError(
        409,
        "REFUND_STATE",
        "This refund is not approved or pending confirmation.",
      );
    if (["event", "overpayment"].includes(refund.source))
      return completeSourceRefund(store, refund, reference, by, session);
    const bill = await store.bills.findOneAndUpdate(
      { _id: refund.billId, status: "paid" },
      { $inc: { revision: 1 } },
      { session, returnDocument: "after" },
    );
    const refundedMinor = (bill.refundedMinor || 0) + refund.amountMinor;
    if (refundedMinor > bill.totalMinor)
      throw new HttpError(
        409,
        "REFUND_LIMIT",
        "Refunds cannot exceed the original collected amount.",
      );
    const at = new Date();
    const previousParts = bill.refundComponents || [0, 0, 0, 0];
    const originalParts = [
      bill.accountingFoodMinor ?? bill.netSubtotalMinor ?? bill.subtotalMinor,
      bill.accountingChargeMinor ?? bill.chargeMinor,
      bill.taxMinor || 0,
      bill.accountingDeliveryFeeMinor ?? bill.deliveryFeeMinor ?? 0,
    ];
    const components = allocateMinor(
      refund.amountMinor,
      originalParts.map((value, index) => value - (previousParts[index] || 0)),
    );
    const cumulative = components.map(
      (value, index) => value + (previousParts[index] || 0),
    );
    const creditNote = {
      number: "CN-" + refund._id.slice(2),
      originalReceipt: bill.receiptNo,
      amountMinor: refund.amountMinor,
      foodMinor: components[0],
      chargeMinor: components[1],
      taxMinor: components[2],
      deliveryFeeMinor: components[3],
      invoice: bill.invoice || null,
      taxLabel: bill.taxLabel || "VAT",
      at,
    };
    const loyaltyRefunds = await loyaltyRefund(
      store,
      bill,
      refundedMinor,
      refundId,
      session,
    );
    await store.bills.updateOne(
      { _id: bill._id },
      {
        $set: {
          refundedMinor,
          refundComponents: cumulative,
          loyaltyRefunds,
          ...(refundedMinor === bill.totalMinor
            ? { couponRefunded: true }
            : {}),
        },
        $push: {
          refunds: {
            id: refund._id,
            amountMinor: refund.amountMinor,
            paymentId: refund.paymentId,
            method: refund.method,
            at,
            creditNote,
          },
        },
      },
      { session },
    );
    const result = await store.refunds.findOneAndUpdate(
      { _id: refundId },
      {
        $set: {
          status: "refunded",
          reference,
          refundedAt: at,
          completedBy: by,
          creditNote,
          message: "Refund confirmed and credit note issued.",
        },
      },
      { session, returnDocument: "after" },
    );
    await store.audit.insertOne(
      {
        type: "bill.refunded",
        billId: bill._id,
        refundId,
        amountMinor: refund.amountMinor,
        by,
        at,
      },
      { session },
    );
    return result;
  });
}

function checkMerchant(config, intent) {
  const client = gatewayClient(config);
  if (
    !client.ready ||
    !intent ||
    intent.mode !== client.mode ||
    intent.merchantKey !== hash(client.mode + ":" + config.gateway.storeId)
  )
    throw new HttpError(
      409,
      "GATEWAY_ACCOUNT",
      "Restore the original gateway mode and merchant credentials to refund this payment.",
    );
  return client;
}
function providerMatch(data, intent, refund) {
  return (
    data.APIConnect === "DONE" &&
    data.bank_tran_id === intent.bankTransactionId &&
    (data.tran_id || data.trans_id) === intent._id &&
    typeof data.refund_ref_id === "string" &&
    data.refund_ref_id.length > 0 &&
    data.refund_ref_id.length <= 100 &&
    (!refund.providerReference ||
      refund.providerReference === data.refund_ref_id)
  );
}
async function queryRefund(store, config, refund, intent, by) {
  const client = checkMerchant(config, intent);
  if (!refund.providerReference) return refund;
  const data = await client.refundStatus(refund.providerReference);
  if (!providerMatch(data, intent, refund))
    throw new HttpError(
      409,
      "REFUND_MISMATCH",
      "The provider did not confirm the original payment and refund reference.",
    );
  if (data.status === "refunded")
    return completeRefund(store, refund._id, data.refund_ref_id, by);
  if (["cancelled", "failed"].includes(data.status)) {
    await store.refunds.updateOne(
      { _id: refund._id, status: { $ne: "refunded" } },
      {
        $set: {
          status: "failed",
          message: "Provider confirmed the refund did not complete.",
          updatedAt: new Date(),
        },
      },
    );
  }
  return store.refunds.findOne({ _id: refund._id });
}

export function registerRefunds(
  api,
  store,
  config,
  billingRoles,
  requireAdmin,
  requireId,
) {
  registerRefundSources(api, store, billingRoles, requireId);
  api.get("/refunds", billingRoles, async (req, res) => {
    const query = String(req.query.receipt || "").trim();
    const filter = query ? { receiptNo: query } : {};
    const refunds = await store.refunds
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const bills = await store.bills
      .find({ status: "paid", ...(query ? { receiptNo: query } : {}) })
      .sort({ paidAt: -1 })
      .limit(50)
      .toArray();
    const held = await store.refunds
      .find({
        billId: { $in: bills.map((bill) => bill._id) },
        status: { $in: HELD },
      })
      .toArray();
    res.json({
      refunds: refunds.map(view),
      bills: bills.map((bill) => ({
        ...billView(bill),
        payments: receiptPayments(bill).map((payment) => ({
          ...billView(bill).payments.find((p) => p.id === payment.id),
          id: payment.id,
          method: payment.method,
          amountMinor: payment.amountMinor,
          refundableMinor: Math.max(
            0,
            payment.amountMinor -
              held
                .filter(
                  (row) =>
                    row.billId.equals(bill._id) && row.paymentId === payment.id,
                )
                .reduce((sum, row) => sum + row.amountMinor, 0),
          ),
        })),
      })),
    });
  });
  api.post("/bills/:id/refunds", billingRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        paymentId: z.string().min(1).max(64),
        amountMinor: z.number().int().positive().max(100000000),
        reason,
        requestKey: identifier,
      }),
      req.body,
    );
    const id = requireId(req.params.id),
      fingerprint = hash(
        JSON.stringify({
          billId: id.toString(),
          paymentId: input.paymentId,
          amountMinor: input.amountMinor,
          reason: input.reason,
        }),
      );
    const result = await transaction(store, async (session) => {
      const bill = await store.bills.findOneAndUpdate(
        { _id: id, status: "paid" },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!bill)
        throw new HttpError(
          409,
          "BILL_NOT_PAID",
          "Refunds require a fully settled bill.",
        );
      const previous = await store.refunds.findOne(
        { clientKey: input.requestKey },
        { session },
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to a different refund request.",
          );
        return previous;
      }
      const payment = receiptPayments(bill).find(
        (payment) => payment.id === input.paymentId,
      );
      if (!payment)
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This receipt payment could not be found.",
        );
      const held = await store.refunds
        .find(
          { billId: id, paymentId: payment.id, status: { $in: HELD } },
          { session },
        )
        .toArray();
      if (
        held.reduce((sum, row) => sum + row.amountMinor, 0) +
          input.amountMinor >
        payment.amountMinor
      )
        throw new HttpError(
          409,
          "REFUND_LIMIT",
          "This amount exceeds the unrefunded and unreserved payment balance.",
        );
      if (
        (await store.refunds.countDocuments({ billId: id }, { session })) >= 100
      )
        throw new HttpError(
          409,
          "REFUND_LIMIT",
          "This bill reached its refund request limit.",
        );
      const gateway =
        payment.method === "sslcommerz"
          ? await store.gatewayTransactions.findOne(
              { _id: payment.key?.replace(/^ssl:/, "") },
              { session },
            )
          : null;
      if (payment.method === "sslcommerz" && !gateway)
        throw new HttpError(
          409,
          "GATEWAY_ACCOUNT",
          "The original online transaction is unavailable for automated refund.",
        );
      const refund = {
        _id: "RF" + randomBytes(12).toString("hex").toUpperCase(),
        billId: id,
        paymentId: payment.id,
        receiptNo: bill.receiptNo,
        tableNumber: bill.tableNumber,
        method: payment.method,
        amountMinor: input.amountMinor,
        reason: input.reason,
        clientKey: input.requestKey,
        fingerprint,
        status: "requested",
        requestedBy: req.staff.username,
        createdAt: new Date(),
        revision: 0,
        ...(gateway
          ? {
              gatewayId: gateway._id,
              mode: gateway.mode,
              merchantKey: gateway.merchantKey,
            }
          : {}),
      };
      await store.refunds.insertOne(refund, { session });
      await store.audit.insertOne(
        {
          type: "refund.requested",
          refundId: refund._id,
          billId: id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return refund;
    });
    res.status(201).json({ refund: view(result) });
  });
  api.post("/refunds/:id/decision", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({ decision: z.enum(["approve", "reject"]), reason }),
      req.body,
    );
    const result = await transaction(store, async (session) => {
      const row = await store.refunds.findOne(
        { _id: req.params.id },
        { session },
      );
      if (!row) throw new HttpError(404, "NOT_FOUND", "Refund not found.");
      const status = input.decision === "approve" ? "approved" : "rejected";
      if (row.status === status) return row;
      if (row.status !== "requested")
        throw new HttpError(
          409,
          "REFUND_STATE",
          "This request has already been decided.",
        );
      await store.bills.updateOne(
        { _id: row.billId },
        { $inc: { revision: 1 } },
        { session },
      );
      const result = await store.refunds.findOneAndUpdate(
        { _id: row._id, status: "requested" },
        {
          $set: {
            status,
            approvedBy: req.staff.username,
            decisionReason: input.reason,
            decidedAt: new Date(),
          },
        },
        { session, returnDocument: "after" },
      );
      await store.audit.insertOne(
        {
          type: "refund." + status,
          refundId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return result;
    });
    res.json({ refund: view(result) });
  });
  api.post("/refunds/:id/execute", billingRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        verified: z.literal(true),
        reference: z.string().trim().max(100).default(""),
      }),
      req.body,
    );
    let refund = await store.refunds.findOne({ _id: req.params.id });
    if (!refund) throw new HttpError(404, "NOT_FOUND", "Refund not found.");
    if (refund.status === "refunded") return res.json({ refund: view(refund) });
    if (refund.method !== "sslcommerz") {
      if (refund.status !== "approved")
        throw new HttpError(
          409,
          "REFUND_STATE",
          "Ask an administrator to approve this refund first.",
        );
      if (refund.method !== "cash" && input.reference.length < 3)
        throw new HttpError(
          400,
          "REFERENCE_REQUIRED",
          "Enter the verified return-payment reference.",
        );
      return res.json({
        refund: view(
          await completeRefund(
            store,
            refund._id,
            input.reference,
            req.staff.username,
          ),
        ),
      });
    }
    const intent = await store.gatewayTransactions.findOne({
      _id: refund.gatewayId,
    });
    const client = checkMerchant(config, intent);
    if (refund.providerReference)
      return res.json({
        refund: view(
          await queryRefund(store, config, refund, intent, req.staff.username),
        ),
      });
    // Only one caller initiates/retries the same provider refund identifier.
    const claimed = await store.refunds.findOneAndUpdate(
      {
        _id: refund._id,
        $or: [
          { status: { $in: ["approved", "unknown"] } },
          {
            status: "processing",
            providerReference: { $exists: false },
            updatedAt: { $lt: new Date(Date.now() - 60000) },
          },
        ],
      },
      { $set: { status: "processing", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!claimed)
      throw new HttpError(
        409,
        "REFUND_STATE",
        "The refund is being processed or needs administrator approval.",
      );
    try {
      const data = await client.refund({
        bank_tran_id: intent.bankTransactionId,
        refund_trans_id: refund._id,
        refund_amount: (refund.amountMinor / 100).toFixed(2),
        refund_remarks: refund.reason,
        refe_id: refund._id,
        v: "1",
        format: "json",
      });
      if (data.APIConnect === "DONE" && data.status === "failed") {
        await store.refunds.updateOne(
          { _id: refund._id, status: "processing" },
          {
            $set: {
              status: "failed",
              message: "Provider rejected this refund request.",
            },
          },
        );
      } else if (
        providerMatch(data, intent, refund) &&
        ["success", "processing"].includes(data.status)
      ) {
        await store.refunds.updateOne(
          { _id: refund._id, status: "processing" },
          {
            $set: {
              providerReference: data.refund_ref_id,
              message:
                "Refund submitted. Recheck provider until it confirms refunded.",
            },
          },
        );
      } else
        throw new HttpError(
          409,
          "REFUND_MISMATCH",
          "Provider did not confirm the refund. Its amount remains reserved.",
        );
    } catch (error) {
      await store.refunds.updateOne(
        {
          _id: refund._id,
          status: "processing",
          providerReference: { $exists: false },
        },
        {
          $set: {
            status: "unknown",
            message:
              "Provider result is uncertain. Recover using this same refund request; do not create a second refund.",
          },
        },
      );
      throw error;
    }
    refund = await store.refunds.findOne({ _id: refund._id });
    res.json({ refund: view(refund) });
  });
  api.post("/refunds/:id/reconcile", billingRoles, async (req, res) => {
    const refund = await store.refunds.findOne({ _id: req.params.id });
    if (!refund) throw new HttpError(404, "NOT_FOUND", "Refund not found.");
    if (refund.method !== "sslcommerz" || refund.status === "refunded")
      return res.json({ refund: view(refund) });
    const intent = await store.gatewayTransactions.findOne({
      _id: refund.gatewayId,
    });
    res.json({
      refund: view(
        await queryRefund(store, config, refund, intent, req.staff.username),
      ),
    });
  });
}
