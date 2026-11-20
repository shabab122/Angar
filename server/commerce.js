import { getGuest, getTableCookie } from "./security.js";
import { orderOwner } from "./customer.js";
import { billView } from "./bill-view.js";
import { HttpError } from "./http.js";
import { promotionTotals } from "./rewards.js";
import { restaurantSettings } from "./restaurant.js";
import { financialTotals } from "./invoices.js";

export async function requireBillOwner(store, bill, req, res, config) {
  if (bill?.fulfillmentId) {
    const own = await store.fulfillments.findOne(
      {
        _id: bill.fulfillmentId,
        ...orderOwner(req, getGuest(req, res, config)),
      },
      { projection: { _id: 1 } },
    );
    if (!own)
      throw new HttpError(404, "NOT_FOUND", "This bill could not be found.");
    return;
  }
  if (
    !bill ||
    !(await store.orders.findOne(
      {
        _id: { $in: bill.orderIds },
        ...orderOwner(req, getGuest(req, res, config)),
      },
      { projection: { _id: 1 } },
    ))
  )
    throw new HttpError(404, "NOT_FOUND", "This bill could not be found.");
}
export function registerGuestBills(api, store, config, requireId) {
  api.get("/bills/:id", async (req, res) => {
    const bill = await store.bills.findOne({ _id: requireId(req.params.id) });
    await requireBillOwner(store, bill, req, res, config);
    res.json({ bill: billView(bill) });
  });
  api.get("/table/bill", async (req, res) => {
    const context = getTableCookie(req);
    if (!context?.visitId) return res.json({ bill: null, preview: null });
    const table = await store.tables.findOne({
      _id: context.tableId,
      activeVisitId: context.visitId,
    });
    const own =
      table &&
      (await store.orders.findOne({
        visitId: context.visitId,
        ...orderOwner(req, getGuest(req, res, config)),
      }));
    if (!own) return res.json({ bill: null, preview: null });
    const bill = await store.bills.findOne({ visitId: context.visitId });
    if (bill) return res.json({ bill: billView(bill), preview: null });
    const orders = await store.orders
      .find({ visitId: context.visitId, status: { $ne: "cancelled" } })
      .toArray();
    const subtotalMinor = orders.reduce(
      (sum, order) => sum + Math.round(order.total * 100),
      0,
    );
    let totals = { discountMinor: 0, netSubtotalMinor: subtotalMinor },
      promotionError = "";
    try {
      totals = await promotionTotals(store, table, subtotalMinor);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      promotionError = error.message;
    }
    const settings = await restaurantSettings(store);
    res.json({
      bill: null,
      preview: {
        subtotalMinor,
        discountMinor: totals.discountMinor,
        ...financialTotals(totals.netSubtotalMinor, settings),
        promotionError,
        couponCode: table.promotion?.couponCode || "",
        loyaltyPoints: table.promotion?.loyaltyPoints || 0,
        canChangePromotion:
          !table.promotion ||
          table.promotion.customerId?.equals(req.customer?._id),
        ready:
          orders.length > 0 &&
          orders.every((order) => order.status === "served"),
      },
    });
  });
}
