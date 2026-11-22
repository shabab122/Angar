import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";
import { hash } from "./security.js";
import { moveInventoryValue } from "./inventory-cost.js";
const id = z.string().regex(/^[a-f0-9]{24}$/),
  key = z.string().regex(/^[a-f0-9]{32}$/),
  qty = z.number().int().min(0).max(1_000_000_000),
  reason = z.string().trim().min(3).max(160);
const view = (row) => ({
  ...row,
  id: String(row._id),
  _id: undefined,
  requestKey: undefined,
  fingerprint: undefined,
  reviewKey: undefined,
});
async function snapshot(store, ingredientId, session) {
  const ingredient = await store.ingredients.findOne(
    { _id: new ObjectId(ingredientId) },
    { session },
  );
  if (!ingredient)
    throw new HttpError(404, "NOT_FOUND", "Ingredient not found.");
  const batches = ingredient.batchTracked
    ? await store.ingredientBatches
        .find({ ingredientId: ingredient._id }, { session })
        .sort({ createdAt: 1 })
        .limit(201)
        .toArray()
    : [];
  if (batches.length > 200)
    throw new HttpError(
      409,
      "STOCKTAKE_LIMIT",
      "This ingredient exceeds the 200-lot count limit. Review its lot records with the operator.",
    );
  if (
    ingredient.batchTracked &&
    batches.reduce((s, b) => s + b.remaining, 0) !== ingredient.stock
  )
    throw new HttpError(
      409,
      "BATCH_BALANCE",
      "Batch balances do not match physical available stock. Review inventory.",
    );
  return {
    ingredientId: String(ingredient._id),
    name: ingredient.name,
    unit: ingredient.unit,
    expected: ingredient.stock,
    ingredientRevision: ingredient.revision || 0,
    batchTracked: Boolean(ingredient.batchTracked),
    batches: batches.map((b) => ({
      id: String(b._id),
      code: b.code,
      expected: b.remaining,
      revision: b.revision || 0,
    })),
    counted: null,
  };
}
export function registerStocktakes(
  api,
  store,
  requireAdmin,
  inventoryRoles,
  requireId,
) {
  api.get("/stocktakes", inventoryRoles, async (req, res) => {
    const rows = await store.stocktakes
      .find({}, { projection: { items: 0 } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json({ stocktakes: rows.map(view) });
  });
  api.get("/stocktakes/:id", inventoryRoles, async (req, res) => {
    const row = await store.stocktakes.findOne({
      _id: requireId(req.params.id),
    });
    if (!row) throw new HttpError(404, "NOT_FOUND", "Stocktake not found.");
    res.json({ stocktake: view(row) });
  });
  api.post("/stocktakes", inventoryRoles, async (req, res) => {
    const input = body(
        z.strictObject({
          ingredientIds: z
            .array(id)
            .min(1)
            .max(30)
            .refine((a) => new Set(a).size === a.length),
          reason,
          requestKey: key,
        }),
        req.body,
      ),
      fingerprint = hash(JSON.stringify(input));
    const row = await transaction(store, async (session) => {
      await store.settings.updateOne(
        { _id: "stocktake-setup-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const old = await store.stocktakes.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another count.",
          );
        return old;
      }
      const items = [];
      for (const ingredientId of [...input.ingredientIds].sort())
        items.push(await snapshot(store, ingredientId, session));
      const row = {
        _id: new ObjectId(),
        code: "ST-" + new ObjectId().toString().slice(-10).toUpperCase(),
        status: "counting",
        revision: 0,
        items,
        reason: input.reason,
        createdBy: req.staff.username,
        createdAt: new Date(),
        requestKey: input.requestKey,
        fingerprint,
      };
      await store.stocktakes.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "inventory.stocktake_created",
          stocktakeId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ stocktake: view(row) });
  });
  api.post("/stocktakes/:id/count", inventoryRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        ingredientId: id,
        expectedRevision: z.number().int().min(0),
        counted: qty.optional(),
        batches: z
          .array(z.strictObject({ batchId: id, counted: qty }))
          .max(200)
          .optional(),
      }),
      req.body,
    );
    const row = await transaction(store, async (session) => {
      const row = await store.stocktakes.findOneAndUpdate(
        {
          _id: requireId(req.params.id),
          status: "counting",
          revision: input.expectedRevision,
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "COUNT_UPDATED",
          "This count changed. Refresh before recording.",
        );
      const item = row.items.find((i) => i.ingredientId === input.ingredientId);
      if (!item)
        throw new HttpError(
          400,
          "COUNT_ITEM",
          "Ingredient is not in this count.",
        );
      if (item.batchTracked) {
        if (
          input.counted !== undefined ||
          !input.batches ||
          input.batches.length !== item.batches.length ||
          new Set(input.batches.map((b) => b.batchId)).size !==
            item.batches.length ||
          input.batches.some(
            (b) => !item.batches.some((old) => old.id === b.batchId),
          )
        )
          throw new HttpError(
            400,
            "COUNT_LOTS",
            "Count every listed batch exactly once.",
          );
        item.batches = item.batches.map((b) => ({
          ...b,
          counted: input.batches.find((i) => i.batchId === b.id).counted,
        }));
        item.counted = item.batches.reduce((s, b) => s + b.counted, 0);
      } else {
        if (input.counted === undefined || input.batches)
          throw new HttpError(
            400,
            "COUNT_QUANTITY",
            "Enter the available stock count.",
          );
        item.counted = input.counted;
      }
      if (item.counted > 1_000_000_000)
        throw new HttpError(
          400,
          "COUNT_LIMIT",
          "The total count exceeds the inventory limit.",
        );
      item.countedBy = req.staff.username;
      item.countedAt = new Date();
      await store.stocktakes.updateOne(
        { _id: row._id },
        { $set: { items: row.items } },
        { session },
      );
      return row;
    });
    res.json({ stocktake: view(row) });
  });
  api.post("/stocktakes/:id/refresh", inventoryRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        ingredientId: id,
        expectedRevision: z.number().int().min(0),
        reason,
      }),
      req.body,
    );
    const row = await transaction(store, async (session) => {
      const row = await store.stocktakes.findOneAndUpdate(
        {
          _id: requireId(req.params.id),
          status: { $in: ["counting", "submitted"] },
          revision: input.expectedRevision,
        },
        { $inc: { revision: 1 }, $set: { status: "counting" } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(409, "COUNT_UPDATED", "Refresh the count first.");
      if (!row.items.some((i) => i.ingredientId === input.ingredientId))
        throw new HttpError(
          400,
          "COUNT_ITEM",
          "Ingredient is not part of this count.",
        );
      const next = await snapshot(store, input.ingredientId, session);
      row.items = row.items.map((i) =>
        i.ingredientId === input.ingredientId ? next : i,
      );
      await store.stocktakes.updateOne(
        { _id: row._id },
        { $set: { items: row.items } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "inventory.stocktake_recount",
          stocktakeId: row._id,
          ingredientId: new ObjectId(input.ingredientId),
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.json({ stocktake: view(row) });
  });
  api.post("/stocktakes/:id/submit", inventoryRoles, async (req, res) => {
    const input = body(
      z.strictObject({ expectedRevision: z.number().int().min(0) }),
      req.body,
    );
    const row = await store.stocktakes.findOneAndUpdate(
      {
        _id: requireId(req.params.id),
        status: "counting",
        revision: input.expectedRevision,
        items: { $not: { $elemMatch: { counted: null } } },
      },
      {
        $set: {
          status: "submitted",
          submittedBy: req.staff.username,
          submittedAt: new Date(),
        },
        $inc: { revision: 1 },
      },
      { returnDocument: "after" },
    );
    if (!row)
      throw new HttpError(
        409,
        "COUNT_INCOMPLETE",
        "Count every ingredient and refresh before submitting.",
      );
    res.json({ stocktake: view(row) });
  });
  api.post("/stocktakes/:id/decision", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        decision: z.enum(["approve", "reject"]),
        expectedRevision: z.number().int().min(0),
        reason,
        requestKey: key,
      }),
      req.body,
    );
    const result = await transaction(store, async (session) => {
      const row = await store.stocktakes.findOne(
        { _id: requireId(req.params.id) },
        { session },
      );
      if (row?.reviewKey === input.requestKey) {
        if (row.reviewFingerprint !== hash(JSON.stringify(input)))
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This review key was already used differently.",
          );
        return row;
      }
      if (
        !row ||
        row.status !== "submitted" ||
        row.revision !== input.expectedRevision
      )
        throw new HttpError(
          409,
          "COUNT_UPDATED",
          "Only an unchanged submitted count can be reviewed.",
        );
      if (input.decision === "approve")
        for (const item of row.items) {
          const delta = item.counted - item.expected;
          const ingredient = await store.ingredients.findOneAndUpdate(
            {
              _id: new ObjectId(item.ingredientId),
              stock: item.expected,
              revision: item.ingredientRevision,
            },
            { $inc: { stock: delta, revision: 1 } },
            { session, returnDocument: "after" },
          );
          if (!ingredient)
            throw new HttpError(
              409,
              "COUNT_STALE",
              "Stock activity changed after the snapshot. Refresh this ingredient and recount before approval.",
            );
          if (item.batchTracked)
            for (const batch of item.batches) {
              const update = await store.ingredientBatches.updateOne(
                {
                  _id: new ObjectId(batch.id),
                  remaining: batch.expected,
                  revision: batch.revision,
                },
                { $set: { remaining: batch.counted }, $inc: { revision: 1 } },
                { session },
              );
              if (!update.matchedCount)
                throw new HttpError(
                  409,
                  "COUNT_STALE",
                  "Batch activity changed. Recount before approval.",
                );
            }
          let cost = null;
          if (delta)
            cost = await moveInventoryValue(store, ingredient, delta, session);
          if (delta)
            await store.stockMovements.insertOne(
              {
                key: "stocktake:" + row._id + ":" + item.ingredientId,
                ingredientId: ingredient._id,
                ingredientName: item.name,
                unit: item.unit,
                kind: "stocktake_adjustment",
                delta,
                balance: item.counted,
                cost,
                stocktakeId: row._id,
                reason: input.reason,
                by: req.staff.username,
                at: new Date(),
              },
              { session },
            );
        }
      const changes = {
        status: input.decision === "approve" ? "approved" : "rejected",
        reviewedBy: req.staff.username,
        reviewedAt: new Date(),
        reviewReason: input.reason,
        reviewKey: input.requestKey,
        reviewFingerprint: hash(JSON.stringify(input)),
      };
      await store.stocktakes.updateOne(
        { _id: row._id },
        { $set: changes, $inc: { revision: 1 } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "inventory.stocktake_" + changes.status,
          stocktakeId: row._id,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { ...row, ...changes, revision: row.revision + 1 };
    });
    res.json({ stocktake: view(result) });
  });
}
