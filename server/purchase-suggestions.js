import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import { effectiveStaff, assertStaffAction, hasPermission } from "./access.js";
import { stockDay, stockLimit } from "./ingredient-batches.js";
import { insertPurchaseDraft, purchaseView } from "./purchasing.js";
const id = z.string().regex(/^[a-f0-9]{24}$/),
  reason = z.string().trim().min(3).max(160);
export async function purchaseSuggestions(store, session) {
  const [ingredients, rules, batches, purchases] = await Promise.all([
    store.ingredients.find({}, { session }).limit(501).toArray(),
    store.purchaseRules.find({}, { session }).limit(501).toArray(),
    store.ingredientBatches
      .find(
        {
          remaining: { $gt: 0 },
          blocked: { $ne: true },
          $or: [{ expiresOn: { $gte: stockDay() } }, { expiresOn: null }],
        },
        { session },
      )
      .toArray(),
    store.purchases
      .find(
        { status: { $in: ["draft", "ordered", "partially_received"] } },
        { session },
      )
      .toArray(),
  ]);
  if (ingredients.length > 500 || rules.length > 500)
    throw new HttpError(
      409,
      "SUGGESTION_LIMIT",
      "Review inventory size before generating purchase suggestions.",
    );
  const suppliers = await store.suppliers
      .find({ active: true }, { session })
      .limit(1001)
      .toArray(),
    rows = [];
  for (const ingredient of ingredients) {
    const rule = rules.find((row) => row._id.equals(ingredient._id)),
      usable = ingredient.batchTracked
        ? batches
            .filter((row) => row.ingredientId.equals(ingredient._id))
            .reduce((s, row) => s + row.remaining, 0)
        : ingredient.stock;
    let onOrder = 0,
      planned = 0;
    for (const purchase of purchases)
      for (const line of purchase.lines)
        if (String(line.ingredientId) === String(ingredient._id)) {
          const outstanding = Math.max(
            0,
            line.quantity - line.receivedQuantity,
          );
          if (purchase.status === "draft") planned += outstanding;
          else onOrder += outstanding;
        }
    const supplier =
        rule && suppliers.find((row) => row._id.equals(rule.supplierId)),
      deficit = rule
        ? Math.max(0, rule.targetStock - usable - onOrder - planned)
        : 0,
      quantity =
        rule && deficit
          ? Math.ceil(
              Math.max(deficit, rule.minimumQuantity) / rule.packQuantity,
            ) * rule.packQuantity
          : 0;
    rows.push({
      ingredientId: String(ingredient._id),
      name: ingredient.name,
      unit: ingredient.unit,
      usableStock: usable,
      reorderLevel: ingredient.reorderLevel,
      onOrder,
      planned,
      low: usable <= ingredient.reorderLevel,
      configured: Boolean(rule?.enabled && supplier),
      supplierId: rule ? String(rule.supplierId) : "",
      supplierName: supplier?.name || "",
      targetStock:
        rule?.targetStock ?? Math.min(stockLimit, ingredient.reorderLevel * 2),
      packQuantity: rule?.packQuantity || 1,
      minimumQuantity: rule?.minimumQuantity || 1,
      unitPriceMinor: rule?.unitPriceMinor ?? null,
      pricePerQuantity: rule?.pricePerQuantity || 1,
      ruleRevision: rule?.revision || 0,
      enabled: rule?.enabled ?? false,
      suggestedQuantity:
        rule?.enabled && supplier && usable <= ingredient.reorderLevel
          ? quantity
          : 0,
    });
  }
  return {
    rows,
    day: stockDay(),
    policy:
      "Uses released, unexpired available stock. Ordered goods and existing purchase drafts reduce suggested quantities. Unreceived stock transfers are shown in the transfer desk and are not assumed usable. Purchase suggestions never approve an order or record supplier payment.",
  };
}
async function generate(store, actor, requested = null) {
  const generation = String(new ObjectId());
  return transaction(store, async (session) => {
    await assertStaffAction(store, actor, "purchase.create", session);
    await assertStaffAction(store, actor, "purchase.suggest", session);
    await store.settings.updateOne(
      { _id: "purchase-suggestions-lock" },
      { $inc: { revision: 1 } },
      { session, upsert: true },
    );
    const snapshot = await purchaseSuggestions(store, session),
      chosen = snapshot.rows.filter(
        (row) =>
          row.suggestedQuantity > 0 &&
          (!requested || requested.includes(row.ingredientId)),
      ),
      groups = new Map();
    for (const row of chosen) {
      if (row.suggestedQuantity > stockLimit)
        throw new HttpError(
          409,
          "SUGGESTION_QUANTITY",
          "A suggested quantity exceeds stock limits. Review its target and packaging rule.",
        );
      if (!groups.has(row.supplierId)) groups.set(row.supplierId, []);
      groups.get(row.supplierId).push(row);
    }
    const drafts = [];
    for (const [supplierId, items] of groups)
      for (let offset = 0; offset < items.length; offset += 30) {
        const rows = items.slice(offset, offset + 30),
          lines = rows.map((row) => ({
            ingredientId: row.ingredientId,
            quantity: row.suggestedQuantity,
            unitPriceMinor: row.unitPriceMinor,
            pricePerQuantity: row.pricePerQuantity,
          })),
          input = {
            supplierId,
            lines,
            dueOn: "",
            notes:
              "Stock replenishment suggestion. Review supplier prices, quantities and delivery date before ordering.",
            requestKey: hash(
              JSON.stringify({
                day: snapshot.day,
                rows,
                source: "suggestion",
                generation,
              }),
            ).slice(0, 32),
          };
        drafts.push(
          await insertPurchaseDraft(store, input, actor.username, session, {
            suggested: true,
            suggestionDay: snapshot.day,
          }),
        );
      }
    return drafts;
  });
}
export function registerPurchaseSuggestions(api, store, config, requireId) {
  api.get("/purchase-suggestions", async (req, res) => {
    const [snapshot, suppliers, policy] = await Promise.all([
      purchaseSuggestions(store),
      store.suppliers
        .find({ active: true })
        .sort({ name: 1 })
        .limit(1000)
        .toArray(),
      store.settings.findOne({ _id: "purchase-suggestion-policy" }),
    ]);
    res.json({
      ...snapshot,
      suppliers: suppliers.map((row) => ({
        id: String(row._id),
        name: row.name,
      })),
      autoEnabled: Boolean(policy?.enabled),
    });
  });
  api.put("/purchase-suggestions/rules/:id", async (req, res) => {
    const input = body(
        z.strictObject({
          supplierId: id,
          targetStock: z.number().int().min(1).max(stockLimit),
          packQuantity: z.number().int().min(1).max(stockLimit),
          minimumQuantity: z.number().int().min(1).max(stockLimit),
          unitPriceMinor: z.number().int().min(0).max(100000000),
          pricePerQuantity: z.number().int().min(1).max(1000000),
          enabled: z.boolean(),
          expectedRevision: z.number().int().min(0),
          reason,
        }),
        req.body,
      ),
      ingredientId = requireId(req.params.id);
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "purchase.suggest", session);
      await store.settings.updateOne(
        { _id: "purchase-suggestions-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const ingredient = await store.ingredients.findOne(
        { _id: ingredientId },
        { session },
      );
      if (!ingredient || input.targetStock < ingredient.reorderLevel)
        throw new HttpError(
          400,
          "SUGGESTION_TARGET",
          "Choose an existing ingredient and a target at least its reorder level.",
        );
      if (
        !(await store.suppliers.findOne(
          { _id: new ObjectId(input.supplierId), active: true },
          { session },
        ))
      )
        throw new HttpError(
          400,
          "SUPPLIER_REQUIRED",
          "Choose an active supplier.",
        );
      const old = await store.purchaseRules.findOne(
        { _id: ingredientId },
        { session },
      );
      if ((old?.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "RULE_UPDATED",
          "This rule changed. Reload it before saving.",
        );
      const { expectedRevision, reason, ...rule } = input;
      await store.purchaseRules.updateOne(
        { _id: ingredientId },
        {
          $set: {
            ...rule,
            supplierId: new ObjectId(rule.supplierId),
            updatedAt: new Date(),
            by: req.staff.username,
          },
          $inc: { revision: 1 },
        },
        { upsert: true, session },
      );
      await store.audit.insertOne(
        {
          type: "purchase.suggestion_rule",
          ingredientId,
          by: req.staff.username,
          reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.post("/purchase-suggestions/drafts", async (req, res) => {
    const input = body(
        z.strictObject({
          ingredientIds: z
            .array(id)
            .min(1)
            .max(100)
            .refine((rows) => new Set(rows).size === rows.length),
        }),
        req.body,
      ),
      drafts = await generate(store, req.staff, input.ingredientIds);
    res
      .status(201)
      .json({
        purchases: drafts.map(purchaseView),
        message: drafts.length
          ? "Drafts created. A manager must approve each purchase order."
          : "Existing stock, orders or drafts already cover these targets.",
      });
  });
  api.patch("/purchase-suggestions/automation", async (req, res) => {
    const input = body(
      z.strictObject({ enabled: z.boolean(), reason }),
      req.body,
    );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "purchase.suggest", session);
      await assertStaffAction(store, req.staff, "purchase.create", session);
      await store.settings.updateOne(
        { _id: "purchase-suggestion-policy" },
        {
          $set: {
            enabled: input.enabled,
            by: req.staff.username,
            staffId: req.staff._id,
            authVersion: req.staff.authVersion || 0,
            updatedAt: new Date(),
            nextAt: new Date(),
          },
        },
        { upsert: true, session },
      );
      await store.audit.insertOne(
        {
          type: "purchase.suggestion_automation",
          by: req.staff.username,
          enabled: input.enabled,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
}
export async function runPurchaseSuggestions(store, config) {
  const policy = await store.settings.findOneAndUpdate(
    {
      _id: "purchase-suggestion-policy",
      enabled: true,
      $or: [{ nextAt: { $lte: new Date() } }, { nextAt: { $exists: false } }],
    },
    { $set: { nextAt: new Date(Date.now() + 300000) } },
    { returnDocument: "after" },
  );
  if (!policy) return;
  const raw = await store.staff.findOne({ _id: policy.staffId, active: true }),
    actor = raw && effectiveStaff(raw, store.branchId);
  if (
    !actor ||
    (actor.authVersion || 0) !== policy.authVersion ||
    !hasPermission(actor, "purchase.create") ||
    !hasPermission(actor, "purchase.suggest")
  ) {
    await store.settings.updateOne(
      { _id: policy._id },
      { $set: { enabled: false, needsReview: true } },
    );
    return;
  }
  await generate(store, actor);
}
