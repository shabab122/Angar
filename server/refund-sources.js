import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import { restaurantSettings } from "./restaurant.js";
import { invoiceSnapshot } from "./invoices.js";

const pending = ["requested", "approved", "processing", "unknown"];
export async function completeSourceRefund(
  store,
  refund,
  reference,
  by,
  session,
) {
  const isEvent = refund.source === "event",
    collection = isEvent ? store.events : store.gatewayTransactions;
  const source = await collection.findOneAndUpdate(
    { _id: refund.sourceId },
    { $inc: { revision: 1 } },
    { session, returnDocument: "after" },
  );
  if (!source || (!isEvent && source.status !== "overpayment_review"))
    throw new HttpError(
      409,
      "REFUND_SOURCE",
      "The original refund source is no longer available.",
    );
  const original = isEvent
    ? Math.round((source.depositReceived || 0) * 100)
    : source.amountMinor;
  const previous = isEvent
    ? source.depositRefundedMinor || 0
    : source.refundedMinor || 0;
  if (previous + refund.amountMinor > original)
    throw new HttpError(
      409,
      "REFUND_LIMIT",
      "The refund exceeds the remaining original funds.",
    );
  const at = new Date(),
    settings = await restaurantSettings(store, session);
  const creditNote = {
    number: "CN-" + refund._id.slice(2),
    kind: refund.source,
    originalReceipt: refund.receiptNo,
    amountMinor: refund.amountMinor,
    foodMinor: 0,
    chargeMinor: 0,
    taxMinor: 0,
    depositMinor: isEvent ? refund.amountMinor : 0,
    overpaymentMinor: isEvent ? 0 : refund.amountMinor,
    invoice: invoiceSnapshot(settings),
    at,
  };
  const record = {
    id: refund._id,
    amountMinor: refund.amountMinor,
    method: refund.method,
    reference,
    at,
    creditNote,
  };
  await collection.updateOne(
    { _id: source._id },
    {
      $inc: {
        [isEvent ? "depositRefundedMinor" : "refundedMinor"]:
          refund.amountMinor,
      },
      $push: { [isEvent ? "depositRefunds" : "refunds"]: record },
      ...(!isEvent
        ? {
            $set: {
              overpaymentState:
                previous + refund.amountMinor === original
                  ? "refunded"
                  : "partially_refunded",
              message:
                previous + refund.amountMinor === original
                  ? "Excess payment fully returned through a verified refund."
                  : "Part of the excess payment has been returned.",
            },
          }
        : {}),
    },
    { session },
  );
  const result = await store.refunds.findOneAndUpdate(
    { _id: refund._id },
    {
      $set: {
        status: "refunded",
        reference,
        refundedAt: at,
        completedBy: by,
        creditNote,
        message:
          "Original funds returned; no food sale or loyalty value was changed.",
      },
    },
    { session, returnDocument: "after" },
  );
  await store.audit.insertOne(
    {
      type: "source.refunded",
      source: refund.source,
      sourceId: source._id,
      refundId: refund._id,
      amountMinor: refund.amountMinor,
      by,
      at,
    },
    { session },
  );
  return result;
}

