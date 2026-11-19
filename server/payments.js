import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import {
  allocateMinor,
  heldMinor,
  paidMinor,
  remainingMinor,
  transaction,
} from "./money.js";
import { billView } from "./bill-view.js";
import { awardLoyalty } from "./rewards.js";

export async function finishBill(store, bill, session, now = new Date()) {
  const methods = [
    ...new Set((bill.payments || []).map((payment) => payment.method)),
  ];
  const payment =
    methods.length === 1
      ? { method: methods[0], reference: bill.payments?.[0]?.reference || "" }
      : {
          method: methods.length ? "mixed" : "discount",
          reference: methods.length
            ? "Multiple verified payments"
            : "Fully discounted bill",
        };
  await store.bills.updateOne(
    { _id: bill._id },
    {
      $set: {
        status: "paid",
        paidAt: now,
        payment,
        paidMinor: bill.totalMinor,
      },
    },
    { session },
  );
  const table = await store.tables.findOneAndUpdate(
    { _id: bill.tableId, activeVisitId: bill.visitId, billId: bill._id },
    {
      $set: {
        activeVisitId: null,
        openedAt: null,
        billingState: "open",
        lastBillId: bill._id,
        promotion: null,
      },
      $unset: { billId: "", reservationId: "", waitlistId: "" },
      $inc: { revision: 1 },
    },
    { session, returnDocument: "before" },
  );
  if (!table)
    throw new HttpError(
      409,
      "TABLE_CHANGED",
      "The table visit changed. Refresh before recording payment.",
    );
  if (table.reservationId)
    await store.reservations.updateOne(
      { _id: table.reservationId, status: "seated" },
      { $set: { status: "completed", completedAt: now } },
      { session },
    );
  await store.serviceRequests.updateMany(
    { tableId: bill.tableId, visitId: bill.visitId, status: "open" },
    { $set: { status: "resolved", resolvedAt: now, resolvedBy: "billing" } },
    { session },
  );
  await awardLoyalty(store, bill, session);
  await store.audit.insertOne(
    { type: "bill.paid", billId: bill._id, method: payment.method, at: now },
    { session },
  );
  return {
    ...bill,
    status: "paid",
    paidAt: now,
    payment,
    paidMinor: bill.totalMinor,
  };
}

// Called only after a cash receipt is confirmed or gateway verification succeeds.
export async function appendPayment(store, bill, input, session) {
  const prior = (bill.payments || []).find(
    (payment) => payment.key === input.key,
  );
  if (prior) {
    if (
      prior.method !== input.method ||
      prior.splitId !== input.splitId ||
      (input.amountMinor !== undefined &&
        prior.amountMinor !== input.amountMinor) ||
      prior.reference !== (input.reference || "")
    )
      throw new HttpError(
        409,
        "REQUEST_REUSED",
        "This payment key belongs to a different receipt.",
      );
    return bill;
  }
  if (bill.status === "paid") return bill;
  if (bill.status !== "finalized")
    throw new HttpError(409, "BILL_NOT_FINAL", "Finalize this bill first.");
  if ((bill.payments || []).length >= 100)
    throw new HttpError(
      409,
      "PAYMENT_LIMIT",
      "This bill has reached its receipt limit. Contact the manager.",
    );
  if (bill.splits?.length && !input.splitId)
    throw new HttpError(
      400,
      "SPLIT_REQUIRED",
      "Choose which split this receipt pays.",
    );
  const remaining = remainingMinor(bill, input.splitId),
    held = heldMinor(bill, input.splitId);
  const amount = input.amountMinor ?? remaining;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining - held)
    throw new HttpError(
      409,
      "PAYMENT_AMOUNT",
      "The amount exceeds the unreserved balance or is not positive.",
    );
  const record = {
    id: randomBytes(10).toString("hex"),
    key: input.key,
    method: input.method,
    amountMinor: amount,
    ...(input.splitId ? { splitId: input.splitId } : {}),
    reference: input.reference || "",
    by: input.by || "gateway",
    at: new Date(),
  };
  const splits = (bill.splits || []).map((part) =>
    part.id === input.splitId
      ? { ...part, paidMinor: (part.paidMinor || 0) + amount }
      : part,
  );
  const updated = {
    ...bill,
    revision: (bill.revision || 0) + 1,
    payments: [...(bill.payments || []), record],
    paidMinor: paidMinor(bill) + amount,
    splits,
  };
  await store.bills.updateOne(
    { _id: bill._id },
    {
      $set: {
        payments: updated.payments,
        paidMinor: updated.paidMinor,
        splits,
      },
      $inc: { revision: 1 },
    },
    { session },
  );
  await store.audit.insertOne(
    {
      type: "bill.receipt",
      billId: bill._id,
      paymentId: record.id,
      amountMinor: amount,
      method: input.method,
      by: record.by,
      at: record.at,
    },
    { session },
  );
  return updated.paidMinor === bill.totalMinor
    ? finishBill(store, updated, session)
    : updated;
}

