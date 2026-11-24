import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key, patch } from "./support.js";
import { runPurchaseSuggestions } from "../server/purchase-suggestions.js";
async function setup(f) {
  const ingredient = ok(
      await post(f.staff.admin, "/api/staff/inventory/ingredients", {
        name: "Suggested rice",
        unit: "g",
        initialStock: 20,
        reorderLevel: 100,
      }),
      201,
    ).ingredient,
    supplier = ok(
      await post(f.staff.admin, "/api/staff/suppliers", {
        name: "Suggestion supplier",
        email: "",
        active: true,
      }),
      201,
    ).supplier;
  const rule = {
    supplierId: supplier.id,
    targetStock: 500,
    packQuantity: 100,
    minimumQuantity: 100,
    unitPriceMinor: 2000,
    pricePerQuantity: 100,
    enabled: true,
    expectedRevision: 0,
    reason: "Supplier quote and packaging confirmed",
  };
  ok(
    await f.staff.admin(
      "/api/staff/purchase-suggestions/rules/" + ingredient.id,
      { method: "PUT", data: rule },
    ),
  );
  return { ingredient, supplier, rule };
}
test("automatic purchase suggestions round packaging, deduct planned drafts, and never order or pay without approval", async (t) => {
  const f = await fixture(t),
    { ingredient } = await setup(f);
  let rows = ok(await f.staff.admin("/api/staff/purchase-suggestions")).rows;
  assert.equal(rows[0].suggestedQuantity, 500);
  const results = await Promise.all([
    post(f.staff.admin, "/api/staff/purchase-suggestions/drafts", {
      ingredientIds: [ingredient.id],
    }),
    post(f.staff.admin, "/api/staff/purchase-suggestions/drafts", {
      ingredientIds: [ingredient.id],
    }),
  ]);
  results.forEach((r) => ok(r, 201));
  assert.equal(await f.store.purchases.countDocuments({}), 1);
  const purchase = await f.store.purchases.findOne({});
  assert.equal(purchase.status, "draft");
  assert.equal(purchase.lines[0].quantity, 500);
  assert.equal(await f.store.supplierPayments.countDocuments({}), 0);
  rows = ok(await f.staff.admin("/api/staff/purchase-suggestions")).rows;
  assert.equal(rows[0].planned, 500);
  assert.equal(rows[0].suggestedQuantity, 0);
  error(await f.staff.kitchen("/api/staff/purchase-suggestions"), 403);
});
test("cancelled drafts do not permanently consume a suggestion key and approved incoming goods reduce the shortage", async (t) => {
  const f = await fixture(t),
    { ingredient } = await setup(f);
  let purchase = ok(
    await post(f.staff.admin, "/api/staff/purchase-suggestions/drafts", {
      ingredientIds: [ingredient.id],
    }),
    201,
  ).purchases[0];
  ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/action",
      {
        action: "cancel",
        expectedRevision: 0,
        reason: "Supplier quote needs replacement",
      },
    ),
  );
  purchase = ok(
    await post(f.staff.admin, "/api/staff/purchase-suggestions/drafts", {
      ingredientIds: [ingredient.id],
    }),
    201,
  ).purchases[0];
  assert.equal(purchase.status, "draft");
  assert.equal(await f.store.purchases.countDocuments({}), 2);
  ok(
    await post(
      f.staff.admin,
      "/api/staff/purchases/" + purchase.id + "/action",
      {
        action: "order",
        expectedRevision: 0,
        reason: "Manager approved replenishment",
      },
    ),
  );
  const row = ok(await f.staff.admin("/api/staff/purchase-suggestions"))
    .rows[0];
  assert.equal(row.onOrder, 500);
  assert.equal(row.suggestedQuantity, 0);
});
test("expired and blocked batches are excluded and stale or missing supplier rules cannot silently create orders", async (t) => {
  const f = await fixture(t),
    { ingredient, supplier, rule } = await setup(f),
    id = new ObjectId(ingredient.id);
  await f.store.ingredients.updateOne(
    { _id: id },
    { $set: { stock: 1000, batchTracked: true } },
  );
  await f.store.ingredientBatches.insertMany([
    {
      ingredientId: id,
      code: "AVAILABLE",
      remaining: 100,
      blocked: false,
      expiresOn: "2099-01-01",
    },
    {
      ingredientId: id,
      code: "BLOCKED",
      remaining: 400,
      blocked: true,
      expiresOn: "2099-01-01",
    },
    {
      ingredientId: id,
      code: "EXPIRED",
      remaining: 500,
      blocked: false,
      expiresOn: "2000-01-01",
    },
  ]);
  let row = ok(await f.staff.admin("/api/staff/purchase-suggestions")).rows[0];
  assert.equal(row.usableStock, 100);
  assert.equal(row.suggestedQuantity, 400);
  error(
    await f.staff.admin(
      "/api/staff/purchase-suggestions/rules/" + ingredient.id,
      { method: "PUT", data: rule },
    ),
    409,
    "RULE_UPDATED",
  );
  await f.store.suppliers.updateOne(
    { _id: new ObjectId(supplier.id) },
    { $set: { active: false } },
  );
  row = ok(await f.staff.admin("/api/staff/purchase-suggestions")).rows[0];
  assert.equal(row.configured, false);
  assert.equal(row.suggestedQuantity, 0);
});
test("opt-in purchase automation creates drafts once and stops when its author loses access", async (t) => {
  const f = await fixture(t);
  await setup(f);
  await runPurchaseSuggestions(f.store, f.config);
  assert.equal(await f.store.purchases.countDocuments({}), 0);
  ok(
    await patch(f.staff.admin, "/api/staff/purchase-suggestions/automation", {
      enabled: true,
      reason: "Enable reviewed automatic draft preparation",
    }),
  );
  await runPurchaseSuggestions(f.store, f.config);
  await runPurchaseSuggestions(f.store, f.config);
  assert.equal(await f.store.purchases.countDocuments({}), 1);
  await f.store.staff.updateOne(
    { username: "admin" },
    { $inc: { authVersion: 1 } },
  );
  await f.store.settings.updateOne(
    { _id: "purchase-suggestion-policy" },
    { $set: { nextAt: new Date(0) } },
  );
  await runPurchaseSuggestions(f.store, f.config);
  assert.equal(
    (await f.store.settings.findOne({ _id: "purchase-suggestion-policy" }))
      .enabled,
    false,
  );
});
