import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";

export const stockLimit = 1_000_000_000;
export const stockDay = (now = new Date()) =>
  new Date(now.getTime() + 6 * 3600000).toISOString().slice(0, 10);
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + "T00:00:00Z");
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Use a real expiry date.");
export const batchInput = z.strictObject({
  code: z.string().trim().min(2).max(60),
  expiresOn: calendarDate.nullable().optional(),
  noExpiry: z.boolean().default(false),
});
const reason = z.string().trim().min(3).max(160);
function expiry(input) {
  if (
    (!input.noExpiry && !input.expiresOn) ||
    (input.noExpiry && input.expiresOn)
  )
    throw new HttpError(
      400,
      "BATCH_EXPIRY",
      "Enter an expiry date or explicitly mark the ingredient as non-perishable.",
    );
  return input.noExpiry ? null : input.expiresOn;
}
export async function addIngredientBatch(
  store,
  ingredient,
  quantity,
  input,
  session,
  source = {},
) {
  const expiresOn = expiry(input),
    old = await store.ingredientBatches.findOne(
      { ingredientId: ingredient._id, code: input.code },
      { session },
    );
  if (old) {
    if (old.expiresOn !== expiresOn)
      throw new HttpError(
        409,
        "BATCH_EXISTS",
        "This batch code already has another expiry date. Review the existing batch.",
      );
    const next = await store.ingredientBatches.findOneAndUpdate(
      {
        _id: old._id,
        remaining: { $lte: stockLimit - quantity },
        originalQuantity: { $lte: stockLimit - quantity },
      },
      {
        $inc: { remaining: quantity, originalQuantity: quantity, revision: 1 },
        $set: { lastReceivedAt: new Date() },
      },
      { session, returnDocument: "after" },
    );
    if (!next)
      throw new HttpError(
        409,
        "BATCH_LIMIT",
        "Batch quantity would exceed its limit.",
      );
    return next;
  }
  const row = {
    _id: new ObjectId(),
    ingredientId: ingredient._id,
    ingredientName: ingredient.name,
    unit: ingredient.unit,
    code: input.code,
    expiresOn,
    originalQuantity: quantity,
    remaining: quantity,
    blocked: Boolean(source.blocked),
    needsReview: Boolean(source.blocked),
    revision: 0,
    createdAt: new Date(),
    ...source,
  };
  await store.ingredientBatches.insertOne(row, { session });
  return row;
}
const allocation = (row, quantity) => ({
  ingredientId: String(row.ingredientId),
  batchId: String(row._id),
  code: row.code,
  expiresOn: row.expiresOn,
  quantity,
});

