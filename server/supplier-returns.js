import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import { manualBatchChange } from "./ingredient-batches.js";
import { moveInventoryValue, ratioMinor } from "./inventory-cost.js";
import { recordCash } from "./cash-drawer.js";
const id = z.string().regex(/^[a-f0-9]{24}$/),
  key = z.string().regex(/^[a-f0-9]{32}$/),
  reason = z.string().trim().min(3).max(160);
export const supplierBalance = (row) =>
  row.receivedMinor -
  (row.returnedMinor || 0) -
  row.paidMinor +
  (row.supplierRefundMinor || 0);
const view = (row) => ({
  ...row,
  id: String(row._id),
  _id: undefined,
  requestKey: undefined,
  fingerprint: undefined,
  confirmKey: undefined,
});
export function registerSupplierReturns(
  api,
  store,
  requireAdmin,
  billingRoles,
  requireId,
) {
  api.get("/supplier-returns", billingRoles, async (req, res) => {
    const returns = await store.supplierReturns
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const credits = await store.purchases
      .find({
        $expr: {
          $lt: [
            {
              $add: [
                {
                  $subtract: [
                    "$receivedMinor",
                    { $ifNull: ["$returnedMinor", 0] },
                  ],
                },
                {
                  $subtract: [
                    { $ifNull: ["$supplierRefundMinor", 0] },
                    "$paidMinor",
                  ],
                },
              ],
            },
            0,
          ],
        },
      })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const refunds = await store.supplierRefunds
      .find({})
      .sort({ at: -1 })
      .limit(100)
      .toArray();
    res.json({
      returns: returns.map(view),
      credits: credits.map((row) => ({
        id: String(row._id),
        code: row.code,
        supplierName: row.supplierName,
        creditMinor: -supplierBalance(row),
      })),
      refunds: refunds.map(view),
    });
  });
  api.post("/supplier-returns", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          receiptId: id,
          items: z
            .array(
              z.strictObject({
                ingredientId: id,
                quantity: z.number().int().min(1).max(1_000_000_000),
              }),
            )
            .min(1)
            .max(30)
            .refine(
              (a) => new Set(a.map((i) => i.ingredientId)).size === a.length,
            ),
          reason,
          requestKey: key,
        }),
        req.body,
      ),
      fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const old = await store.supplierReturns.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another supplier return.",
          );
        return old;
      }
      const receipt = await store.purchaseReceipts.findOneAndUpdate(
        { _id: requireId(input.receiptId) },
        { $inc: { returnRevision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!receipt)
        throw new HttpError(404, "NOT_FOUND", "Delivery receipt not found.");
      const purchase = await store.purchases.findOne(
        { _id: receipt.purchaseId },
        { session },
      );
      const reserved = await store.supplierReturns
        .find(
          {
            receiptId: receipt._id,
            status: { $in: ["requested", "approved", "returned"] },
          },
          { session },
        )
        .toArray();
      const items = input.items.map((item) => {
        const line = receipt.items.find(
          (i) => i.ingredientId === item.ingredientId,
        );
        const used = reserved.reduce(
          (sum, r) =>
            sum +
            (r.items.find((i) => i.ingredientId === item.ingredientId)
              ?.quantity || 0),
          0,
        );
        if (!line || used + item.quantity > line.quantity)
          throw new HttpError(
            409,
            "RETURN_LIMIT",
            "Return only the original delivered quantity that is not already reserved or returned.",
          );
        return {
          ...item,
          name: line.ingredientName,
          unit: line.unit,
          batches: line.batches || [],
        };
      });
      const row = {
        _id: new ObjectId(),
        code: "SR-" + new ObjectId().toString().slice(-10).toUpperCase(),
        receiptId: receipt._id,
        purchaseId: receipt.purchaseId,
        purchaseCode: purchase.code,
        supplierId: receipt.supplierId,
        supplierName: purchase.supplierName,
        receiptReference: receipt.reference,
        items,
        status: "requested",
        revision: 0,
        reason: input.reason,
        createdBy: req.staff.username,
        createdAt: new Date(),
        requestKey: input.requestKey,
        fingerprint,
      };
      await store.supplierReturns.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "supplier.return_requested",
          supplierReturnId: row._id,
          purchaseId: row.purchaseId,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ return: view(result) });
  });
  api.post("/supplier-returns/:id/decision", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        decision: z.enum(["approve", "reject"]),
        expectedRevision: z.number().int().min(0),
        reason,
      }),
      req.body,
    );
    const result = await transaction(store, async (session) => {
      const row = await store.supplierReturns.findOneAndUpdate(
        {
          _id: requireId(req.params.id),
          revision: input.expectedRevision,
          status: {
            $in:
              input.decision === "reject"
                ? ["requested", "approved"]
                : ["requested"],
          },
        },
        {
          $set: {
            status: input.decision === "approve" ? "approved" : "rejected",
            reviewedBy: req.staff.username,
            reviewedAt: new Date(),
            reviewReason: input.reason,
          },
          $inc: { revision: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "RETURN_UPDATED",
          "This return changed. Refresh before reviewing.",
        );
      await store.purchaseReceipts.updateOne(
        { _id: row.receiptId },
        { $inc: { returnRevision: 1 } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "supplier.return_" + row.status,
          supplierReturnId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.json({ return: view(result) });
  });
  api.post("/supplier-returns/:id/confirm", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: z.number().int().min(0),
          verified: z.literal(true),
          reference: z.string().trim().min(2).max(80),
          reason,
          requestKey: key,
        }),
        req.body,
      ),
      fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const row = await store.supplierReturns.findOne(
        { _id: requireId(req.params.id) },
        { session },
      );
      if (row?.confirmKey === input.requestKey) {
        if (row.confirmFingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This confirmation key was already used differently.",
          );
        return row;
      }
      if (
        !row ||
        row.status !== "approved" ||
        row.revision !== input.expectedRevision
      )
        throw new HttpError(
          409,
          "RETURN_UPDATED",
          "Only an unchanged approved return can be handed over.",
        );
      const receipt = await store.purchaseReceipts.findOneAndUpdate(
          { _id: row.receiptId },
          { $inc: { returnRevision: 1 } },
          { session, returnDocument: "after" },
        ),
        purchase = await store.purchases.findOneAndUpdate(
          { _id: row.purchaseId },
          { $inc: { revision: 1 } },
          { session, returnDocument: "after" },
        );
      let amountMinor = 0,
        removedValueMinor = 0,
        missingQuantity = 0;
      const lines = [];
      for (const item of [...row.items].sort((a, b) =>
        a.ingredientId.localeCompare(b.ingredientId),
      )) {
        const source = receipt.items.find(
            (i) => i.ingredientId === item.ingredientId,
          ),
          past = await store.supplierReturns
            .find({ receiptId: row.receiptId, status: "returned" }, { session })
            .toArray(),
          returned = past.reduce(
            (sum, r) =>
              sum +
              (r.items.find((i) => i.ingredientId === item.ingredientId)
                ?.quantity || 0),
            0,
          );
        if (returned + item.quantity > source.quantity)
          throw new HttpError(
            409,
            "RETURN_LIMIT",
            "The original receipt quantity is already returned.",
          );
        const credit =
          ratioMinor(
            source.valueMinor,
            returned + item.quantity,
            source.quantity,
          ) - ratioMinor(source.valueMinor, returned, source.quantity);
        const ingredient = await store.ingredients.findOneAndUpdate(
          {
            _id: new ObjectId(item.ingredientId),
            stock: { $gte: item.quantity },
          },
          { $inc: { stock: -item.quantity, revision: 1 } },
          { session, returnDocument: "after" },
        );
        if (!ingredient)
          throw new HttpError(
            409,
            "RETURN_STOCK",
            "There is not enough unallocated stock to return. Review reserved and used stock.",
          );
        let batches = [];
        if (ingredient.batchTracked) {
          if (source.batches?.length !== 1)
            throw new HttpError(
              409,
              "RETURN_PROVENANCE",
              "This legacy delivery lacks an exact batch. Review its provenance with the operator before returning.",
            );
          batches = await manualBatchChange(
            store,
            ingredient,
            -item.quantity,
            { batchId: source.batches[0].batchId },
            session,
          );
        }
        const cost = await moveInventoryValue(
          store,
          ingredient,
          -item.quantity,
          session,
        );
        amountMinor += credit;
        removedValueMinor += cost.amountMinor;
        missingQuantity += item.quantity - cost.knownQuantity;
        lines.push({ ...item, creditMinor: credit, cost, batches });
        await store.stockMovements.insertOne(
          {
            key: "supplier-return:" + row._id + ":" + item.ingredientId,
            ingredientId: ingredient._id,
            ingredientName: item.name,
            unit: item.unit,
            kind: "supplier_return",
            delta: -item.quantity,
            balance: ingredient.stock,
            cost,
            batches,
            purchaseId: row.purchaseId,
            supplierReturnId: row._id,
            reason: input.reason,
            reference: input.reference,
            by: req.staff.username,
            at: new Date(),
          },
          { session },
        );
      }
      const sequence = await store.settings.findOneAndUpdate(
        { _id: "supplier-credit-counter" },
        { $inc: { sequence: 1 } },
        { session, upsert: true, returnDocument: "after" },
      );
      const creditNote = {
        number: "SCN-" + String(sequence.sequence).padStart(7, "0"),
        amountMinor,
        removedValueMinor,
        valuationAdjustmentMinor: amountMinor - removedValueMinor,
        missingQuantity,
        lines,
        reference: input.reference,
        reason: input.reason,
        at: new Date(),
        by: req.staff.username,
      };
      await store.purchases.updateOne(
        { _id: purchase._id },
        { $inc: { returnedMinor: amountMinor } },
        { session },
      );
      const changes = {
        status: "returned",
        revision: row.revision + 1,
        creditNote,
        confirmedAt: new Date(),
        confirmedBy: req.staff.username,
        confirmKey: input.requestKey,
        confirmFingerprint: fingerprint,
      };
      await store.supplierReturns.updateOne(
        { _id: row._id },
        { $set: changes },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "supplier.return_confirmed",
          supplierReturnId: row._id,
          purchaseId: row.purchaseId,
          amountMinor,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { ...row, ...changes };
    });
    res.json({ return: view(result) });
  });
  api.post(
    "/purchases/:id/supplier-refunds",
    billingRoles,
    async (req, res) => {
      const input = body(
          z.strictObject({
            amountMinor: z.number().int().min(1).max(10_000_000_000),
            method: z.enum(["cash", "bank", "bkash", "nagad", "card"]),
            reference: z.string().trim().min(2).max(100),
            reason,
            verified: z.literal(true),
            requestKey: key,
          }),
          req.body,
        ),
        purchaseId = requireId(req.params.id),
        fingerprint = hash(JSON.stringify({ purchaseId, ...input }));
      const result = await transaction(store, async (session) => {
        const old = await store.supplierRefunds.findOne(
          { requestKey: input.requestKey },
          { session },
        );
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new HttpError(
              409,
              "REQUEST_REUSED",
              "This key belongs to another supplier refund.",
            );
          return old;
        }
        const purchase = await store.purchases.findOneAndUpdate(
          { _id: purchaseId },
          { $inc: { revision: 1 } },
          { session, returnDocument: "after" },
        );
        if (
          !purchase ||
          input.amountMinor > Math.max(0, -supplierBalance(purchase))
        )
          throw new HttpError(
            409,
            "SUPPLIER_CREDIT_LIMIT",
            "Record only money actually received within this purchase's supplier credit balance.",
          );
        const row = {
          _id: new ObjectId(),
          purchaseId,
          supplierId: purchase.supplierId,
          purchaseCode: purchase.code,
          supplierName: purchase.supplierName,
          ...input,
          fingerprint,
          by: req.staff.username,
          at: new Date(),
        };
        await store.supplierRefunds.insertOne(row, { session });
        await store.purchases.updateOne(
          { _id: purchaseId },
          { $inc: { supplierRefundMinor: input.amountMinor } },
          { session },
        );
        if (input.method === "cash")
          await recordCash(
            store,
            {
              key: "supplier-refund:" + row._id,
              kind: "supplier_refund_received",
              deltaMinor: input.amountMinor,
              sourceId: purchaseId,
              by: req.staff.username,
              reference: input.reference,
              reason: input.reason,
            },
            session,
          );
        await store.audit.insertOne(
          {
            type: "supplier.refund_received",
            purchaseId,
            amountMinor: input.amountMinor,
            reason: input.reason,
            by: req.staff.username,
            at: new Date(),
          },
          { session },
        );
        return row;
      });
      res.status(201).json({ refund: view(result) });
    },
  );
}
