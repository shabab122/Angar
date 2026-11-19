import { z } from "zod";
import { body, HttpError } from "./http.js";
import { getGuest, getTableCookie } from "./security.js";
import { requireCustomer, orderOwner } from "./customer.js";
import { allocateMinor, transaction } from "./money.js";

const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,30}$/);
const dateTime = z
  .string()
  .refine(
    (value) =>
      /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
      Number.isFinite(new Date(value).getTime()),
    "Use a date/time with a timezone.",
  );
const couponInput = z.strictObject({
  code: couponCode,
  kind: z.enum(["fixed", "percent"]),
  value: z.number().int().min(1).max(10000000),
  minSpendMinor: z.number().int().min(0).max(100000000).default(0),
  maxDiscountMinor: z.number().int().min(0).max(100000000).default(0),
  startsAt: dateTime,
  endsAt: dateTime,
  usageLimit: z.number().int().min(1).max(1000000),
  perCustomerLimit: z.number().int().min(1).max(100),
  enabled: z.boolean(),
  public: z.boolean().default(true),
});
const publicCoupon = (coupon) => ({
  code: coupon._id,
  kind: coupon.kind,
  value: coupon.value,
  minSpendMinor: coupon.minSpendMinor,
  maxDiscountMinor: coupon.maxDiscountMinor,
  startsAt: coupon.startsAt,
  endsAt: coupon.endsAt,
});

export async function promotionTotals(
  store,
  table,
  subtotalMinor,
  session,
  billId = null,
) {
  const promotion = table.promotion;
  if (!promotion)
    return {
      discountMinor: 0,
      couponDiscountMinor: 0,
      loyaltyDiscountMinor: 0,
      loyaltyPoints: 0,
      netSubtotalMinor: subtotalMinor,
    };
  const customer = await store.customers.findOne(
    { _id: promotion.customerId, active: true },
    { session },
  );
  if (!customer)
    throw new HttpError(
      409,
      "MEMBER_UNAVAILABLE",
      "The member discount needs to be removed before finalizing.",
    );
  let couponDiscountMinor = 0;
  if (promotion.couponCode) {
    const coupon = billId
      ? await store.coupons.findOneAndUpdate(
          { _id: promotion.couponCode },
          { $inc: { revision: 1 } },
          { session, returnDocument: "after" },
        )
      : await store.coupons.findOne({ _id: promotion.couponCode }, { session });
    const now = new Date();
    if (!coupon?.enabled || coupon.startsAt > now || coupon.endsAt <= now)
      throw new HttpError(
        409,
        "COUPON_EXPIRED",
        "This coupon is unavailable or expired. Remove it or choose another.",
      );
    if (subtotalMinor < coupon.minSpendMinor)
      throw new HttpError(
        409,
        "COUPON_MINIMUM",
        "The food subtotal is below this coupon's minimum spend.",
      );
    const used = await store.couponRedemptions.countDocuments(
      {
        couponCode: coupon._id,
        customerId: customer._id,
        reversed: { $ne: true },
      },
      { session },
    );
    if (
      (coupon.usedCount || 0) >= coupon.usageLimit ||
      used >= coupon.perCustomerLimit
    )
      throw new HttpError(
        409,
        "COUPON_LIMIT",
        "This coupon has reached its usage limit.",
      );
    couponDiscountMinor = Math.min(
      subtotalMinor,
      coupon.kind === "fixed"
        ? coupon.value
        : Math.round((subtotalMinor * coupon.value) / 10000),
      coupon.maxDiscountMinor || subtotalMinor,
    );
    if (billId) {
      await store.coupons.updateOne(
        { _id: coupon._id },
        { $inc: { usedCount: 1 } },
        { session },
      );
      await store.couponRedemptions.insertOne(
        {
          _id: billId,
          couponCode: coupon._id,
          customerId: customer._id,
          discountMinor: couponDiscountMinor,
          at: now,
        },
        { session },
      );
    }
  }
  const points = promotion.loyaltyPoints || 0;
  const maximum = Math.floor(
    ((subtotalMinor - couponDiscountMinor) * 20) / 100 / 100,
  );
  if (points > Math.min(Math.max(0, customer.points || 0), maximum))
    throw new HttpError(
      409,
      "POINTS_UNAVAILABLE",
      "Requested points exceed your balance or the 20% redemption limit.",
    );
  if (billId && points) {
    const debited = await store.customers.updateOne(
      { _id: customer._id, points: { $gte: points } },
      { $inc: { points: -points } },
      { session },
    );
    if (!debited.matchedCount)
      throw new HttpError(
        409,
        "POINTS_UNAVAILABLE",
        "Your points balance changed. Review the bill.",
      );
    await store.loyaltyLedger.insertOne(
      {
        key: "redeem:" + billId,
        customerId: customer._id,
        billId,
        delta: -points,
        reason: "Redeemed on table bill",
        at: new Date(),
      },
      { session },
    );
  }
  const discountMinor = couponDiscountMinor + points * 100;
  return {
    discountMinor,
    couponDiscountMinor,
    loyaltyDiscountMinor: points * 100,
    loyaltyPoints: points,
    netSubtotalMinor: subtotalMinor - discountMinor,
    couponCode: promotion.couponCode || "",
    promotionCustomerId: customer._id,
  };
}