// The caller already locks the ingredient and changes its physical balance in
// this transaction. Batch balances must succeed too, or both changes roll back.
export async function manualBatchChange(
  store,
  ingredient,
  delta,
  input,
  session,
  source = {},
) {
  if (!ingredient.batchTracked) return [];
  if (delta > 0) {
    if (!input.batch)
      throw new HttpError(
        400,
        "BATCH_REQUIRED",
        "This ingredient needs a batch code and expiry details for received or added stock.",
      );
    const row = await addIngredientBatch(
      store,
      ingredient,
      delta,
      input.batch,
      session,
      source,
    );
    return [allocation(row, delta)];
  }
  if (!input.batchId || !/^[a-f0-9]{24}$/i.test(input.batchId))
    throw new HttpError(
      400,
      "BATCH_REQUIRED",
      "Select the batch being wasted or removed.",
    );
  const row = await store.ingredientBatches.findOneAndUpdate(
    {
      _id: new ObjectId(input.batchId),
      ingredientId: ingredient._id,
      remaining: { $gte: -delta },
    },
    { $inc: { remaining: delta, revision: 1 } },
    { session, returnDocument: "after" },
  );
  if (!row)
    throw new HttpError(
      409,
      "BATCH_STOCK_LOW",
      "This batch does not contain the quantity being removed.",
    );
  return [allocation(row, delta)];
}
export async function orderBatchChange(
  store,
  ingredient,
  delta,
  previous,
  session,
  order,
) {
  if (!ingredient.batchTracked) return [];
  const owned = previous
    .filter((item) => item.ingredientId === String(ingredient._id))
    .map((item) => ({ ...item }));
  if (delta < 0) {
    let remaining = -delta;
    for (const expiresOn of [{ $gte: stockDay() }, null]) {
      const cursor = store.ingredientBatches
        .find(
          {
            ingredientId: ingredient._id,
            blocked: { $ne: true },
            expiresOn,
            remaining: { $gt: 0 },
          },
          { session },
        )
        .sort({ expiresOn: 1, createdAt: 1, _id: 1 });
      try {
        for await (const row of cursor) {
          if (!remaining) break;
          const used = Math.min(row.remaining, remaining);
          remaining -= used;
          await store.ingredientBatches.updateOne(
            { _id: row._id },
            { $inc: { remaining: -used, revision: 1 } },
            { session },
          );
          const old = owned.find((item) => item.batchId === String(row._id));
          if (old) old.quantity += used;
          else owned.push(allocation(row, used));
        }
      } finally {
        await cursor.close();
      }
      if (!remaining) break;
    }
    if (remaining)
      throw new HttpError(
        409,
        "BATCH_STOCK_LOW",
        "There is not enough unexpired, released batch stock for this recipe. Review the expiry alerts.",
      );
  } else if (delta > 0) {
    let remaining = delta;
    for (const item of [...owned].reverse()) {
      const returned = Math.min(item.quantity, remaining);
      if (!returned) continue;
      const update = await store.ingredientBatches.updateOne(
        {
          _id: new ObjectId(item.batchId),
          ingredientId: ingredient._id,
          remaining: { $lte: stockLimit - returned },
        },
        { $inc: { remaining: returned, revision: 1 } },
        { session },
      );
      if (!update.matchedCount)
        throw new HttpError(
          409,
          "BATCH_CHANGED",
          "A reserved batch is missing or exceeds its stock limit. Review inventory.",
        );
      item.quantity -= returned;
      remaining -= returned;
    }
    if (remaining) {
      // An order reserved before batch tracking has no lot provenance. Keep its
      // returned stock physically present but quarantined until staff review it.
      await addIngredientBatch(
        store,
        ingredient,
        remaining,
        {
          code:
            "RETURN-" +
            String(order._id).slice(-12) +
            "-" +
            ((order.revision || 0) + 1),
          noExpiry: true,
        },
        session,
        { blocked: true, origin: "legacy_reservation_return" },
      );
    }
  }
  return owned.filter((item) => item.quantity > 0);
}
export function batchView(row, today = stockDay()) {
  return {
    id: String(row._id),
    ingredientId: String(row.ingredientId),
    ingredientName: row.ingredientName,
    unit: row.unit,
    code: row.code,
    expiresOn: row.expiresOn,
    originalQuantity: row.originalQuantity,
    remaining: row.remaining,
    blocked: row.blocked,
    needsReview: row.needsReview || false,
    revision: row.revision || 0,
    createdAt: row.createdAt,
    expired: Boolean(row.expiresOn && row.expiresOn < today),
    usable: !row.blocked && (!row.expiresOn || row.expiresOn >= today),
    supplierId: row.supplierId ? String(row.supplierId) : null,
    purchaseId: row.purchaseId ? String(row.purchaseId) : null,
  };
}
export async function assertReservedBatches(store, order, session) {
  const allocations = order.inventory?.batchAllocations || [];
  for (const ingredientId of [
    ...new Set(allocations.map((item) => item.ingredientId)),
  ].sort())
    await store.ingredients.updateOne(
      { _id: new ObjectId(ingredientId) },
      { $inc: { revision: 1 } },
      { session },
    );
  for (const item of allocations) {
    const batch = await store.ingredientBatches.findOne(
      { _id: new ObjectId(item.batchId) },
      { session },
    );
    if (
      !batch ||
      batch.blocked ||
      (batch.expiresOn && batch.expiresOn < stockDay())
    )
      throw new HttpError(
        409,
        "BATCH_UNUSABLE",
        "A reserved ingredient batch expired or was quarantined. Review the order and its ingredients before cooking.",
      );
  }
}
export function registerIngredientBatches(
  api,
  store,
  requireAdmin,
  inventoryRoles,
  requireId,
) {
  api.get("/inventory/batches", inventoryRoles, async (req, res) => {
    const today = stockDay(),
      soon = stockDay(new Date(Date.now() + 7 * 86400000));
    const selection = body(
      z.enum(["all", "soon", "expired", "quarantined"]),
      req.query.filter || "all",
    );
    const filter = req.query.ingredient
      ? { ingredientId: requireId(req.query.ingredient) }
      : { remaining: { $gt: 0 } };
    if (selection !== "all") filter.remaining = { $gt: 0 };
    if (selection === "soon") filter.expiresOn = { $gte: today, $lte: soon };
    if (selection === "expired")
      filter.expiresOn = { $lt: today, $type: "string" };
    if (selection === "quarantined") filter.blocked = true;
    const rows = await store.ingredientBatches
        .find(filter)
        .sort({ expiresOn: 1, createdAt: -1 })
        .limit(1000)
        .toArray(),
      ingredients = await store.ingredients
        .find({})
        .sort({ name: 1 })
        .toArray();
    const totals = await store.ingredientBatches
      .aggregate([
        {
          $match: {
            remaining: { $gt: 0 },
            blocked: { $ne: true },
            $or: [{ expiresOn: null }, { expiresOn: { $gte: today } }],
          },
        },
        { $group: { _id: "$ingredientId", quantity: { $sum: "$remaining" } } },
      ])
      .toArray();
    const [alerts] = await store.ingredientBatches
      .aggregate([
        {
          $match: {
            remaining: { $gt: 0 },
            ...(req.query.ingredient
              ? { ingredientId: requireId(req.query.ingredient) }
              : {}),
          },
        },
        {
          $facet: {
            expired: [
              { $match: { expiresOn: { $type: "string", $lt: today } } },
              { $count: "count" },
            ],
            soon: [
              { $match: { expiresOn: { $gte: today, $lte: soon } } },
              { $count: "count" },
            ],
            quarantined: [{ $match: { blocked: true } }, { $count: "count" }],
          },
        },
      ])
      .toArray();
    res.json({
      today,
      soonThrough: soon,
      alerts: {
        expired: alerts?.expired?.[0]?.count || 0,
        soon: alerts?.soon?.[0]?.count || 0,
        quarantined: alerts?.quarantined?.[0]?.count || 0,
      },
      batches: rows.map((row) => ({
        ...batchView(row, today),
        expiringSoon: Boolean(
          row.expiresOn && row.expiresOn >= today && row.expiresOn <= soon,
        ),
      })),
      more: rows.length === 1000,
      ingredients: ingredients.map((row) => ({
        id: String(row._id),
        name: row.name,
        unit: row.unit,
        stock: row.stock,
        batchTracked: Boolean(row.batchTracked),
        revision: row.revision || 0,
        usableStock: row.batchTracked
          ? totals.find((item) => item._id.equals(row._id))?.quantity || 0
          : row.stock,
      })),
    });
  });
  api.post("/inventory/batches/enable", requireAdmin, async (req, res) => {
    const input = body(
      z
        .strictObject({
          ingredientId: z.string().regex(/^[a-f0-9]{24}$/),
          expectedRevision: z.number().int().min(0),
          batch: batchInput.optional(),
          batches: z
            .array(
              batchInput.extend({
                quantity: z.number().int().min(0).max(stockLimit),
              }),
            )
            .min(1)
            .max(30)
            .optional(),
          reason,
        })
        .refine(
          (value) => Boolean(value.batch) !== Boolean(value.batches),
          "Provide opening batch details.",
        ),
      req.body,
    );
    const row = await transaction(store, async (session) => {
      const ingredient = await store.ingredients.findOneAndUpdate(
        {
          _id: requireId(input.ingredientId),
          batchTracked: { $ne: true },
          revision: input.expectedRevision,
        },
        { $set: { batchTracked: true }, $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!ingredient)
        throw new HttpError(
          409,
          "INVENTORY_UPDATED",
          "This ingredient changed or already uses batch tracking. Refresh first.",
        );
      const opening = input.batches || [
        { ...input.batch, quantity: ingredient.stock },
      ];
      if (
        opening.reduce((sum, item) => sum + item.quantity, 0) !==
          ingredient.stock ||
        new Set(opening.map((item) => item.code)).size !== opening.length
      )
        throw new HttpError(
          409,
          "BATCH_OPENING_BALANCE",
          "Opening batch quantities must match the current stock exactly, with a unique code for each batch.",
        );
      const rows = [];
      for (const item of opening)
        rows.push(
          await addIngredientBatch(
            store,
            ingredient,
            item.quantity,
            item,
            session,
            { origin: "opening_balance" },
          ),
        );
      await store.audit.insertOne(
        {
          type: "inventory.batch_tracking_enabled",
          ingredientId: ingredient._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return rows;
    });
    res
      .status(201)
      .json({
        batch: batchView(row[0]),
        batches: row.map((item) => batchView(item)),
      });
  });
  api.post("/inventory/batches/:id/status", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: z.number().int().min(0),
          expiresOn: calendarDate.nullable().optional(),
          noExpiry: z.boolean(),
          blocked: z.boolean(),
          reason,
        }),
        req.body,
      ),
      id = requireId(req.params.id),
      expiresOn = expiry(input);
    const result = await transaction(store, async (session) => {
      const previous = await store.ingredientBatches.findOne(
        { _id: id },
        { session },
      );
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Batch not found.");
      await store.ingredients.updateOne(
        { _id: previous.ingredientId },
        { $inc: { revision: 1 } },
        { session },
      );
      const row = await store.ingredientBatches.findOneAndUpdate(
        { _id: id, revision: input.expectedRevision },
        {
          $set: { expiresOn, blocked: input.blocked, needsReview: false },
          $inc: { revision: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "BATCH_UPDATED",
          "This batch changed. Refresh before reviewing it.",
        );
      await store.audit.insertOne(
        {
          type: "inventory.batch_reviewed",
          batchId: id,
          ingredientId: row.ingredientId,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.json({ batch: batchView(result) });
  });
}
