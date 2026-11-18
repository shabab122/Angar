import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, dishId, HttpError, orderInput } from "./http.js";
import { billView, finalizeBill, settleBill } from "./billing.js";
import { ACTIVE, orderView, placeOrder } from "./orders.js";
import { getGuest, hash, randomToken, tableVisitKey } from "./security.js";
import {
  normalizeDish,
  publicSettings,
  restaurantSettings,
} from "./restaurant.js";
import { registerEventGuest, registerEventStaff } from "./events.js";
import {
  registerGuestServiceRequests,
  registerStaffServiceRequests,
} from "./service-requests.js";
import {
  cancelBeforeCooking,
  registerGuestOrderChanges,
  registerStaffOrderChanges,
} from "./order-changes.js";
import { registerReports } from "./reports.js";

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.staff.role))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Your station cannot perform this action.",
      );
    next();
  };
}

const paymentInput = z.strictObject({
  method: z.enum(["cash", "bkash", "nagad", "card"]),
  reference: z.string().trim().max(100).default(""),
  verified: z.literal(true, {
    error: "Verify the payment at the counter before recording it.",
  }),
});

export function registerGuestFeatures(api, store, config, requireId) {
  api.get("/restaurant", async (req, res) =>
    res.json({ restaurant: publicSettings(await restaurantSettings(store)) }),
  );
  api.post("/menu-match", async (req, res) => {
    const input = body(
      z.strictObject({
        budget: z.number().int().min(100).max(10000),
        people: z.number().int().min(1).max(10),
        spice: z.enum(["any", "mild", "medium", "hot"]),
      }),
      req.body,
    );
    const dishes = await store.dishes
      .find({ available: true })
      .sort({ position: 1 })
      .toArray();
    const matches = dishes
      .filter((dish) => ["mains", "grill"].includes(dish.category))
      .map(normalizeDish)
      .filter(
        (dish) =>
          dish.price * Math.ceil(input.people / dish.serves) <= input.budget &&
          (input.spice === "any" || dish.spice === input.spice),
      )
      .slice(0, 3)
      .map((dish) => ({
        dishId: dish._id,
        quantity: Math.ceil(input.people / dish.serves),
        total: dish.price * Math.ceil(input.people / dish.serves),
      }));
    res.json({ matches, mode: "menu-filters" });
  });

  registerGuestServiceRequests(api, store);
  registerGuestOrderChanges(api, store, config, requireId);

  api.get("/receipts/:id", async (req, res) => {
    const bill = await store.bills.findOne({
      _id: requireId(req.params.id),
      status: "paid",
    });
    if (!bill)
      throw new HttpError(404, "NOT_FOUND", "This receipt could not be found.");
    const ownOrder = await store.orders.findOne(
      { _id: { $in: bill.orderIds }, guestHash: getGuest(req, res, config) },
      { projection: { _id: 1 } },
    );
    if (!ownOrder)
      throw new HttpError(404, "NOT_FOUND", "This receipt could not be found.");
    res.json({ bill: billView(bill) });
  });

  api.post(
    "/orders/:id/reviews/:dishId/photo",
    express.raw({
      type: ["image/jpeg", "image/png", "image/webp"],
      limit: "4mb",
    }),
    async (req, res) => {
      const orderId = requireId(req.params.id);
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(
          400,
          "PHOTO_TYPE",
          "Choose a JPEG, PNG or WebP image up to 4 MB.",
        );
      const order = await store.orders.findOne({
        _id: orderId,
        guestHash: getGuest(req, res, config),
        status: "served",
      });
      const review =
        order &&
        (await store.reviews.findOne({ orderId, dishId: req.params.dishId }));
      if (!review)
        throw new HttpError(
          404,
          "NOT_FOUND",
          "Submit the review text before adding a photo.",
        );
      if (review.imageFile)
        throw new HttpError(
          409,
          "PHOTO_EXISTS",
          "A photo has already been attached to this review.",
        );
      let photo;
      try {
        photo = await sharp(req.body, { limitInputPixels: 16000000 })
          .rotate()
          .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
      } catch {
        throw new HttpError(
          400,
          "PHOTO_INVALID",
          "The image could not be processed. Your text review is already saved.",
        );
      }
      const filename = randomBytes(18).toString("hex") + ".webp";
      await mkdir(config.uploadDir, { recursive: true });
      const destination = path.join(config.uploadDir, filename);
      await writeFile(destination, photo, { flag: "wx" });
      try {
        const updated = await store.reviews.updateOne(
          { _id: review._id, imageFile: { $exists: false } },
          {
            $set: { imageFile: filename, status: "pending" },
          },
        );
        if (!updated.matchedCount) {
          await unlink(destination);
          throw new HttpError(
            409,
            "PHOTO_EXISTS",
            "Another photo was already saved.",
          );
        }
      } catch (error) {
        await unlink(destination).catch(() => {});
        throw error;
      }
      res.status(201).json({ status: "pending" });
    },
  );
  api.get("/review-media/:filename", async (req, res) => {
    if (!/^[a-f0-9]{36}\.webp$/.test(req.params.filename))
      throw new HttpError(404, "NOT_FOUND", "This image could not be found.");
    const review = await store.reviews.findOne({
      imageFile: req.params.filename,
      status: "approved",
      visibility: { $ne: "private" },
    });
    if (!review)
      throw new HttpError(404, "NOT_FOUND", "This image could not be found.");
    let image;
    try {
      image = await readFile(path.join(config.uploadDir, review.imageFile));
    } catch {
      throw new HttpError(404, "NOT_FOUND", "This image could not be found.");
    }
    res
      .type("webp")
      .set("Cache-Control", "private, max-age=0, must-revalidate")
      .send(image);
  });
  registerEventGuest(api, store, config, requireId);
}

