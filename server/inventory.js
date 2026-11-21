import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import {
  batchInput,
  manualBatchChange,
  orderBatchChange,
} from "./ingredient-batches.js";

const limit = 1_000_000_000;
const positive = z.number().int().min(1).max(limit);
const quantity = z.number().int().min(0).max(limit);
const reason = z.string().trim().min(3).max(160);
const ingredientLine = z.strictObject({
  ingredientId: z
    .string()
    .toLowerCase()
    .regex(/^[a-f0-9]{24}$/),
  quantity: positive,
});
const lines = z
  .array(ingredientLine)
  .max(30)
  .refine(
    (rows) => new Set(rows.map((row) => row.ingredientId)).size === rows.length,
    "Use each ingredient once in a recipe group.",
  );
const group = z.strictObject({
  optionId: z.string().min(1).max(40),
  ingredients: lines,
});
const recipeInput = z.strictObject({
  expectedRevision: z.number().int().min(0),
  enabled: z.boolean(),
  base: lines,
  variants: z.array(group).max(30),
  addons: z.array(group).max(30),
  reason,
});
const view = (row) => ({
  id: row._id.toString(),
  name: row.name,
  unit: row.unit,
  stock: row.stock,
  reorderLevel: row.reorderLevel,
  revision: row.revision || 0,
  low: row.stock <= row.reorderLevel,
  batchTracked: Boolean(row.batchTracked),
});
const lineKey = (item) =>
  [
    item.dishId,
    item.variant?.id || "",
    (item.addons || [])
      .map((addon) => addon.id)
      .sort()
      .join(","),
  ].join("|");
function totalUsage(snapshot, items) {
  const result = new Map();
  for (const item of items) {
    const line = snapshot.find((line) => line.key === lineKey(item));
    for (const ingredient of line?.ingredients || [])
      result.set(
        ingredient.ingredientId,
        (result.get(ingredient.ingredientId) || 0) +
          ingredient.quantity * item.quantity,
      );
  }
  return [...result]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ingredientId, quantity]) => ({ ingredientId, quantity }));
}
async function applyUsage(store, order, previous, next, session, by, kind) {
  let batchAllocations = [...(order.inventory?.batchAllocations || [])];
  const ids = [
    ...new Set([...previous, ...next].map((row) => row.ingredientId)),
  ].sort();
  for (const id of ids) {
    const old = previous.find((row) => row.ingredientId === id)?.quantity || 0,
      needed = next.find((row) => row.ingredientId === id)?.quantity || 0;
    const delta = old - needed;
    if (!delta) continue;
    const ingredient = await store.ingredients.findOneAndUpdate(
      {
        _id: new ObjectId(id),
        stock: { $gte: Math.max(0, -delta), $lte: limit - Math.max(0, delta) },
      },
      { $inc: { stock: delta, revision: 1 } },
      { session, returnDocument: "after" },
    );
    if (!ingredient)
      throw new HttpError(
        409,
        "STOCK_LOW",
        "An ingredient has insufficient stock or its stock limit would be exceeded. Review inventory before sending or changing this order.",
      );
    const allocations = await orderBatchChange(
      store,
      ingredient,
      delta,
      batchAllocations,
      session,
      order,
    );
    batchAllocations = [
      ...batchAllocations.filter((item) => item.ingredientId !== id),
      ...allocations,
    ];
    await store.stockMovements.insertOne(
      {
        key:
          "order:" + order._id + ":" + ((order.revision || 0) + 1) + ":" + id,
        ingredientId: ingredient._id,
        ingredientName: ingredient.name,
        unit: ingredient.unit,
        delta,
        balance: ingredient.stock,
        orderId: order._id,
        orderCode: order.code,
        kind,
        batchAllocations: allocations,
        by,
        at: new Date(),
      },
      { session },
    );
  }
  return batchAllocations;
}

export async function reserveOrderInventory(store, order, session, by) {
  const recipes = new Map();
  for (const dishId of [
    ...new Set(order.items.map((item) => item.dishId)),
  ].sort()) {
    // Recipe changes and acceptance both write the dish before reading recipes.
    await store.dishes.updateOne(
      { _id: dishId },
      { $inc: { orderRevision: 1 } },
      { session },
    );
    recipes.set(
      dishId,
      await store.recipes.findOne({ _id: dishId, enabled: true }, { session }),
    );
  }
  const snapshot = order.items.map((item) => {
    const recipe = recipes.get(item.dishId);
    const selected = recipe
      ? [
          ...recipe.base,
          ...(recipe.variants.find(
            (option) => option.optionId === item.variant?.id,
          )?.ingredients || []),
          ...(item.addons || []).flatMap(
            (addon) =>
              recipe.addons.find((option) => option.optionId === addon.id)
                ?.ingredients || [],
          ),
        ]
      : [];
    const combined = new Map();
    for (const row of selected)
      combined.set(
        row.ingredientId,
        (combined.get(row.ingredientId) || 0) + row.quantity,
      );
    return {
      key: lineKey(item),
      ingredients: [...combined].map(([ingredientId, quantity]) => ({
        ingredientId,
        quantity,
      })),
    };
  });
  const totals = totalUsage(snapshot, order.items);
  const batchAllocations = await applyUsage(
    store,
    order,
    [],
    totals,
    session,
    by,
    "order_reserved",
  );
  return {
    state: "reserved",
    lines: snapshot,
    totals,
    batchAllocations,
    reservedAt: new Date(),
  };
}
export async function changeOrderInventory(store, order, items, session, by) {
  if (order.inventory?.state !== "reserved") return order.inventory || null;
  const totals = totalUsage(order.inventory.lines, items);
  const batchAllocations = await applyUsage(
    store,
    order,
    order.inventory.totals,
    totals,
    session,
    by,
    items.length ? "order_changed" : "order_released",
  );
  return {
    ...order.inventory,
    totals,
    batchAllocations,
    state: items.length ? "reserved" : "released",
    updatedAt: new Date(),
  };
}

