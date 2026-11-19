import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { HttpError } from "./http.js";
import { hash, tableVisitKey } from "./security.js";
import { restaurantSettings } from "./restaurant.js";

export const ACTIVE = ["placed", "queued", "preparing", "ready"];
export const ACTIONS = {
  send: { role: "admin", from: "placed", to: "queued" },
  reject: { role: "admin", from: "placed", to: "cancelled" },
  start: { role: "kitchen", from: "queued", to: "preparing" },
  ready: { role: "kitchen", from: "preparing", to: "ready" },
  serve: { role: "waiter", from: "ready", to: "served" },
};

export function orderView(order, staff = false) {
  const {
    _id,
    code,
    tableNumber,
    status,
    items,
    note,
    total,
    createdAt,
    updatedAt,
    history,
  } = order;
  return {
    id: _id.toString(),
    code,
    tableNumber,
    status,
    items,
    note,
    total,
    createdAt,
    updatedAt,
    source: order.source || "guest",
    revision: order.revision || 0,
    changeRequest: order.changeRequest
      ? changeRequestView(order.changeRequest, staff)
      : null,
    history: history.map(({ status, at, reason, by }) => ({
      status,
      at,
      reason,
      ...(staff ? { by } : {}),
    })),
  };
}

function changeRequestView(change, staff) {
  const { fingerprint, increasedDishIds, decidedBy, ...visible } = change;
  return { ...visible, ...(staff && decidedBy ? { decidedBy } : {}) };
}

// A write to every selected dish makes a concurrent sold-out/price update
// conflict with checkout. Snapshot reads alone could accept stale availability.
export async function lockAvailableDishes(store, ids, session) {
  const menu = [];
  for (const id of [...new Set(ids)].sort()) {
    const dish = await store.dishes.findOneAndUpdate(
      { _id: id, available: true },
      { $inc: { orderRevision: 1 } },
      { session, returnDocument: "after" },
    );
    if (!dish)
      throw new HttpError(
        409,
        "ITEM_UNAVAILABLE",
        "An item sold out. Review your updated cart.",
      );
    menu.push(dish);
  }
  return menu;
}