export function registerStaffFeatures(
  api,
  store,
  config,
  requireAdmin,
  requireId,
) {
  const billingRoles = allowRoles("admin", "cashier");
  const floorRoles = allowRoles("admin", "waiter");

  api.get("/overview", async (req, res) => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const start = new Date(today + "T00:00:00+06:00");
    const [live, tables, pendingReviews, sales, days, requests, events] =
      await Promise.all([
        store.orders.countDocuments({ status: { $in: ACTIVE } }),
        store.tables.countDocuments({ activeVisitId: { $type: "objectId" } }),
        store.reviews.countDocuments({ status: "pending" }),
        store.bills
          .aggregate([
            { $match: { status: "paid", paidAt: { $gte: start } } },
            {
              $group: {
                _id: null,
                value: { $sum: "$totalMinor" },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        store.bills
          .aggregate([
            {
              $match: {
                status: "paid",
                paidAt: { $gte: new Date(start.getTime() - 6 * 86400000) },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: {
                    date: "$paidAt",
                    format: "%Y-%m-%d",
                    timezone: "Asia/Dhaka",
                  },
                },
                amount: { $sum: "$totalMinor" },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray(),
        store.serviceRequests.countDocuments({ status: "open" }),
        store.events.countDocuments({
          status: { $in: ["requested", "reviewing"] },
        }),
      ]);
    res.json({
      live,
      tables,
      pendingReviews,
      sales: (sales[0]?.value || 0) / 100,
      settledBills: sales[0]?.count || 0,
      days: days.map((day) => ({ date: day._id, amount: day.amount / 100 })),
      requests,
      events,
    });
  });

  api.get("/billing", billingRoles, async (req, res) => {
    const tables = await store.tables
      .find({ activeVisitId: { $type: "objectId" } })
      .sort({ number: 1 })
      .toArray();
    const visits = tables.map((table) => table.activeVisitId);
    const [orders, bills, recent] = await Promise.all([
      store.orders
        .find({ visitId: { $in: visits }, status: { $ne: "cancelled" } })
        .toArray(),
      store.bills.find({ visitId: { $in: visits } }).toArray(),
      store.bills
        .find({ status: "paid" })
        .sort({ paidAt: -1 })
        .limit(20)
        .toArray(),
    ]);
    res.json({
      tables: tables.map((table) => ({
        number: table.number,
        orders: orders
          .filter((order) => order.visitId.equals(table.activeVisitId))
          .map((order) => orderView(order, true)),
        bill: bills.find((bill) => bill.visitId.equals(table.activeVisitId))
          ? billView(
              bills.find((bill) => bill.visitId.equals(table.activeVisitId)),
            )
          : null,
      })),
      recent: recent.map(billView),
    });
  });
  api.post("/billing/:table/finalize", billingRoles, async (req, res) => {
    res.json({ bill: await finalizeBill(store, req.params.table, req.staff) });
  });
  api.post("/bills/:id/pay", billingRoles, async (req, res) => {
    const input = body(paymentInput, req.body);
    if (input.method !== "cash" && !input.reference)
      throw new HttpError(
        400,
        "REFERENCE_REQUIRED",
        "Enter the payment reference you verified.",
      );
    res.json({
      bill: await settleBill(store, requireId(req.params.id), input, req.staff),
    });
  });
  api.get("/bills/:id", billingRoles, async (req, res) => {
    const bill = await store.bills.findOne({ _id: requireId(req.params.id) });
    if (!bill)
      throw new HttpError(404, "NOT_FOUND", "This bill could not be found.");
    res.json({ bill: billView(bill) });
  });

  api.post("/manual-orders", floorRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        tableNumber: z.string().regex(/^T\d{2}$/),
        order: orderInput,
      }),
      req.body,
    );
    const requestKey = req.get("idempotency-key");
    if (!/^[a-f0-9]{32}$/.test(requestKey || ""))
      throw new HttpError(400, "INVALID_KEY", "Missing checkout key.");
    const table = await store.tables.findOne({
      number: input.tableNumber,
      activeVisitId: { $type: "objectId" },
    });
    if (!table)
      throw new HttpError(
        409,
        "TABLE_CLOSED",
        "Open this table before taking its order.",
      );
    const result = await placeOrder(
      store,
      hash("staff:" + req.staff._id),
      { tableId: table._id, visitId: table.activeVisitId },
      requestKey,
      input.order,
      { source: "staff", by: req.staff.username },
    );
    res.status(result.replay ? 200 : 201).json({ order: result.order });
  });

  registerStaffServiceRequests(api, store, floorRoles, requireId);
  registerStaffOrderChanges(api, store, requireAdmin, requireId);
  registerReports(api, store, billingRoles);

  api.get("/review-media/:filename", requireAdmin, async (req, res) => {
    if (!/^[a-f0-9]{36}\.webp$/.test(req.params.filename))
      throw new HttpError(404, "NOT_FOUND", "This image could not be found.");
    const review = await store.reviews.findOne({
      imageFile: req.params.filename,
    });
    if (!review)
      throw new HttpError(404, "NOT_FOUND", "This image could not be found.");
    let image;
    try {
      image = await readFile(path.join(config.uploadDir, review.imageFile));
    } catch {
      throw new HttpError(404, "NOT_FOUND", "This image could not be found.");
    }
    res.type("webp").set("Cache-Control", "no-store").send(image);
  });
  api.get("/settings", requireAdmin, async (req, res) =>
    res.json({ restaurant: publicSettings(await restaurantSettings(store)) }),
  );
  api.patch("/settings", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        orderingEnabled: z.boolean(),
        serviceChargeBps: z.number().int().min(0).max(2000),
      }),
      req.body,
    );
    await store.client.withSession((session) =>
      session.withTransaction(async () => {
        await store.settings.updateOne(
          { _id: "restaurant" },
          { $set: input },
          { upsert: true, session },
        );
        await store.audit.insertOne(
          {
            type: "settings.updated",
            changes: input,
            by: req.staff.username,
            at: new Date(),
          },
          { session },
        );
      }),
    );
    res.json({ restaurant: publicSettings(await restaurantSettings(store)) });
  });
  api.post("/tables/:number/rotate-qr", requireAdmin, async (req, res) => {
    const result = await store.tables.updateOne(
      { number: req.params.number },
      { $set: { qrToken: randomToken(24) } },
    );
    if (!result.matchedCount)
      throw new HttpError(404, "NOT_FOUND", "This table could not be found.");
    await store.audit.insertOne({
      type: "qr.rotated",
      tableNumber: req.params.number,
      by: req.staff.username,
      at: new Date(),
    });
    res.json({ status: "rotated" });
  });
  api.post("/orders/:id/cancel", requireAdmin, async (req, res) => {
    const id = requireId(req.params.id);
    const { reason } = body(
      z.strictObject({ reason: z.string().trim().min(3).max(160) }),
      req.body,
    );
    await cancelBeforeCooking(store, id, reason, req.staff);
    res.status(204).end();
  });
  registerEventStaff(api, store, requireAdmin, requireId);
}

export { allowRoles };