export async function settleBill(store, id, input, user) {
  return transaction(store, async (session) => {
    const bill = await store.bills.findOneAndUpdate(
      { _id: id },
      { $inc: { revision: 1 } },
      { session, returnDocument: "after" },
    );
    if (!bill)
      throw new HttpError(404, "NOT_FOUND", "This bill could not be found.");
    const result = await appendPayment(
      store,
      bill,
      { ...input, key: input.requestKey || "legacy-settle", by: user.username },
      session,
    );
    return billView(result);
  });
}

const part = z.strictObject({
  label: z.string().trim().min(1).max(40),
  amountMinor: z.number().int().positive().optional(),
  lines: z
    .array(
      z.strictObject({
        lineId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(10),
      }),
    )
    .max(120)
    .optional(),
});
const splitInput = z.strictObject({
  expectedRevision: z.number().int().min(0),
  mode: z.enum(["equal", "amount", "items", "customer", "none"]),
  parts: z.array(part).max(12).default([]),
});

export function registerSplitBills(api, store, billingRoles, requireId) {
  api.post("/bills/:id/splits", billingRoles, async (req, res) => {
    const input = body(splitInput, req.body),
      id = requireId(req.params.id);
    const result = await transaction(store, async (session) => {
      const bill = await store.bills.findOneAndUpdate(
        { _id: id },
        { $inc: { revision: 1 } },
        { session, returnDocument: "before" },
      );
      if (!bill)
        throw new HttpError(404, "NOT_FOUND", "This bill could not be found.");
      if (bill.status !== "finalized" || paidMinor(bill) || heldMinor(bill))
        throw new HttpError(
          409,
          "SPLIT_LOCKED",
          "Splits can only change before the first receipt or online payment reservation.",
        );
      if ((bill.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "BILL_UPDATED",
          "The bill changed. Refresh before splitting it.",
        );
      let parts = input.parts,
        weights = [],
        lines = [];
      if (input.mode === "customer") {
        const owners = new Map();
        for (const item of bill.items) {
          if (!item.ownerKey || !item.lineId)
            throw new HttpError(
              409,
              "LEGACY_BILL",
              "This older bill supports equal or amount splits; customer/item snapshots were not recorded.",
            );
          if (!owners.has(item.ownerKey)) owners.set(item.ownerKey, []);
          owners
            .get(item.ownerKey)
            .push({ lineId: item.lineId, quantity: item.quantity });
        }
        parts = [...owners.values()].map((rows, index) => ({
          label: "Customer " + (index + 1),
          lines: rows,
        }));
      }
      if (input.mode !== "none" && (parts.length < 2 || parts.length > 12))
        throw new HttpError(400, "INVALID_SPLIT", "Choose 2 to 12 splits.");
      if (["items", "customer"].includes(input.mode)) {
        const quantities = new Map();
        weights = parts.map((part) =>
          (part.lines || []).reduce((sum, line) => {
            const item = bill.items.find((item) => item.lineId === line.lineId);
            if (!item)
              throw new HttpError(
                400,
                "INVALID_SPLIT",
                "A selected bill line does not exist.",
              );
            quantities.set(
              line.lineId,
              (quantities.get(line.lineId) || 0) + line.quantity,
            );
            return sum + Math.round(item.unitPrice * 100) * line.quantity;
          }, 0),
        );
        if (
          weights.some((weight) => !weight) ||
          bill.items.some(
            (item) => quantities.get(item.lineId) !== item.quantity,
          )
        )
          throw new HttpError(
            400,
            "INVALID_SPLIT",
            "Allocate every item quantity exactly once across the splits.",
          );
        lines = parts.map((part) => part.lines);
      } else if (input.mode === "amount") {
        weights = parts.map((part) => part.amountMinor || 0);
        if (
          weights.some((amount) => !amount) ||
          weights.reduce((sum, value) => sum + value, 0) !== bill.totalMinor
        )
          throw new HttpError(
            400,
            "INVALID_SPLIT",
            "Custom amounts must add up to the final bill exactly.",
          );
      } else weights = parts.map(() => 1);
      const amounts =
        input.mode === "none" ? [] : allocateMinor(bill.totalMinor, weights);
      if (amounts.some((amount) => amount <= 0))
        throw new HttpError(
          400,
          "INVALID_SPLIT",
          "Each split must owe at least one paisa.",
        );
      const splits = amounts.map((amountMinor, index) => ({
        id: randomBytes(8).toString("hex"),
        label: parts[index].label,
        amountMinor,
        paidMinor: 0,
        ...(lines[index] ? { lines: lines[index] } : {}),
      }));
      await store.bills.updateOne(
        { _id: id },
        { $set: { splits, splitMode: input.mode } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "bill.split",
          billId: id,
          mode: input.mode,
          splits,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return billView({
        ...bill,
        revision: (bill.revision || 0) + 1,
        splits,
        splitMode: input.mode,
      });
    });
    res.json({ bill: result });
  });
}
