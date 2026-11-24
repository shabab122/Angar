import { ownsCustomer } from "./shared-customers.js";
import { guardCourierTransition } from "./courier.js";
import { queueKitchenTicket } from "./printing.js";
import { recordConsumption } from "./inventory-cost.js";
import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { body, HttpError, orderInput } from "./http.js";
import { getGuest, hash } from "./security.js";
import { orderOwner, contactPhone } from "./customer.js";
import { lockAvailableDishes } from "./orders.js";
import { restaurantSettings } from "./restaurant.js";
import {
  financialTotals,
  invoiceSnapshot,
  nextReceiptNumber,
} from "./invoices.js";
import { reserveOrderInventory, changeOrderInventory } from "./inventory.js";
import { assertReservedBatches } from "./ingredient-batches.js";
import { promotionTotals } from "./rewards.js";
import { billView } from "./bill-view.js";
import { transaction, heldMinor, paidMinor } from "./money.js";
import { finishBill } from "./payments.js";

export const fulfillmentDefaults = {
  pickupEnabled: false,
  deliveryEnabled: false,
  open: "12:00",
  close: "22:30",
  prepMinutes: 30,
  daysAhead: 7,
  applyServiceCharge: false,
  taxableDeliveryFee: false,
  zones: [],
};
const text = (max) => z.string().trim().max(max);
const quoteInput = z.strictObject({
  kind: z.enum(["pickup", "delivery"]),
  zoneId: text(30).default(""),
  scheduledAt: text(40).default("asap"),
  items: orderInput.shape.items,
  couponCode: text(30).toUpperCase().default(""),
  loyaltyPoints: z.number().int().min(0).max(1000000).default(0),
});
const createInput = quoteInput.extend({
  name: text(80).min(2),
  phone: contactPhone,
  address: z
    .strictObject({
      line: text(180).min(5),
      area: text(80).min(2),
      note: text(160).default(""),
    })
    .optional(),
  note: text(200).default(""),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: z.string().regex(/^[a-f0-9]{32}$/),
});
const reason = z.string().trim().min(3).max(160),
  time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settingsInput = z.strictObject({
  expectedRevision: z.number().int().min(0),
  reason,
  pickupEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  open: time,
  close: time,
  prepMinutes: z.number().int().min(10).max(180),
  daysAhead: z.number().int().min(1).max(30),
  applyServiceCharge: z.boolean(),
  taxableDeliveryFee: z.boolean(),
  zones: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9_-]{2,30}$/),
        name: text(60).min(2),
        feeMinor: z.number().int().min(0).max(100000),
        minimumFoodMinor: z.number().int().min(0).max(10000000),
        estimatedMinutes: z.number().int().min(10).max(180),
      }),
    )
    .max(20)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length),
});