export function registerRefundSources(api, store, billingRoles, requireId) {
  api.get("/refund-sources", billingRoles, async (req, res) => {
    const [events, excess, holds] = await Promise.all([
      store.events
        .find({ depositReceived: { $gt: 0 } })
        .sort({ startsAt: -1 })
        .limit(50)
        .toArray(),
      store.gatewayTransactions
        .find({ status: "overpayment_review" })
        .sort({ verifiedAt: -1 })
        .limit(50)
        .toArray(),
      store.refunds
        .find({
          source: { $in: ["event", "overpayment"] },
          status: { $in: pending },
        })
        .toArray(),
    ]);
    const sources = [];
    for (const [kind, rows] of [
      ["event", events],
      ["overpayment", excess],
    ])
      for (const row of rows) {
        const originalMinor =
          kind === "event"
            ? Math.round(row.depositReceived * 100)
            : row.amountMinor;
        const refundedMinor =
          (kind === "event" ? row.depositRefundedMinor : row.refundedMinor) ||
          0;
        const heldMinor = holds
          .filter(
            (hold) =>
              hold.source === kind && String(hold.sourceId) === String(row._id),
          )
          .reduce((sum, hold) => sum + hold.amountMinor, 0);
        sources.push({
          source: kind,
          id: String(row._id),
          code: kind === "event" ? row.code : row._id,
          originalMinor,
          refundedMinor,
          heldMinor,
          refundableMinor: Math.max(
            0,
            originalMinor - refundedMinor - heldMinor,
          ),
          status: row.status,
          reference:
            kind === "event"
              ? row.depositReference || ""
              : row.bankTransactionId,
          canCancelEvent:
            kind === "event" &&
            row.status === "confirmed" &&
            row.startsAt > new Date(),
          startsAt: kind === "event" ? row.startsAt : null,
        });
      }
    res.json({ sources });
  });
  api.post("/refund-sources/:source/:id", billingRoles, async (req, res) => {
    const kind = req.params.source;
    if (!["event", "overpayment"].includes(kind))
      throw new HttpError(
        400,
        "REFUND_SOURCE",
        "Choose an event deposit or excess payment.",
      );
    const input = body(
      z.strictObject({
        amountMinor: z.number().int().positive().max(100000000),
        reason: z.string().trim().min(3).max(200),
        requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
        returnMethod: z.enum(["cash", "bkash", "nagad", "card"]).optional(),
        cancelEvent: z.boolean().default(false),
      }),
      req.body,
    );
    if (input.cancelEvent && (kind !== "event" || req.staff.role !== "admin"))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Only an administrator can cancel a confirmed gathering.",
      );
    if (kind === "event" && !input.returnMethod)
      throw new HttpError(
        400,
        "RETURN_METHOD",
        "Choose the verified channel used to return the event deposit.",
      );
    const id = kind === "event" ? requireId(req.params.id) : req.params.id;
    if (kind === "overpayment" && !/^[A-Za-z0-9_-]{10,64}$/.test(id))
      throw new HttpError(
        400,
        "REFUND_SOURCE",
        "Invalid original payment identifier.",
      );
    const fingerprint = hash(
      JSON.stringify({ kind, id: String(id), ...input, requestKey: undefined }),
    );
    const result = await transaction(store, async (session) => {
      const old = await store.refunds.findOne(
        { clientKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another refund request.",
          );
        return old;
      }
      if (input.cancelEvent)
        await store.eventLocks.updateOne(
          { _id: "dhanmondi-dining" },
          { $inc: { revision: 1 } },
          { upsert: true, session },
        );
      const collection =
        kind === "event" ? store.events : store.gatewayTransactions;
      const original = await collection.findOneAndUpdate(
        {
          _id: id,
          ...(kind === "overpayment"
            ? {
                status: "overpayment_review",
                bankTransactionId: { $type: "string" },
              }
            : { depositReceived: { $gt: 0 } }),
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!original)
        throw new HttpError(
          404,
          "NOT_FOUND",
          "Original verified funds not found.",
        );
      const total =
        kind === "event"
          ? Math.round(original.depositReceived * 100)
          : original.amountMinor;
      const returned =
        (kind === "event"
          ? original.depositRefundedMinor
          : original.refundedMinor) || 0;
      const holds = await store.refunds
        .find(
          { source: kind, sourceId: id, status: { $in: pending } },
          { session },
        )
        .toArray();
      if (
        input.amountMinor >
        total -
          returned -
          holds.reduce((sum, hold) => sum + hold.amountMinor, 0)
      )
        throw new HttpError(
          409,
          "REFUND_LIMIT",
          "The amount exceeds unrefunded and unreserved original funds.",
        );
      if (input.cancelEvent) {
        if (original.status !== "confirmed" || original.startsAt <= new Date())
          throw new HttpError(
            409,
            "EVENT_STATE",
            "Only a future confirmed gathering can be cancelled here.",
          );
        await store.events.updateOne(
          { _id: id },
          {
            $set: { status: "cancelled" },
            $push: {
              history: {
                status: "cancelled",
                at: new Date(),
                by: req.staff.username,
                reason: input.reason,
              },
            },
          },
          { session },
        );
      }
      const row = {
        _id: "RF" + randomBytes(12).toString("hex").toUpperCase(),
        source: kind,
        sourceId: id,
        billId: kind === "overpayment" ? original.billId : null,
        receiptNo: kind === "event" ? original.code : original._id,
        tableNumber: kind === "event" ? "Event deposit" : "Excess payment",
        paymentId: kind + ":" + id,
        method: kind === "event" ? input.returnMethod : "sslcommerz",
        amountMinor: input.amountMinor,
        reason: input.reason,
        clientKey: input.requestKey,
        fingerprint,
        status: "requested",
        requestedBy: req.staff.username,
        createdAt: new Date(),
        revision: 0,
        ...(kind === "overpayment"
          ? {
              gatewayId: original._id,
              mode: original.mode,
              merchantKey: original.merchantKey,
            }
          : {}),
      };
      await store.refunds.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "source.refund_requested",
          source: kind,
          sourceId: id,
          refundId: row._id,
          amountMinor: row.amountMinor,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res
      .status(201)
      .json({
        refund: {
          id: result._id,
          source: result.source,
          status: result.status,
          amountMinor: result.amountMinor,
        },
      });
  });
}