export async function awardLoyalty(store, bill, session) {
  const groups = new Map();
  for (const item of bill.items) {
    const key = item.ownerCustomerId?.toString() || "guest";
    groups.set(key, (groups.get(key) || 0) + Math.round(item.subtotal * 100));
  }
  if (!groups.size) return;
  const keys = [...groups.keys()].sort();
  const net = allocateMinor(
    bill.accountingFoodMinor ?? bill.netSubtotalMinor ?? bill.subtotalMinor,
    keys.map((key) => groups.get(key)),
  );
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === "guest") continue;
    const points = Math.floor(net[i] / 10000);
    if (!points) continue;
    const customerId = bill.items.find(
      (item) => item.ownerCustomerId?.toString() === keys[i],
    ).ownerCustomerId;
    const updated = await store.customers.updateOne(
      { _id: customerId, active: true },
      { $inc: { points } },
      { session },
    );
    if (updated.matchedCount)
      await store.loyaltyLedger.insertOne(
        {
          key: "earn:" + bill._id + ":" + keys[i],
          customerId,
          billId: bill._id,
          delta: points,
          reason: "Earned on a settled table bill",
          at: new Date(),
        },
        { session },
      );
  }
}

export function registerGuestRewards(api, store, config) {
  api.get("/coupons", async (req, res) => {
    const now = new Date();
    const coupons = await store.coupons
      .find({
        enabled: true,
        public: true,
        startsAt: { $lte: now },
        endsAt: { $gt: now },
      })
      .sort({ endsAt: 1 })
      .limit(30)
      .toArray();
    res.json({
      coupons: coupons
        .filter((coupon) => (coupon.usedCount || 0) < coupon.usageLimit)
        .map(publicCoupon),
    });
  });
  api.post("/table/promotions", requireCustomer, async (req, res) => {
    const input = body(
      z.strictObject({
        couponCode: couponCode.or(z.literal("")).default(""),
        loyaltyPoints: z.number().int().min(0).max(1000000).default(0),
      }),
      req.body,
    );
    const context = getTableCookie(req);
    if (!context?.visitId)
      throw new HttpError(
        409,
        "TABLE_REQUIRED",
        "Scan your active table first.",
      );
    const result = await transaction(store, async (session) => {
      const table = await store.tables.findOneAndUpdate(
        {
          _id: context.tableId,
          activeVisitId: context.visitId,
          billingState: { $ne: "finalized" },
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!table)
        throw new HttpError(
          409,
          "BILL_FINALIZED",
          "Discounts must be selected before the table bill is finalized.",
        );
      const own = await store.orders.findOne(
        {
          visitId: context.visitId,
          customerId: req.customer._id,
          status: { $ne: "cancelled" },
        },
        { session },
      );
      if (!own)
        throw new HttpError(
          403,
          "FORBIDDEN",
          "Place an order with this account before applying member benefits.",
        );
      if (
        table.promotion &&
        !table.promotion.customerId.equals(req.customer._id)
      )
        throw new HttpError(
          409,
          "PROMOTION_OWNED",
          "Another member selected this table's benefits. Ask the cashier to clear them first.",
        );
      const orders = await store.orders
        .find(
          { visitId: context.visitId, status: { $ne: "cancelled" } },
          { session },
        )
        .toArray();
      const subtotal = orders.reduce(
        (sum, order) => sum + Math.round(order.total * 100),
        0,
      );
      const promotion =
        input.couponCode || input.loyaltyPoints
          ? { ...input, customerId: req.customer._id }
          : null;
      const totals = await promotionTotals(
        store,
        { ...table, promotion },
        subtotal,
        session,
      );
      await store.tables.updateOne(
        { _id: table._id },
        { $set: { promotion } },
        { session },
      );
      return totals;
    });
    res.json({ totals: result });
  });
}

export function registerStaffRewards(api, store, requireAdmin, billingRoles) {
  api.get("/coupons", requireAdmin, async (req, res) => {
    const rows = await store.coupons
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json({
      coupons: rows.map((row) => ({
        ...publicCoupon(row),
        enabled: row.enabled,
        public: row.public,
        usedCount: row.usedCount || 0,
        usageLimit: row.usageLimit,
        perCustomerLimit: row.perCustomerLimit,
      })),
    });
  });
  api.post("/coupons", requireAdmin, async (req, res) => {
    const input = body(couponInput, req.body);
    if (input.kind === "percent" && input.value > 10000)
      throw new HttpError(
        400,
        "INVALID_COUPON",
        "A percentage discount cannot exceed 100%.",
      );
    if (new Date(input.startsAt) >= new Date(input.endsAt))
      throw new HttpError(
        400,
        "INVALID_COUPON",
        "Coupon expiry must be after its start time.",
      );
    const { code, ...fields } = input;
    await transaction(store, async (session) => {
      const existing = await store.coupons.findOne({ _id: code }, { session });
      if (existing && (existing.usedCount || 0) > input.usageLimit)
        throw new HttpError(
          409,
          "COUPON_LIMIT",
          "The new limit cannot be below existing redemptions.",
        );
      await store.coupons.updateOne(
        { _id: code },
        {
          $set: {
            ...fields,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date(), usedCount: 0 },
          $inc: { revision: 1 },
        },
        { session, upsert: true },
      );
      await store.audit.insertOne(
        {
          type: "coupon.updated",
          code,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ code });
  });
  api.post(
    "/tables/:number/clear-promotions",
    billingRoles,
    async (req, res) => {
      const { reason } = body(
        z.strictObject({ reason: z.string().trim().min(3).max(160) }),
        req.body,
      );
      await transaction(store, async (session) => {
        const table = await store.tables.findOneAndUpdate(
          {
            number: req.params.number,
            activeVisitId: { $type: "objectId" },
            billingState: { $ne: "finalized" },
          },
          { $set: { promotion: null }, $inc: { revision: 1 } },
          { session },
        );
        if (!table)
          throw new HttpError(
            409,
            "BILL_FINALIZED",
            "This table is closed or already finalized.",
          );
        await store.audit.insertOne(
          {
            type: "table.promotions_cleared",
            tableNumber: table.number,
            by: req.staff.username,
            reason,
            at: new Date(),
          },
          { session },
        );
      });
      res.status(204).end();
    },
  );
}
