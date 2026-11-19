import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { HttpError } from "./http.js";
import { ACTIVE } from "./orders.js";
import { restaurantSettings } from "./restaurant.js";
import { promotionTotals } from "./rewards.js";
import { finishBill } from "./payments.js";
import { billView } from "./bill-view.js";
export { billView } from "./bill-view.js";
export { settleBill } from "./payments.js";

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
        const billId = new ObjectId();
        const promotion = await promotionTotals(
          store,
          table,
          subtotalMinor,
          session,
          billId,
        );
        const chargeMinor = Math.round(
          (promotion.netSubtotalMinor * settings.serviceChargeBps) / 10000,
        );
        const bill = {
          _id: billId,
          receiptNo: "AK-" + randomBytes(6).toString("hex").toUpperCase(),
          tableId: table._id,
          tableNumber,
          visitId: table.activeVisitId,
          orderIds: served.map((order) => order._id),
          items: served.flatMap((order) =>
            order.items.map((item, index) => ({
              lineId: order._id.toString() + ":" + index,
              dishId: item.dishId,
              ownerKey: order.customerId
                ? "member:" + order.customerId
                : "guest:" + order.guestHash,
              ...(order.customerId
                ? { ownerCustomerId: order.customerId }
                : {}),
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
          ...promotion,
          totalMinor: promotion.netSubtotalMinor + chargeMinor,
          paidMinor: 0,
          payments: [],
          holds: [],
          splits: [],
          revision: 0,
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
        return billView(
          bill.totalMinor === 0 ? await finishBill(store, bill, session) : bill,
        );
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    ),
  );
}