export async function placeOrder(
  store,
  guestHash,
  context,
  requestKey,
  input,
  actor = {},
) {
  const { client, orders, tables } = store;
  const itemKey = (item) =>
    [
      item.dishId,
      item.variantId || "",
      [...(item.addonIds || [])].sort().join(","),
    ].join("|");
  const items = input.items
    .map((item) => ({
      dishId: item.dishId,
      quantity: item.quantity,
      expectedPrice: item.expectedPrice,
      ...(item.variantId ? { variantId: item.variantId } : {}),
      ...(item.addonIds?.length ? { addonIds: [...item.addonIds].sort() } : {}),
    }))
    .sort((a, b) => itemKey(a).localeCompare(itemKey(b)));
  const fingerprint = hash(
    JSON.stringify({ visitKey: input.visitKey, items, note: input.note }),
  );
  const requestFilter = { guestHash, requestKey };

  function replay(order) {
    if (order.customerId && !order.customerId.equals(actor.customerId))
      throw new HttpError(
        404,
        "NOT_FOUND",
        "This checkout belongs to a different customer account.",
      );
    if (
      order.fingerprint !== fingerprint ||
      (context &&
        (!order.tableId.equals(context.tableId) ||
          !order.visitId.equals(context.visitId)))
    ) {
      throw new HttpError(
        409,
        "REQUEST_REUSED",
        "This checkout attempt belongs to a different cart. Check My orders.",
      );
    }
    return { order: orderView(order), replay: true };
  }

  const prior = await orders.findOne(requestFilter);
  if (prior) return replay(prior);
  if (!context?.visitId)
    throw new HttpError(
      409,
      "TABLE_REQUIRED",
      "Scan the QR on your active table to order.",
    );
  if (tableVisitKey(context.visitId) !== input.visitKey) {
    throw new HttpError(
      409,
      "TABLE_CHANGED",
      "The active table changed. Confirm your table before ordering.",
    );
  }

  try {
    return await client.withSession((session) =>
      session.withTransaction(
        async () => {
          const existing = await orders.findOne(requestFilter, { session });
          if (existing) return replay(existing);

          // Ordering and closing both write the table document. A concurrent close
          // therefore either sees this order or causes the order to retry against a closed visit.
          const table = await tables.findOneAndUpdate(
            { _id: context.tableId, activeVisitId: context.visitId },
            { $inc: { revision: 1 } },
            { session },
          );
          if (!table)
            throw new HttpError(
              409,
              "TABLE_CLOSED",
              "This table visit ended. Ask staff to open it and scan again.",
            );

          if (table.billingState === "finalized")
            throw new HttpError(
              409,
              "BILL_FINALIZED",
              "Your table bill has been finalized. Ask staff before ordering again.",
            );
          const settings = await restaurantSettings(store, session);
          if (!settings.orderingEnabled)
            throw new HttpError(
              409,
              "ORDERING_PAUSED",
              "The kitchen is taking a short pause. Ask your server for help.",
            );
          const menu = await lockAvailableDishes(
            store,
            items.map((item) => item.dishId),
            session,
          );
          const byId = new Map(menu.map((dish) => [dish._id, dish]));
          const orderItems = items.map(
            ({ dishId, quantity, expectedPrice, variantId, addonIds = [] }) => {
              const dish = byId.get(dishId);
              if (!dish?.available)
                throw new HttpError(
                  409,
                  "ITEM_UNAVAILABLE",
                  "An item sold out. Review your updated cart.",
                );
              const variant = variantId
                ? dish.variants?.find((option) => option.id === variantId)
                : null;
              if (variantId && !variant)
                throw new HttpError(
                  409,
                  "OPTIONS_CHANGED",
                  "A size option changed. Review the dish again.",
                );
              const selectedAddons = addonIds.map((id) =>
                dish.addons?.find((option) => option.id === id),
              );
              if (selectedAddons.some((option) => !option))
                throw new HttpError(
                  409,
                  "OPTIONS_CHANGED",
                  "An add-on changed. Review the dish again.",
                );
              const unitPrice =
                dish.price +
                (variant?.price || 0) +
                selectedAddons.reduce(
                  (total, option) => total + option.price,
                  0,
                );
              if (unitPrice !== expectedPrice) {
                throw new HttpError(
                  409,
                  "PRICE_CHANGED",
                  "A price changed. Review the updated total before ordering.",
                );
              }
              return {
                dishId,
                name: dish.name,
                nameBn: dish.nameBn,
                quantity,
                unitPrice,
                subtotal: unitPrice * quantity,
                variant: variant ? { ...variant } : null,
                addons: selectedAddons.map((option) => ({ ...option })),
              };
            },
          );
          const now = new Date();
          const order = {
            _id: new ObjectId(),
            code: "AG-" + randomBytes(5).toString("hex").toUpperCase(),
            guestHash,
            ...(actor.customerId ? { customerId: actor.customerId } : {}),
            requestKey,
            fingerprint,
            tableId: table._id,
            visitId: context.visitId,
            tableNumber: table.number,
            items: orderItems,
            note: input.note,
            source: actor.source || "guest",
            ...(actor.by ? { takenBy: actor.by } : {}),
            total: orderItems.reduce((total, item) => total + item.subtotal, 0),
            status: "placed",
            revision: 0,
            createdAt: now,
            updatedAt: now,
            history: [{ status: "placed", at: now }],
          };
          await orders.insertOne(order, { session });
          return { order: orderView(order), replay: false };
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
      ),
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await orders.findOne(requestFilter);
    if (existing) return replay(existing);
    throw new HttpError(503, "RETRY_ORDER", "Please retry this checkout.");
  }
}

export async function closeTable(store, number) {
  const { client, tables, orders } = store;
  return client.withSession((session) =>
    session.withTransaction(
      async () => {
        const table = await tables.findOneAndUpdate(
          { number, activeVisitId: { $type: "objectId" } },
          {
            $set: { activeVisitId: null, openedAt: null, promotion: null },
            $unset: { reservationId: "", waitlistId: "" },
            $inc: { revision: 1 },
          },
          { session, returnDocument: "before" },
        );
        if (!table)
          throw new HttpError(
            409,
            "TABLE_NOT_OPEN",
            "This table is already closed or does not exist.",
          );
        const unfinished = await orders.findOne(
          {
            tableId: table._id,
            visitId: table.activeVisitId,
            status: { $in: ACTIVE },
          },
          { session, projection: { _id: 1 } },
        );
        if (unfinished)
          throw new HttpError(
            409,
            "TABLE_BUSY",
            "Finish or reject the open orders before closing this table.",
          );
        const served = await orders.findOne(
          {
            tableId: table._id,
            visitId: table.activeVisitId,
            status: "served",
          },
          { session },
        );
        if (served)
          throw new HttpError(
            409,
            "BILL_REQUIRED",
            "Finalize and settle this table at the counter to close the visit.",
          );
        if (table.reservationId)
          await store.reservations.updateOne(
            { _id: table.reservationId, status: "seated" },
            { $set: { status: "completed", completedAt: new Date() } },
            { session },
          );
        await store.serviceRequests.updateMany(
          { tableId: table._id, visitId: table.activeVisitId, status: "open" },
          {
            $set: {
              status: "resolved",
              resolvedAt: new Date(),
              resolvedBy: "system",
              resolutionReason: "table_closed",
            },
          },
          { session },
        );
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    ),
  );
}
