const code = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
export function safeDraftLines(value) {
  if (!Array.isArray(value)) return [];
  const result = [],
    seen = new Set();
  for (const row of value.slice(0, 12)) {
    if (
      !row ||
      !code(row.dishId) ||
      !Number.isInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity > 10 ||
      (row.variantId && !code(row.variantId)) ||
      (row.addonIds !== undefined &&
        (!Array.isArray(row.addonIds) ||
          row.addonIds.length > 12 ||
          !row.addonIds.every(code)))
    )
      continue;
    const addonIds = [...new Set(row.addonIds || [])].sort(),
      variantId = row.variantId || "",
      key = [row.dishId, variantId, addonIds.join(",")].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      key,
      dishId: row.dishId,
      quantity: row.quantity,
      ...(variantId ? { variantId } : {}),
      addonIds,
    });
  }
  return result;
}
