import { assertApprovalLimit } from "./access.js";
import { moveInventoryValue } from "./inventory-cost.js";
import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import {
  batchInput,
  manualBatchChange,
  stockLimit,
  stockDay,
} from "./ingredient-batches.js";
import { recordCash } from "./cash-drawer.js";

const id = z.string().regex(/^[a-f0-9]{24}$/),
  key = z.string().regex(/^[a-f0-9]{32}$/),
  text = (max) => z.string().trim().max(max),
  reason = text(160).min(3);
const supplierInput = z.strictObject({
  name: text(100).min(2),
  contact: text(80).default(""),
  phone: text(25).default(""),
  email: text(254).refine(
    (value) => !value || z.email().safeParse(value).success,
    "Enter a valid supplier email.",
  ),
  address: text(240).default(""),
  notes: text(240).default(""),
  active: z.boolean(),
});
const lineInput = z.strictObject({
  ingredientId: id,
  quantity: z.number().int().min(1).max(stockLimit),
  unitPriceMinor: z.number().int().min(0).max(100_000_000),
  pricePerQuantity: z.number().int().min(1).max(1_000_000),
});
const purchaseInput = z.strictObject({
  supplierId: id,
  lines: z
    .array(lineInput)
    .min(1)
    .max(30)
    .refine(
      (rows) =>
        new Set(rows.map((row) => row.ingredientId)).size === rows.length,
      "Use one purchase line per ingredient.",
    ),
  dueOn: text(10).default(""),
  notes: text(240).default(""),
});
const supplierView = (row) => ({
  id: String(row._id),
  name: row.name,
  contact: row.contact,
  phone: row.phone,
  email: row.email,
  address: row.address,
  notes: row.notes,
  active: row.active,
  revision: row.revision || 0,
});
export function purchaseLineValue(quantity, unitPriceMinor, pricePerQuantity) {
  const numerator = BigInt(quantity) * BigInt(unitPriceMinor),
    denominator = BigInt(pricePerQuantity),
    result = Number((numerator + denominator / 2n) / denominator);
  if (!Number.isSafeInteger(result) || result > 10_000_000_000)
    throw new HttpError(
      400,
      "PURCHASE_AMOUNT",
      "The purchase amount exceeds the supported exact-money limit.",
    );
  return result;
}
export const purchaseView = (row) => ({
  id: String(row._id),
  code: row.code,
  supplierId: String(row.supplierId),
  supplierName: row.supplierName,
  status: row.status,
  lines: row.lines.map((line) => ({
    ...line,
    outstandingQuantity: line.quantity - line.receivedQuantity,
  })),
  orderedMinor: row.orderedMinor,
  receivedMinor: row.receivedMinor,
  paidMinor: row.paidMinor,
  balanceMinor:
    row.receivedMinor -
    (row.returnedMinor || 0) -
    row.paidMinor +
    (row.supplierRefundMinor || 0),
  returnedMinor: row.returnedMinor || 0,
  supplierRefundMinor: row.supplierRefundMinor || 0,
  dueOn: row.dueOn,
  overdue: Boolean(
    row.dueOn &&
    row.dueOn < stockDay() &&
    row.receivedMinor - (row.returnedMinor || 0) >
      row.paidMinor - (row.supplierRefundMinor || 0),
  ),
  notes: row.notes,
  revision: row.revision || 0,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  history: row.history,
});
async function purchaseLines(store, input, session) {
  const result = [];
  for (const line of input) {
    const ingredient = await store.ingredients.findOne(
      { _id: new ObjectId(line.ingredientId) },
      { session },
    );
    if (!ingredient)
      throw new HttpError(
        400,
        "INGREDIENT_REQUIRED",
        "A selected ingredient no longer exists.",
      );
    result.push({
      ...line,
      ingredientName: ingredient.name,
      unit: ingredient.unit,
      receivedQuantity: 0,
      amountMinor: purchaseLineValue(
        line.quantity,
        line.unitPriceMinor,
        line.pricePerQuantity,
      ),
    });
  }
  return result;
}
function dueDate(value) {
  if (
    value &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(new Date(value + "T00:00:00Z").getTime()) ||
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value)
  )
    throw new HttpError(400, "PURCHASE_DATE", "Use a valid payment due date.");
}

