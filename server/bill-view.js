import { heldMinor, paidMinor } from "./money.js";

export function billView(bill) {
  const paid = paidMinor(bill),
    reserved = heldMinor(bill);
  return {
    id: bill._id.toString(),
    receiptNo: bill.receiptNo,
    tableNumber: bill.tableNumber,
    status: bill.status,
    revision: bill.revision || 0,
    items: bill.items.map(({ ownerKey, ownerCustomerId, ...item }) => item),
    subtotal: bill.subtotalMinor / 100,
    charge: bill.chargeMinor / 100,
    tax: (bill.taxMinor || 0) / 100,
    taxLabel: bill.taxLabel || "VAT",
    taxRateBps: bill.taxRateBps || 0,
    taxIncluded: Boolean(bill.taxIncluded),
    invoice: bill.invoice || null,
    total: bill.totalMinor / 100,
    discount: (bill.discountMinor || 0) / 100,
    couponCode: bill.couponCode || "",
    loyaltyPoints: bill.loyaltyPoints || 0,
    netSubtotal: (bill.netSubtotalMinor ?? bill.subtotalMinor) / 100,
    serviceChargeBps: bill.serviceChargeBps,
    createdAt: bill.createdAt,
    paidAt: bill.paidAt,
    totalMinor: bill.totalMinor,
    paidMinor: paid,
    refundedMinor: bill.refundedMinor || 0,
    netCollectedMinor: paid - (bill.refundedMinor || 0),
    refunds: bill.refunds || [],
    balanceMinor: bill.totalMinor - paid,
    reservedMinor: reserved,
    availableMinor: Math.max(0, bill.totalMinor - paid - reserved),
    payment: bill.payment
      ? { method: bill.payment.method, reference: bill.payment.reference }
      : null,
    payments: (
      bill.payments ||
      (bill.status === "paid" && bill.payment
        ? [
            {
              id: "legacy",
              method: bill.payment.method,
              reference: bill.payment.reference,
              amountMinor: bill.totalMinor,
              at: bill.paidAt,
            },
          ]
        : [])
    ).map(({ id, method, reference, amountMinor, splitId, at }) => ({
      id,
      method,
      reference,
      amountMinor,
      splitId,
      at,
    })),
    splitMode: bill.splitMode || "none",
    splits: (bill.splits || []).map((part) => ({
      id: part.id,
      label: part.label,
      amountMinor: part.amountMinor,
      paidMinor: part.paidMinor || 0,
      reservedMinor: heldMinor(bill, part.id),
      availableMinor: Math.max(
        0,
        part.amountMinor - (part.paidMinor || 0) - heldMinor(bill, part.id),
      ),
      lines: part.lines || [],
    })),
  };
}