export function fulfillmentTotals(
  netFoodMinor,
  settings,
  options,
  deliveryFeeMinor = 0,
) {
  const billing = {
      ...settings,
      serviceChargeBps: options.applyServiceCharge
        ? settings.serviceChargeBps
        : 0,
    },
    totals = financialTotals(netFoodMinor, billing);
  const deliveryTax =
    options.taxableDeliveryFee && settings.tax?.enabled
      ? Math.round(
          (deliveryFeeMinor * settings.tax.rateBps) /
            (settings.tax.mode === "inclusive"
              ? 10000 + settings.tax.rateBps
              : 10000),
        )
      : 0;
  return {
    ...totals,
    serviceChargeBps: billing.serviceChargeBps,
    deliveryFeeMinor,
    deliveryFee: deliveryFeeMinor / 100,
    accountingDeliveryFeeMinor:
      deliveryFeeMinor - (totals.taxIncluded ? deliveryTax : 0),
    taxMinor: totals.taxMinor + deliveryTax,
    totalMinor:
      totals.totalMinor +
      deliveryFeeMinor +
      (totals.taxIncluded ? 0 : deliveryTax),
  };
}
function scheduledTime(input, options) {
  const now = Date.now(),
    today = new Date(now + 6 * 3600000).toISOString().slice(0, 10),
    opening = new Date(today + "T" + options.open + ":00+06:00").getTime();
  let value =
    input === "asap"
      ? new Date(Math.max(now, opening) + options.prepMinutes * 60000)
      : /(?:Z|[+-]\d\d:\d\d)$/.test(input)
        ? new Date(input)
        : new Date(NaN);
  if (
    input === "asap" &&
    value.getTime() >
      new Date(today + "T" + options.close + ":00+06:00").getTime()
  )
    value = new Date(opening + 86400000 + options.prepMinutes * 60000);
  if (
    !Number.isFinite(value.getTime()) ||
    value.getTime() < now + options.prepMinutes * 60000 - 1000 ||
    value.getTime() > now + options.daysAhead * 86400000
  )
    throw new HttpError(
      400,
      "FULFILLMENT_TIME",
      "Choose an available future time within the ordering window.",
    );
  const local = new Date(value.getTime() + 6 * 3600000).toISOString(),
    clock = local.slice(11, 16);
  if (clock < options.open || clock > options.close)
    throw new HttpError(
      409,
      "FULFILLMENT_CLOSED",
      "Choose a pickup/delivery time within the restaurant's ordering hours.",
    );
  return value;
}
async function price(store, input, req, session, lock) {
  const settings = await restaurantSettings(store, session),
    options = { ...fulfillmentDefaults, ...settings.fulfillment };
  if (!settings.orderingEnabled || !options[input.kind + "Enabled"])
    throw new HttpError(
      409,
      "FULFILLMENT_DISABLED",
      "This ordering method is not currently available.",
    );
  const zone =
    input.kind === "delivery"
      ? options.zones.find((zone) => zone.id === input.zoneId)
      : null;
  if (input.kind === "delivery" && !zone)
    throw new HttpError(
      400,
      "DELIVERY_ZONE",
      "Choose a supported delivery area.",
    );
  const menu = lock
    ? await lockAvailableDishes(
        store,
        input.items.map((item) => item.dishId),
        session,
      )
    : await store.dishes
        .find(
          { _id: { $in: input.items.map((item) => item.dishId) } },
          { session },
        )
        .toArray();
  const items = input.items.map((item) => {
    const dish = menu.find((dish) => dish._id === item.dishId),
      variant = item.variantId
        ? dish?.variants?.find((option) => option.id === item.variantId)
        : null;
    const addons = (item.addonIds || []).map((id) =>
      dish?.addons?.find((option) => option.id === id),
    );
    if (
      !dish?.available ||
      (item.variantId && !variant) ||
      addons.some((option) => !option)
    )
      throw new HttpError(
        409,
        "ITEM_UNAVAILABLE",
        "A selected item or option is unavailable. Review your cart.",
      );
    const unitPrice =
      dish.price +
      (variant?.price || 0) +
      addons.reduce((sum, addon) => sum + addon.price, 0);
    if (unitPrice !== item.expectedPrice)
      throw new HttpError(
        409,
        "PRICE_CHANGED",
        "A menu price changed. Review your cart again.",
      );
    return {
      dishId: dish._id,
      name: dish.name,
      nameBn: dish.nameBn,
      unitPrice,
      quantity: item.quantity,
      subtotal: unitPrice * item.quantity,
      variant: variant || null,
      addons,
    };
  });
  const subtotalMinor = items.reduce(
    (sum, item) => sum + Math.round(item.subtotal * 100),
    0,
  );
  if (zone && subtotalMinor < zone.minimumFoodMinor)
    throw new HttpError(
      409,
      "DELIVERY_MINIMUM",
      "This area requires a food subtotal of BDT " +
        (zone.minimumFoodMinor / 100).toFixed(2) +
        ".",
    );
  if ((input.couponCode || input.loyaltyPoints) && !req.customer)
    throw new HttpError(
      401,
      "CUSTOMER_REQUIRED",
      "Sign in to use coupons or loyalty points.",
    );
  const promotion =
    input.couponCode || input.loyaltyPoints
      ? {
          customerId: req.customer._id,
          couponCode: input.couponCode,
          loyaltyPoints: input.loyaltyPoints,
        }
      : null;
  const discounts = await promotionTotals(
      store,
      { promotion },
      subtotalMinor,
      session,
    ),
    totals = fulfillmentTotals(
      discounts.netSubtotalMinor,
      settings,
      options,
      zone?.feeMinor || 0,
    ),
    scheduledAt = scheduledTime(input.scheduledAt, options);
  const billingSettings = {
    name: settings.name,
    branch: settings.branch,
    location: settings.location,
    serviceChargeBps: settings.serviceChargeBps,
    tax: settings.tax,
    invoice: settings.invoice,
  };
  const quoteHash = hash(
    JSON.stringify({
      kind: input.kind,
      zoneId: input.zoneId,
      scheduledAt: input.scheduledAt,
      items,
      discounts,
      totals,
      billingSettings,
      options,
      zone,
    }),
  );
  return {
    items,
    subtotalMinor,
    discounts,
    totals,
    promotion,
    scheduledAt,
    zone: zone ? { ...zone } : null,
    options,
    billingSettings,
    quoteHash,
  };
}
const publicQuote = (quote) => ({
  quoteHash: quote.quoteHash,
  items: quote.items,
  subtotalMinor: quote.subtotalMinor,
  discountMinor: quote.discounts.discountMinor,
  ...quote.totals,
  scheduledAt: quote.scheduledAt,
  zone: quote.zone,
});
function view(row, bill, role) {
  return {
    id: row._id.toString(),
    code: row.code,
    kind: row.kind,
    status: row.status,
    name: row.name,
    ...(role === "kitchen"
      ? {}
      : { phone: row.phone, address: row.address || null }),
    items: row.items,
    note: row.note,
    total: row.quote.totals.totalMinor / 100,
    quote: {
      subtotalMinor: row.quote.subtotalMinor,
      discountMinor: row.quote.discounts.discountMinor,
      ...row.quote.totals,
    },
    scheduledAt: row.scheduledAt,
    zoneName: row.zone?.name || "",
    courier: row.courier || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision || 0,
    paymentStatus: row.paymentStatus,
    history: row.history.map(({ status, at, reason, by }) => ({
      status,
      at,
      reason,
      ...(role ? { by } : {}),
    })),
    bill:
      bill && (!role || ["admin", "cashier"].includes(role))
        ? billView(bill)
        : null,
  };
}
async function voidBenefits(store, bill, session) {
  if (bill.loyaltyPoints && bill.promotionCustomerId) {
    await store.customers.updateOne(
      { _id: bill.promotionCustomerId },
      { $inc: { points: bill.loyaltyPoints } },
      { session },
    );
    await store.loyaltyLedger.insertOne(
      {
        key: "void:" + bill._id,
        billId: bill._id,
        customerId: bill.promotionCustomerId,
        delta: bill.loyaltyPoints,
        reason: "Redeemed points returned after unpaid takeaway cancellation",
        at: new Date(),
      },
      { session },
    );
  }
  if (bill.couponCode) {
    const redeemed = await store.couponRedemptions.findOneAndUpdate(
      { _id: bill._id, reversed: { $ne: true } },
      { $set: { reversed: true, reversedAt: new Date() } },
      { session },
    );
    if (redeemed)
      await store.coupons.updateOne(
        { _id: bill.couponCode, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1, revision: 1 } },
        { session },
      );
  }
}
async function acceptBill(store, row, user, session) {
  const billId = new ObjectId(),
    discount = await promotionTotals(
      store,
      { promotion: row.promotion },
      row.quote.subtotalMinor,
      session,
      billId,
    );
  if (discount.discountMinor !== row.quote.discounts.discountMinor)
    throw new HttpError(
      409,
      "BENEFITS_CHANGED",
      "The quoted benefits changed. Ask the guest to place a revised order.",
    );
  const totals = fulfillmentTotals(
    discount.netSubtotalMinor,
    row.quote.billingSettings,
    row.quote.options,
    row.zone?.feeMinor || 0,
  );
  const bill = {
    _id: billId,
    receiptNo: await nextReceiptNumber(
      store,
      row.quote.billingSettings,
      session,
    ),
    invoice: invoiceSnapshot(row.quote.billingSettings),
    kind: row.kind,
    fulfillmentId: row._id,
    fulfillmentCode: row.code,
    visitId: new ObjectId(),
    tableId: null,
    tableNumber: row.code,
    orderIds: [],
    items: row.items.map((item, index) => ({
      ...item,
      lineId: row._id + ":" + index,
      ownerKey: row.customerId
        ? "member:" + row.customerId
        : "guest:" + row.guestHash,
      ...(row.customerId ? { ownerCustomerId: row.customerId } : {}),
    })),
    subtotalMinor: row.quote.subtotalMinor,
    ...discount,
    ...totals,
    status: "finalized",
    paidMinor: 0,
    payments: [],
    holds: [],
    splits: [],
    revision: 0,
    createdAt: new Date(),
    createdBy: user.username,
  };
  await store.bills.insertOne(bill, { session });
  return bill;
}

