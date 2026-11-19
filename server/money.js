import { HttpError } from "./http.js";

export const transaction = (store, task) =>
  store.client.withSession((session) =>
    session.withTransaction(() => task(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }),
  );

export function parseMinor(value) {
  const text = String(value ?? "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new HttpError(
      400,
      "INVALID_AMOUNT",
      "Use an amount with at most two decimal places.",
    );
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result))
    throw new HttpError(400, "INVALID_AMOUNT", "Amount is too large.");
  return result;
}

// Largest-remainder allocation preserves every paisa, including odd splits.
export function allocateMinor(total, weights) {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !weights.length ||
    weights.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw new HttpError(400, "INVALID_SPLIT", "Invalid split amounts.");
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum)
    return allocateMinor(
      total,
      weights.map(() => 1),
    );
  const parts = weights.map((weight) =>
    Number((BigInt(total) * BigInt(weight)) / BigInt(sum)),
  );
  const ranked = weights
    .map((weight, index) => ({
      index,
      remainder: (BigInt(total) * BigInt(weight)) % BigInt(sum),
    }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (
    let i = 0, left = total - parts.reduce((a, b) => a + b, 0);
    i < left;
    i++
  )
    parts[ranked[i].index]++;
  return parts;
}

export function paidMinor(bill) {
  return bill.paidMinor ?? (bill.status === "paid" ? bill.totalMinor : 0);
}
export function heldMinor(bill, splitId) {
  return (bill.holds || [])
    .filter((hold) => !splitId || hold.splitId === splitId)
    .reduce((sum, hold) => sum + hold.amountMinor, 0);
}
export function remainingMinor(bill, splitId) {
  if (splitId) {
    const split = bill.splits?.find((part) => part.id === splitId);
    if (!split)
      throw new HttpError(
        409,
        "SPLIT_CHANGED",
        "That split no longer exists. Refresh the bill.",
      );
    return split.amountMinor - (split.paidMinor || 0);
  }
  return bill.totalMinor - paidMinor(bill);
}
