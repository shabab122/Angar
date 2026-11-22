import { HttpError } from "./http.js";

export const ratioMinor = (amount, quantity, total) => {
  if (
    ![amount, quantity, total].every(Number.isSafeInteger) ||
    amount < 0 ||
    quantity < 0 ||
    total <= 0
  )
    throw new HttpError(409, "COST_DATA", "Inventory valuation needs review.");
  const result = Number(
    (BigInt(amount) * BigInt(quantity) + BigInt(total) / 2n) / BigInt(total),
  );
  if (!Number.isSafeInteger(result) || result > 1_000_000_000_000)
    throw new HttpError(
      400,
      "COST_LIMIT",
      "Inventory value exceeds the supported limit.",
    );
  return result;
};
// Called after the parent stock/revision update, in its transaction. Prices are
// weighted-average inventory values, kept separate from supplier balances.
export async function moveInventoryValue(
  store,
  ingredient,
  delta,
  session,
  received = null,
) {
  const before = ingredient.stock - delta,
    value = ingredient.inventoryValueMinor || 0;
  const complete = before === 0 || ingredient.costComplete === true;
  let amountMinor, knownQuantity;
  if (delta < 0) {
    const quantity = -delta;
    amountMinor = before ? ratioMinor(value, quantity, before) : 0;
    knownQuantity = complete ? quantity : 0;
    await store.ingredients.updateOne(
      { _id: ingredient._id },
      {
        $set: {
          inventoryValueMinor: value - amountMinor,
          costComplete: ingredient.stock === 0 || complete,
        },
      },
      { session },
    );
  } else {
    amountMinor = received?.amountMinor ?? 0;
    knownQuantity = received?.knownQuantity ?? 0;
    if (
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 0 ||
      value + amountMinor > 1_000_000_000_000 ||
      knownQuantity < 0 ||
      knownQuantity > delta
    )
      throw new HttpError(
        400,
        "COST_LIMIT",
        "Use a supported exact inventory value.",
      );
    await store.ingredients.updateOne(
      { _id: ingredient._id },
      {
        $set: {
          inventoryValueMinor: value + amountMinor,
          costComplete: complete && knownQuantity === delta,
        },
      },
      { session },
    );
  }
  return {
    quantity: Math.abs(delta),
    amountMinor,
    knownQuantity,
    complete: knownQuantity === Math.abs(delta),
  };
}
export async function recordConsumption(store, order, session, by) {
  const inventory = order.inventory;
  const costs = inventory?.costs || [];
  const missingRecipes = (inventory?.lines || []).filter(
    (row) => !row.costConfigured,
  ).length;
  const missingQuantity = (inventory?.totals || []).reduce(
    (sum, item) =>
      sum +
      Math.max(
        0,
        item.quantity -
          (costs.find((cost) => cost.ingredientId === item.ingredientId)
            ?.knownQuantity || 0),
      ),
    0,
  );
  const row = {
    _id: order._id,
    sourceKind: order.kind || "table",
    code: order.code,
    costs,
    totalMinor: costs.reduce((sum, item) => sum + item.amountMinor, 0),
    missingQuantity,
    missingRecipes,
    complete:
      Boolean(inventory?.lines?.length) && !missingRecipes && !missingQuantity,
    by,
    at: new Date(),
  };
  await store.inventoryConsumptions.updateOne(
    { _id: order._id },
    { $setOnInsert: row },
    { session, upsert: true },
  );
}