export function registerInventory(
  api,
  store,
  requireAdmin,
  requireId,
  inventoryRoles,
) {
  api.get("/inventory", inventoryRoles, async (req, res) => {
    const [ingredients, recipes, dishes, movements] = await Promise.all([
      store.ingredients.find({}).sort({ name: 1 }).limit(500).toArray(),
      store.recipes.find({}).toArray(),
      store.dishes.find({}).sort({ position: 1 }).toArray(),
      store.stockMovements.find({}).sort({ at: -1 }).limit(100).toArray(),
    ]);
    res.json({
      ingredients: ingredients.map(view),
      dishes: dishes.map((dish) => ({
        id: dish._id,
        name: dish.name,
        variants: dish.variants || [],
        addons: dish.addons || [],
        recipe: recipes.find((recipe) => recipe._id === dish._id) || null,
      })),
      movements: movements.map(
        ({
          _id,
          ingredientName,
          delta,
          balance,
          unit,
          kind,
          by,
          at,
          reason,
          reference,
          orderCode,
        }) => ({
          id: _id.toString(),
          ingredientName,
          delta,
          balance,
          unit,
          kind,
          by,
          at,
          reason,
          reference,
          orderCode,
        }),
      ),
    });
  });
  api.post("/inventory/ingredients", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        name: z.string().trim().min(2).max(80),
        unit: z.enum(["g", "ml", "pcs"]),
        initialStock: quantity,
        reorderLevel: quantity,
      }),
      req.body,
    );
    try {
      const ingredient = await transaction(store, async (session) => {
        await store.settings.updateOne(
          { _id: "inventory-setup-lock" },
          { $inc: { revision: 1 } },
          { session, upsert: true },
        );
        if ((await store.ingredients.countDocuments({}, { session })) >= 500)
          throw new HttpError(
            409,
            "INVENTORY_LIMIT",
            "Ingredient limit reached.",
          );
        const row = {
          _id: new ObjectId(),
          name: input.name,
          nameKey: input.name.toLocaleLowerCase("en"),
          unit: input.unit,
          stock: input.initialStock,
          reorderLevel: input.reorderLevel,
          revision: 0,
          createdAt: new Date(),
        };
        await store.ingredients.insertOne(row, { session });
        await store.stockMovements.insertOne(
          {
            key: "opening:" + row._id,
            ingredientId: row._id,
            ingredientName: row.name,
            unit: row.unit,
            delta: row.stock,
            balance: row.stock,
            kind: "opening",
            by: req.staff.username,
            at: new Date(),
          },
          { session },
        );
        return row;
      });
      res.status(201).json({ ingredient: view(ingredient) });
    } catch (error) {
      if (error.code === 11000)
        throw new HttpError(
          409,
          "INGREDIENT_EXISTS",
          "An ingredient already uses this name.",
        );
      throw error;
    }
  });
  api.patch("/inventory/ingredients/:id", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        name: z.string().trim().min(2).max(80),
        reorderLevel: quantity,
        expectedRevision: z.number().int().min(0),
        reason,
      }),
      req.body,
    );
    try {
      const result = await transaction(store, async (session) => {
        const row = await store.ingredients.findOneAndUpdate(
          { _id: requireId(req.params.id), revision: input.expectedRevision },
          {
            $set: {
              name: input.name,
              nameKey: input.name.toLocaleLowerCase("en"),
              reorderLevel: input.reorderLevel,
            },
            $inc: { revision: 1 },
          },
          { session, returnDocument: "after" },
        );
        if (!row)
          throw new HttpError(
            409,
            "INVENTORY_UPDATED",
            "This ingredient changed. Refresh inventory.",
          );
        await store.audit.insertOne(
          {
            type: "inventory.ingredient_updated",
            ingredientId: row._id,
            by: req.staff.username,
            reason: input.reason,
            at: new Date(),
          },
          { session },
        );
        return row;
      });
      res.json({ ingredient: view(result) });
    } catch (error) {
      if (error.code === 11000)
        throw new HttpError(
          409,
          "INGREDIENT_EXISTS",
          "An ingredient already uses this name.",
        );
      throw error;
    }
  });
  api.post(
    "/inventory/ingredients/:id/stock",
    inventoryRoles,
    async (req, res) => {
      const input = body(
        z.strictObject({
          kind: z.enum(["receive", "waste", "correction"]),
          quantity: z
            .number()
            .int()
            .min(-limit)
            .max(limit)
            .refine((n) => n !== 0),
          reason,
          reference: z.string().trim().max(80).default(""),
          requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
          batch: batchInput.optional(),
          batchId: z
            .string()
            .regex(/^[a-f0-9]{24}$/)
            .optional(),
        }),
        req.body,
      );
      if (input.kind !== "correction" && input.quantity < 0)
        throw new HttpError(
          400,
          "INVALID_STOCK",
          "Use a positive quantity for received stock or waste.",
        );
      if (req.staff.role !== "admin" && input.kind !== "waste")
        throw new HttpError(
          403,
          "FORBIDDEN",
          "Kitchen can record waste; an administrator receives or corrects stock.",
        );
      const id = requireId(req.params.id),
        fingerprint = hash(
          JSON.stringify({
            id,
            kind: input.kind,
            quantity: input.quantity,
            reason: input.reason,
            reference: input.reference,
            batch: input.batch,
            batchId: input.batchId,
          }),
        );
      const ingredient = await transaction(store, async (session) => {
        const prior = await store.stockMovements.findOne(
          { key: "manual:" + input.requestKey },
          { session },
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new HttpError(
              409,
              "REQUEST_REUSED",
              "This key belongs to another stock movement.",
            );
          return store.ingredients.findOne({ _id: id }, { session });
        }
        const delta = input.kind === "waste" ? -input.quantity : input.quantity;
        const row = await store.ingredients.findOneAndUpdate(
          {
            _id: id,
            stock: {
              $gte: Math.max(0, -delta),
              $lte: limit - Math.max(0, delta),
            },
          },
          { $inc: { stock: delta, revision: 1 } },
          { session, returnDocument: "after" },
        );
        if (!row)
          throw new HttpError(
            409,
            "STOCK_LOW",
            "Stock cannot become negative or exceed its limit.",
          );
        const batches = await manualBatchChange(
          store,
          row,
          delta,
          input,
          session,
        );
        await store.stockMovements.insertOne(
          {
            key: "manual:" + input.requestKey,
            fingerprint,
            ingredientId: row._id,
            ingredientName: row.name,
            unit: row.unit,
            delta,
            balance: row.stock,
            kind: input.kind,
            batches,
            by: req.staff.username,
            reason: input.reason,
            reference: input.reference,
            at: new Date(),
          },
          { session },
        );
        return row;
      });
      res.json({ ingredient: view(ingredient) });
    },
  );
  api.post("/inventory/recipes/:dish", requireAdmin, async (req, res) => {
    const input = body(recipeInput, req.body);
    const result = await transaction(store, async (session) => {
      const dish = await store.dishes.findOneAndUpdate(
        { _id: req.params.dish },
        { $inc: { orderRevision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!dish) throw new HttpError(404, "NOT_FOUND", "Dish not found.");
      const existing = await store.recipes.findOne(
        { _id: dish._id },
        { session },
      );
      if ((existing?.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "RECIPE_UPDATED",
          "This recipe changed. Refresh it first.",
        );
      for (const [kind, options] of [
        ["variants", dish.variants || []],
        ["addons", dish.addons || []],
      ]) {
        if (
          new Set(input[kind].map((row) => row.optionId)).size !==
            input[kind].length ||
          input[kind].some(
            (row) => !options.some((option) => option.id === row.optionId),
          )
        )
          throw new HttpError(
            400,
            "INVALID_RECIPE",
            "A recipe option does not exist or is repeated.",
          );
      }
      const all = [
        ...input.base,
        ...input.variants.flatMap((row) => row.ingredients),
        ...input.addons.flatMap((row) => row.ingredients),
      ];
      if (input.enabled && !all.length)
        throw new HttpError(
          400,
          "INVALID_RECIPE",
          "An enabled recipe needs at least one ingredient.",
        );
      const ids = [...new Set(all.map((row) => row.ingredientId))].sort();
      for (const id of ids)
        if (
          !(await store.ingredients.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $inc: { revision: 1 } },
            { session },
          ))
        )
          throw new HttpError(
            400,
            "INVALID_RECIPE",
            "A selected ingredient no longer exists.",
          );
      const recipe = {
        _id: dish._id,
        enabled: input.enabled,
        base: input.base,
        variants: input.variants,
        addons: input.addons,
        revision: (existing?.revision || 0) + 1,
        updatedAt: new Date(),
        updatedBy: req.staff.username,
      };
      await store.recipes.replaceOne({ _id: dish._id }, recipe, {
        session,
        upsert: true,
      });
      await store.audit.insertOne(
        {
          type: "inventory.recipe_updated",
          dishId: dish._id,
          recipe,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return recipe;
    });
    res.json({ recipe: result });
  });
}
