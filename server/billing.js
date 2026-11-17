import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { HttpError } from "./http.js";
import { ACTIVE } from "./orders.js";
import { restaurantSettings } from "./restaurant.js";

export function billView(bill) {
  const {
    _id,
    receiptNo,
    tableNumber,
    status,
    items,
    subtotalMinor,
    chargeMinor,
    totalMinor,
    serviceChargeBps,
    createdAt,
    paidAt,
    payment,
  } = bill;
  return {
    id: _id.toString(),
    receiptNo,
    tableNumber,
    status,
    items,
    subtotal: subtotalMinor / 100,
    charge: chargeMinor / 100,
    total: totalMinor / 100,
    serviceChargeBps,
    createdAt,
    paidAt,
    payment: payment
      ? { method: payment.method, reference: payment.reference }
      : null,
  };
}

export async function finalizeBill(store, tableNumber, user) {
  return store.client.withSession((session) =>
    session.withTransaction(
      async () => {
        const table = await store.tables.findOneAndUpdate(
          { number: tableNumber, activeVisitId: { $type: "objectId" } },
          { $inc: { revision: 1 } },
          { session },
        );
        if (!table)
          throw new HttpError(
            409,
            "TABLE_NOT_OPEN",
            "This table has no open visit.",
          );
        const existing = await store.bills.findOne(
          { visitId: table.activeVisitId },
          { session },
        );
        if (existing) return billView(existing);
        const orders = await store.orders
          .find(
            { tableId: table._id, visitId: table.activeVisitId },
            { session },
          )
          .toArray();
        if (orders.some((order) => ACTIVE.includes(order.status))) {
          throw new HttpError(
            409,
            "UNFINISHED_ORDERS",
            "Serve or decline the unfinished orders before finalizing the bill.",
          );
        }
        const served = orders.filter((order) => order.status === "served");
        if (!served.length)
          throw new HttpError(
            409,
            "EMPTY_BILL",
            "There are no served orders to bill.",
          );
        const settings = await restaurantSettings(store, session);
        const subtotalMinor = served.reduce(
          (total, order) => total + Math.round(order.total * 100),
          0,
        );
        const chargeMinor = Math.round(
          (subtotalMinor * settings.serviceChargeBps) / 10000,
        );
        const bill = {
          _id: new ObjectId(),
          receiptNo: "AK-" + randomBytes(6).toString("hex").toUpperCase(),
          tableId: table._id,
          tableNumber,
          visitId: table.activeVisitId,
          orderIds: served.map((order) => order._id),
          items: served.flatMap((order) =>
            order.items.map((item) => ({
              name: item.name,
              nameBn: item.nameBn,
              variant: item.variant || null,
              addons: item.addons || [],
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.subtotal,
            })),
          ),
          status: "finalized",
          serviceChargeBps: settings.serviceChargeBps,
          subtotalMinor,
          chargeMinor,
          totalMinor: subtotalMinor + chargeMinor,
          createdAt: new Date(),
          createdBy: user.username,
        };
        await store.bills.insertOne(bill, { session });
        await store.tables.updateOne(
          { _id: table._id },
          { $set: { billingState: "finalized", billId: bill._id } },
          { session },
        );
        await store.audit.insertOne(
          {
            type: "bill.finalized",
            billId: bill._id,
            by: user.username,
            at: new Date(),
          },
          { session },
        );
        return billView(bill);
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    ),
  );
}

export async function settleBill(store, id, payment, user) {
  return store.client.withSession((session) =>
    session.withTransaction(
      async () => {
        const bill = await store.bills.findOneAndUpdate(
          { _id: id },
          { $inc: { revision: 1 } },
          { session },
        );
        if (!bill)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "This bill could not be found.",
          );
        if (bill.status === "paid") return billView(bill);
        const now = new Date();
        const record = {
          method: payment.method,
          reference: payment.reference,
          by: user.username,
          at: now,
        };
        await store.bills.updateOne(
          { _id: id, status: "finalized" },
          {
            $set: { status: "paid", paidAt: now, payment: record },
          },
          { session },
        );
        const closed = await store.tables.updateOne(
          {
            _id: bill.tableId,
            activeVisitId: bill.visitId,
            billId: id,
          },
          {
            $set: {
              activeVisitId: null,
              openedAt: null,
              billingState: "open",
              lastBillId: id,
            },
            $unset: { billId: "" },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (!closed.matchedCount)
          throw new HttpError(
            409,
            "TABLE_CHANGED",
            "The table visit changed. Refresh before recording payment.",
          );
        await store.audit.insertOne(
          {
            type: "bill.paid",
            billId: id,
            by: user.username,
            method: payment.method,
            at: now,
          },
          { session },
        );
        await store.serviceRequests.updateMany(
          { tableId: bill.tableId, visitId: bill.visitId, status: "open" },
          {
            $set: {
              status: "resolved",
              resolvedAt: now,
              resolvedBy: user.username,
            },
          },
          { session },
        );
        return billView({
          ...bill,
          status: "paid",
          paidAt: now,
          payment: record,
        });
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    ),
  );
}