export function registerGuestFulfillment(api, store, config, requireId) {
  api.get("/fulfillment/options", async (req, res) => {
    const settings = await restaurantSettings(store);
    res.json({
      ...fulfillmentDefaults,
      ...settings.fulfillment,
      orderingEnabled: settings.orderingEnabled,
      timezone: "Asia/Dhaka",
    });
  });
  api.post("/fulfillment/quote", async (req, res) => {
    getGuest(req, res, config);
    res.json({
      quote: publicQuote(await price(store, body(quoteInput, req.body), req)),
    });
  });
  api.post("/fulfillment/orders", async (req, res) => {
    const input = body(createInput, req.body),
      guestHash = getGuest(req, res, config),
      fingerprint = hash(JSON.stringify(input));
    const replay = (previous) => {
      if (
        previous.customerId &&
        !ownsCustomer(req.customer, previous.customerId)
      )
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This order belongs to another account.",
        );
      if (previous.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "REQUEST_REUSED",
          "This key belongs to another order.",
        );
      return previous;
    };
    let result;
    try {
      result = await transaction(store, async (session) => {
        const previous = await store.fulfillments.findOne(
          { guestHash, requestKey: input.requestKey },
          { session },
        );
        if (previous) return replay(previous);
        if (input.kind === "delivery" && !input.address)
          throw new HttpError(
            400,
            "DELIVERY_ADDRESS",
            "Enter the delivery address and area.",
          );
        const quote = await price(store, input, req, session, true);
        if (quote.quoteHash !== input.quoteHash)
          throw new HttpError(
            409,
            "QUOTE_CHANGED",
            "The price or delivery settings changed. Request a new quote before confirming.",
          );
        const now = new Date(),
          row = {
            _id: new ObjectId(),
            code:
              (input.kind === "pickup" ? "PU-" : "DL-") +
              randomBytes(5).toString("hex").toUpperCase(),
            guestHash,
            ...(req.customer ? { customerId: req.customer._id } : {}),
            requestKey: input.requestKey,
            fingerprint,
            kind: input.kind,
            name: input.name,
            phone: input.phone,
            address: input.kind === "delivery" ? input.address : null,
            note: input.note,
            items: quote.items,
            quote,
            promotion: quote.promotion,
            scheduledAt: quote.scheduledAt,
            zone: quote.zone,
            status: "placed",
            paymentStatus: "not_finalized",
            revision: 0,
            createdAt: now,
            updatedAt: now,
            history: [{ status: "placed", at: now }],
          };
        await store.fulfillments.insertOne(row, { session });
        return row;
      });
    } catch (failure) {
      if (failure.code !== 11000) throw failure;
      const previous = await store.fulfillments.findOne({
        guestHash,
        requestKey: input.requestKey,
      });
      if (!previous) throw failure;
      result = replay(previous);
    }
    res.status(201).json({ order: view(result) });
  });
  api.get("/fulfillment/orders", async (req, res) => {
    const rows = await store.fulfillments
      .find(orderOwner(req, getGuest(req, res, config)))
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    const bills = await store.bills
      .find({ fulfillmentId: { $in: rows.map((row) => row._id) } })
      .toArray();
    res.json({
      orders: rows.map((row) =>
        view(
          row,
          bills.find((bill) => bill.fulfillmentId.equals(row._id)),
        ),
      ),
    });
  });
  api.post("/fulfillment/orders/:id/cancel", async (req, res) => {
    const input = body(z.strictObject({ reason }), req.body);
    const row = await store.fulfillments.findOneAndUpdate(
      {
        _id: requireId(req.params.id),
        ...orderOwner(req, getGuest(req, res, config)),
        status: "placed",
      },
      {
        $set: { status: "cancelled", updatedAt: new Date() },
        $inc: { revision: 1 },
        $push: {
          history: {
            status: "cancelled",
            reason: input.reason,
            at: new Date(),
          },
        },
      },
      { returnDocument: "after" },
    );
    if (!row)
      throw new HttpError(
        409,
        "FULFILLMENT_STATE",
        "Only an order awaiting staff acceptance can be cancelled here. Contact the restaurant for an accepted order.",
      );
    res.json({ order: view(row) });
  });
}