export function registerPurchasing(
  api,
  store,
  billingRoles,
  requireAdmin,
  requireId,
) {
  api.get("/suppliers", billingRoles, async (req, res) => {
    const rows = await store.suppliers
      .find({})
      .sort({ active: -1, name: 1 })
      .limit(1000)
      .toArray();
    const balances = await store.purchases
      .aggregate([
        {
          $group: {
            _id: "$supplierId",
            receivedMinor: { $sum: "$receivedMinor" },
            paidMinor: { $sum: "$paidMinor" },
            returnedMinor: { $sum: "$returnedMinor" },
            supplierRefundMinor: { $sum: "$supplierRefundMinor" },
          },
        },
      ])
      .toArray();
    res.json({
      suppliers: rows.map((row) => {
        const balance = balances.find((item) => item._id.equals(row._id));
        return {
          ...supplierView(row),
          receivedMinor: balance?.receivedMinor || 0,
          paidMinor: balance?.paidMinor || 0,
          returnedMinor: balance?.returnedMinor || 0,
          supplierRefundMinor: balance?.supplierRefundMinor || 0,
          balanceMinor:
            (balance?.receivedMinor || 0) -
            (balance?.returnedMinor || 0) -
            (balance?.paidMinor || 0) +
            (balance?.supplierRefundMinor || 0),
        };
      }),
    });
  });
  api.post("/suppliers", requireAdmin, async (req, res) => {
    const input = body(supplierInput, req.body);
    const row = await transaction(store, async (session) => {
      await store.settings.updateOne(
        { _id: "supplier-setup-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      if ((await store.suppliers.countDocuments({}, { session })) >= 1000)
        throw new HttpError(409, "SUPPLIER_LIMIT", "Supplier limit reached.");
      if (
        await store.suppliers.findOne(
          { nameKey: input.name.toLowerCase() },
          { session },
        )
      )
        throw new HttpError(
          409,
          "SUPPLIER_EXISTS",
          "This supplier already exists; edit or reactivate it.",
        );
      const row = {
        _id: new ObjectId(),
        ...input,
        nameKey: input.name.toLowerCase(),
        revision: 0,
        createdAt: new Date(),
      };
      await store.suppliers.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "supplier.created",
          supplierId: row._id,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ supplier: supplierView(row) });
  });
  api.patch("/suppliers/:id", requireAdmin, async (req, res) => {
    const input = body(
        supplierInput.extend({
          expectedRevision: z.number().int().min(0),
          reason,
        }),
        req.body,
      ),
      id = requireId(req.params.id);
    const row = await transaction(store, async (session) => {
      await store.settings.updateOne(
        { _id: "supplier-setup-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const duplicate = await store.suppliers.findOne(
        { nameKey: input.name.toLowerCase(), _id: { $ne: id } },
        { session },
      );
      if (duplicate)
        throw new HttpError(
          409,
          "SUPPLIER_EXISTS",
          "This supplier name is already in use.",
        );
      const { expectedRevision, reason, ...changes } = input,
        row = await store.suppliers.findOneAndUpdate(
          { _id: id, revision: expectedRevision },
          {
            $set: { ...changes, nameKey: input.name.toLowerCase() },
            $inc: { revision: 1 },
          },
          { session, returnDocument: "after" },
        );
      if (!row)
        throw new HttpError(
          409,
          "SUPPLIER_UPDATED",
          "Supplier details changed. Refresh first.",
        );
      await store.audit.insertOne(
        {
          type: "supplier.updated",
          supplierId: id,
          reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.json({ supplier: supplierView(row) });
  });
  api.get("/purchases", billingRoles, async (req, res) => {
    const filter = {};
    if (req.query.supplier) filter.supplierId = requireId(req.query.supplier);
    if (req.query.code) filter.code = body(text(40), String(req.query.code));
    const rows = await store.purchases
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
      [totals] = await store.purchases
        .aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              orderedMinor: { $sum: "$orderedMinor" },
              receivedMinor: { $sum: "$receivedMinor" },
              paidMinor: { $sum: "$paidMinor" },
              returnedMinor: { $sum: "$returnedMinor" },
              supplierRefundMinor: { $sum: "$supplierRefundMinor" },
            },
          },
        ])
        .toArray();
    res.json({
      purchases: rows.map(purchaseView),
      totals: {
        orderedMinor: totals?.orderedMinor || 0,
        receivedMinor: totals?.receivedMinor || 0,
        paidMinor: totals?.paidMinor || 0,
        returnedMinor: totals?.returnedMinor || 0,
        supplierRefundMinor: totals?.supplierRefundMinor || 0,
        outstandingMinor:
          (totals?.receivedMinor || 0) -
          (totals?.returnedMinor || 0) -
          (totals?.paidMinor || 0) +
          (totals?.supplierRefundMinor || 0),
      },
    });
  });
  api.post("/purchases", requireAdmin, async (req, res) => {
    const input = body(purchaseInput.extend({ requestKey: key }), req.body);
    dueDate(input.dueOn);
    const fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const prior = await store.purchases.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another purchase order.",
          );
        return prior;
      }
      const supplier = await store.suppliers.findOneAndUpdate(
        { _id: requireId(input.supplierId), active: true },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!supplier)
        throw new HttpError(
          409,
          "SUPPLIER_REQUIRED",
          "Choose an active supplier.",
        );
      const lines = await purchaseLines(store, input.lines, session),
        orderedMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
      if (orderedMinor > 10_000_000_000)
        throw new HttpError(
          400,
          "PURCHASE_AMOUNT",
          "Purchase total exceeds the supported limit.",
        );
      const row = {
        _id: new ObjectId(),
        code: "PO-" + randomBytes(6).toString("hex").toUpperCase(),
        supplierId: supplier._id,
        supplierName: supplier.name,
        lines,
        orderedMinor,
        receivedMinor: 0,
        paidMinor: 0,
        status: "draft",
        dueOn: input.dueOn,
        notes: input.notes,
        revision: 0,
        createdAt: new Date(),
        createdBy: req.staff.username,
        requestKey: input.requestKey,
        fingerprint,
        history: [{ status: "draft", by: req.staff.username, at: new Date() }],
      };
      await store.purchases.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "purchase.created",
          purchaseId: row._id,
          supplierId: supplier._id,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ purchase: purchaseView(result) });
  });
  api.get("/purchases/:id", billingRoles, async (req, res) => {
    const id = requireId(req.params.id),
      row = await store.purchases.findOne({ _id: id });
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
    const receipts = await store.purchaseReceipts
        .find({ purchaseId: id })
        .sort({ at: -1 })
        .limit(100)
        .toArray(),
      payments = await store.supplierPayments
        .find({ purchaseId: id })
        .sort({ at: -1 })
        .limit(100)
        .toArray();
    res.json({
      purchase: purchaseView(row),
      receipts: receipts.map(({ _id, fingerprint, requestKey, ...item }) => ({
        ...item,
        id: String(_id),
      })),
      payments: payments.map(({ _id, fingerprint, requestKey, ...item }) => ({
        ...item,
        id: String(_id),
      })),
    });
  });
  api.post("/purchases/:id/action", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          action: z.enum(["order", "cancel"]),
          expectedRevision: z.number().int().min(0),
          reason,
        }),
        req.body,
      ),
      id = requireId(req.params.id);
    const row = await transaction(store, async (session) => {
      const previous = await store.purchases.findOneAndUpdate(
        { _id: id, revision: input.expectedRevision },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!previous)
        throw new HttpError(
          409,
          "PURCHASE_UPDATED",
          "This purchase order changed. Refresh first.",
        );
      if (
        input.action === "order"
          ? previous.status !== "draft"
          : !["draft", "ordered", "partially_received"].includes(
              previous.status,
            )
      )
        throw new HttpError(
          409,
          "PURCHASE_STATE",
          "This purchase order cannot make that transition.",
        );
      if (
        input.action === "order" &&
        !(await store.suppliers.findOneAndUpdate(
          { _id: previous.supplierId, active: true },
          { $inc: { revision: 1 } },
          { session },
        ))
      )
        throw new HttpError(
          409,
          "SUPPLIER_REQUIRED",
          "Reactivate the supplier before confirming a new purchase order.",
        );
      if (input.action === "order")
        await assertApprovalLimit(
          store,
          req.staff,
          "purchaseApproval",
          previous.orderedMinor,
          session,
        );
      const status = input.action === "order" ? "ordered" : "cancelled",
        entry = {
          status,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        };
      await store.purchases.updateOne(
        { _id: id },
        { $set: { status }, $push: { history: entry } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "purchase." + status,
          purchaseId: id,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { ...previous, status, history: [...previous.history, entry] };
    });
    res.json({ purchase: purchaseView(row) });
  });
  api.post("/purchases/:id/receive", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: z.number().int().min(0),
          reference: text(80).min(2),
          reason,
          requestKey: key,
          items: z
            .array(
              z.strictObject({
                ingredientId: id,
                quantity: z.number().int().min(1).max(stockLimit),
                batch: batchInput.optional(),
              }),
            )
            .min(1)
            .max(30)
            .refine(
              (items) =>
                new Set(items.map((item) => item.ingredientId)).size ===
                items.length,
            ),
        }),
        req.body,
      ),
      purchaseId = requireId(req.params.id),
      fingerprint = hash(JSON.stringify({ purchaseId, ...input }));
    const result = await transaction(store, async (session) => {
      const old = await store.purchaseReceipts.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another delivery receipt.",
          );
        return store.purchases.findOne({ _id: purchaseId }, { session });
      }
      const row = await store.purchases.findOneAndUpdate(
        {
          _id: purchaseId,
          revision: input.expectedRevision,
          status: { $in: ["ordered", "partially_received"] },
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "PURCHASE_UPDATED",
          "Only an unchanged ordered purchase can receive a delivery.",
        );
      const lines = row.lines.map((line) => ({ ...line })),
        receiptItems = [];
      let receivedValue = 0;
      for (const item of [...input.items].sort((a, b) =>
        a.ingredientId.localeCompare(b.ingredientId),
      )) {
        const line = lines.find(
          (line) => line.ingredientId === item.ingredientId,
        );
        if (!line || line.receivedQuantity + item.quantity > line.quantity)
          throw new HttpError(
            409,
            "PURCHASE_QUANTITY",
            "A delivery quantity exceeds the outstanding order quantity.",
          );
        const ingredient = await store.ingredients.findOneAndUpdate(
          {
            _id: new ObjectId(item.ingredientId),
            stock: { $lte: stockLimit - item.quantity },
          },
          { $inc: { stock: item.quantity, revision: 1 } },
          { session, returnDocument: "after" },
        );
        if (!ingredient)
          throw new HttpError(
            409,
            "STOCK_LIMIT",
            "This ingredient is missing or would exceed its stock limit.",
          );
        const batches = await manualBatchChange(
          store,
          ingredient,
          item.quantity,
          item,
          session,
          {
            supplierId: row.supplierId,
            purchaseId,
            receivedBy: req.staff.username,
          },
        );
        const value =
          purchaseLineValue(
            line.receivedQuantity + item.quantity,
            line.unitPriceMinor,
            line.pricePerQuantity,
          ) -
          purchaseLineValue(
            line.receivedQuantity,
            line.unitPriceMinor,
            line.pricePerQuantity,
          );
        await moveInventoryValue(store, ingredient, item.quantity, session, {
          amountMinor: value,
          knownQuantity: item.quantity,
        });
        line.receivedQuantity += item.quantity;
        receivedValue += value;
        receiptItems.push({
          ingredientId: item.ingredientId,
          ingredientName: line.ingredientName,
          unit: line.unit,
          quantity: item.quantity,
          valueMinor: value,
          batches,
        });
        await store.stockMovements.insertOne(
          {
            key: "purchase:" + input.requestKey + ":" + item.ingredientId,
            ingredientId: ingredient._id,
            ingredientName: ingredient.name,
            unit: ingredient.unit,
            delta: item.quantity,
            balance: ingredient.stock,
            kind: "purchase_received",
            by: req.staff.username,
            reason: input.reason,
            reference: input.reference,
            purchaseId,
            batches,
            at: new Date(),
          },
          { session },
        );
      }
      const status = lines.every(
          (line) => line.receivedQuantity === line.quantity,
        )
          ? "received"
          : "partially_received",
        entry = {
          status,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        };
      await store.purchaseReceipts.insertOne(
        {
          purchaseId,
          supplierId: row.supplierId,
          items: receiptItems,
          valueMinor: receivedValue,
          reference: input.reference,
          reason: input.reason,
          requestKey: input.requestKey,
          fingerprint,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      await store.purchases.updateOne(
        { _id: purchaseId },
        {
          $set: { lines, status },
          $inc: { receivedMinor: receivedValue },
          $push: { history: entry },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "purchase.delivery_received",
          purchaseId,
          supplierId: row.supplierId,
          amountMinor: receivedValue,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return {
        ...row,
        lines,
        status,
        receivedMinor: row.receivedMinor + receivedValue,
        history: [...row.history, entry],
      };
    });
    res.json({ purchase: purchaseView(result) });
  });
  api.post("/purchases/:id/payments", billingRoles, async (req, res) => {
    const input = body(
        z.strictObject({
          amountMinor: z.number().int().min(1).max(10_000_000_000),
          method: z.enum(["cash", "bkash", "nagad", "bank", "card"]),
          reference: text(100).default(""),
          reason,
          verified: z.literal(true),
          requestKey: key,
        }),
        req.body,
      ),
      purchaseId = requireId(req.params.id),
      fingerprint = hash(JSON.stringify({ purchaseId, ...input }));
    if (input.method !== "cash" && !input.reference)
      throw new HttpError(
        400,
        "REFERENCE_REQUIRED",
        "Enter the verified supplier payment reference.",
      );
    const result = await transaction(store, async (session) => {
      const old = await store.supplierPayments.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another supplier payment.",
          );
        return store.purchases.findOne({ _id: purchaseId }, { session });
      }
      await assertApprovalLimit(
        store,
        req.staff,
        "purchasePayment",
        input.amountMinor,
        session,
      );
      const row = await store.purchases.findOneAndUpdate(
        { _id: purchaseId },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (
        !row ||
        input.amountMinor >
          row.receivedMinor -
            (row.returnedMinor || 0) -
            row.paidMinor +
            (row.supplierRefundMinor || 0)
      )
        throw new HttpError(
          409,
          "SUPPLIER_PAYMENT_LIMIT",
          "Pay only the unpaid value of goods already received.",
        );
      const paymentId = new ObjectId();
      await store.supplierPayments.insertOne(
        {
          _id: paymentId,
          purchaseId,
          supplierId: row.supplierId,
          amountMinor: input.amountMinor,
          method: input.method,
          reference: input.reference,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
          requestKey: input.requestKey,
          fingerprint,
        },
        { session },
      );
      if (input.method === "cash")
        await recordCash(
          store,
          {
            key: "supplier:" + paymentId,
            kind: "supplier_payment",
            deltaMinor: -input.amountMinor,
            by: req.staff.username,
            sourceId: purchaseId,
            reference: input.reference || row.code,
            reason: input.reason,
            requireFunds: true,
          },
          session,
        );
      await store.purchases.updateOne(
        { _id: purchaseId },
        { $inc: { paidMinor: input.amountMinor } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "supplier.payment_recorded",
          supplierId: row.supplierId,
          purchaseId,
          amountMinor: input.amountMinor,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { ...row, paidMinor: row.paidMinor + input.amountMinor };
    });
    res.status(201).json({ purchase: purchaseView(result) });
  });
}