export function registerStaffFulfillment(
  api,
  store,
  requireAdmin,
  requireId,
  allRoles,
) {
  api.get("/fulfillment/settings", requireAdmin, async (req, res) => {
    const settings = await restaurantSettings(store);
    res.json({
      settings: { ...fulfillmentDefaults, ...settings.fulfillment },
      revision: settings.fulfillmentRevision || 0,
    });
  });
  api.post("/fulfillment/settings", requireAdmin, async (req, res) => {
    const input = body(settingsInput, req.body);
    if (
      input.open >= input.close ||
      (input.deliveryEnabled && !input.zones.length)
    )
      throw new HttpError(
        400,
        "FULFILLMENT_SETTINGS",
        "Use closing hours after opening and at least one zone for delivery.",
      );
    await transaction(store, async (session) => {
      const row = await store.settings.findOneAndUpdate(
        { _id: "restaurant" },
        { $inc: { configurationRevision: 1 } },
        { upsert: true, session, returnDocument: "after" },
      );
      if ((row.fulfillmentRevision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "SETTINGS_UPDATED",
          "These ordering settings changed. Refresh first.",
        );
      const { expectedRevision, reason, ...settings } = input;
      await store.settings.updateOne(
        { _id: row._id },
        { $set: { fulfillment: settings }, $inc: { fulfillmentRevision: 1 } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "fulfillment.settings_updated",
          by: req.staff.username,
          reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.get("/fulfillment/orders", allRoles, async (req, res) => {
    const filter =
      req.staff.role === "kitchen"
        ? { status: { $in: ["accepted", "preparing", "ready"] } }
        : {};
    const rows = await store.fulfillments
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
      bills = await store.bills
        .find({ fulfillmentId: { $in: rows.map((row) => row._id) } })
        .toArray();
    res.json({
      orders: rows.map((row) =>
        view(
          row,
          bills.find((bill) => bill.fulfillmentId.equals(row._id)),
          req.staff.role,
        ),
      ),
    });
  });
  api.post("/fulfillment/orders/:id/action", allRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        action: z.enum([
          "accept",
          "prepare",
          "ready",
          "collect",
          "dispatch",
          "deliver",
          "cancel",
        ]),
        expectedRevision: z.number().int().min(0),
        reason: text(160).default(""),
        courierName: text(80).default(""),
        courierPhone: contactPhone.or(z.literal("")).default(""),
      }),
      req.body,
    );
    const result = await transaction(store, async (session) => {
      const row = await store.fulfillments.findOneAndUpdate(
        { _id: requireId(req.params.id) },
        { $inc: { revision: 1 } },
        { session, returnDocument: "before" },
      );
      if (!row || (row.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "FULFILLMENT_UPDATED",
          "This order changed. Refresh before the next action.",
        );
      const transitions = {
        accept: ["placed", "accepted", ["admin"]],
        prepare: ["accepted", "preparing", ["admin", "kitchen"]],
        ready: ["preparing", "ready", ["admin", "kitchen"]],
        collect: ["ready", "collected", ["admin", "waiter"]],
        dispatch: ["ready", "dispatched", ["admin", "waiter"]],
        deliver: ["dispatched", "delivered", ["admin", "waiter"]],
      };
      let bill = row.billId
        ? await store.bills.findOneAndUpdate(
            { _id: row.billId },
            { $inc: { revision: 1 } },
            { session, returnDocument: "after" },
          )
        : null;
      const now = new Date(),
        changes = { updatedAt: now };
      if (input.action === "cancel") {
        if (
          req.staff.role !== "admin" ||
          ["cancelled", "collected", "delivered"].includes(row.status)
        )
          throw new HttpError(
            403,
            "FORBIDDEN",
            "Only an administrator can cancel an uncompleted takeaway or delivery.",
          );
        if (input.reason.length < 3)
          throw new HttpError(
            400,
            "REASON_REQUIRED",
            "Give a reason for the customer.",
          );
        if (
          bill &&
          (heldMinor(bill) ||
            (paidMinor(bill) > 0 && paidMinor(bill) !== bill.totalMinor))
        )
          throw new HttpError(
            409,
            "PAYMENT_PENDING",
            "Resolve pending/partial payments before cancelling. Confirmed paid bills use the refund workflow.",
          );
        if (row.inventory?.state === "reserved")
          changes.inventory = await changeOrderInventory(
            store,
            row,
            [],
            session,
            req.staff.username,
          );
        if (bill?.status === "finalized" && paidMinor(bill) === 0) {
          await voidBenefits(store, bill, session);
          await store.bills.updateOne(
            { _id: bill._id },
            { $set: { status: "void", voidedAt: now } },
            { session },
          );
          bill = { ...bill, status: "void" };
        }
        changes.status = "cancelled";
      } else {
        const [from, next, roles] = transitions[input.action];
        if (!roles.includes(req.staff.role))
          throw new HttpError(
            403,
            "FORBIDDEN",
            "This action belongs to another staff station.",
          );
        if (
          row.status !== from ||
          (input.action === "collect" && row.kind !== "pickup") ||
          (["dispatch", "deliver"].includes(input.action) &&
            row.kind !== "delivery")
        )
          throw new HttpError(
            409,
            "FULFILLMENT_STATE",
            "This action is not available at the current order stage.",
          );
        if (
          ["collect", "deliver"].includes(input.action) &&
          bill?.status !== "paid"
        )
          throw new HttpError(
            409,
            "PAYMENT_REQUIRED",
            "Verify and record the full payment before completing this handover.",
          );
        if (input.action === "dispatch") {
          if (input.courierName.length < 2)
            throw new HttpError(
              400,
              "COURIER_REQUIRED",
              "Record the courier or delivery staff member's name.",
            );
          changes.courier = {
            name: input.courierName,
            phone: input.courierPhone,
          };
        }
        if (input.action === "accept") {
          await lockAvailableDishes(
            store,
            row.items.map((item) => item.dishId),
            session,
          );
          changes.inventory = await reserveOrderInventory(
            store,
            row,
            session,
            req.staff.username,
          );
          bill = await acceptBill(store, row, req.staff, session);
          changes.billId = bill._id;
          changes.paymentStatus = "unpaid";
        }
        if (input.action === "prepare" && row.inventory) {
          await assertReservedBatches(store, row, session);
          await recordConsumption(store, row, session, req.staff.username);
          changes.inventory = {
            ...row.inventory,
            state: "consumed",
            consumedAt: now,
          };
        }
        changes.status = next;
      }
      await guardCourierTransition(store, row, input.action, session);
      const history = {
        status: changes.status,
        at: now,
        by: req.staff.username,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      await store.fulfillments.updateOne(
        { _id: row._id },
        { $set: changes, $push: { history } },
        { session },
      );
      if (
        input.action === "accept" ||
        (input.action === "cancel" && row.status !== "placed")
      )
        await queueKitchenTicket(
          store,
          { ...row, ...changes, revision: (row.revision || 0) + 1 },
          input.action === "accept" ? "new" : "cancelled",
          session,
          req.staff.username,
        );
      if (input.action === "accept" && bill.totalMinor === 0) {
        bill = await finishBill(store, bill, session, now);
        changes.paymentStatus = "paid";
      }
      await store.audit.insertOne(
        {
          type: "fulfillment." + input.action,
          fulfillmentId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: now,
        },
        { session },
      );
      return {
        row: {
          ...row,
          ...changes,
          revision:
            (row.revision || 0) +
            (input.action === "accept" && bill?.totalMinor === 0 ? 2 : 1),
          history: [...row.history, history],
        },
        bill,
      };
    });
    res.json({ order: view(result.row, result.bill, req.staff.role) });
  });
}
