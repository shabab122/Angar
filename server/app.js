import { fileURLToPath } from "node:url";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
  registerGuestFeatures,
  registerStaffFeatures,
  allowRoles,
} from "./features.js";
import {
  normalizeDish,
  publicReview,
  restaurantSettings,
} from "./restaurant.js";
import { billView } from "./billing.js";
import {
  actionInput,
  body,
  dishEditInput,
  errorHandler,
  HttpError,
  loginInput,
  orderInput,
  reviewDecisionInput,
  reviewInput,
  dishId,
} from "./http.js";
import { ACTIVE, closeTable, orderView, placeOrder } from "./orders.js";
import {
  cookieOptions,
  getGuest,
  getTableCookie,
  hash,
  objectId,
  passwordMatches,
  randomToken,
  SESSION_LIFETIME,
  sessionToken,
  STAFF_COOKIE,
  TABLE_COOKIE,
  tableVisitKey,
} from "./security.js";

import { moveOrder } from "./order-changes.js";
import { customerMiddleware, orderOwner } from "./customer.js";
import { registerGatewayCallbacks } from "./gateway.js";
import {
  beginStaffLogin,
  registerMfaLogin,
  staffPayload,
  clearPendingMfa,
} from "./staff-mfa.js";
import { openWalkInTable } from "./reservations.js";

const publicDir = fileURLToPath(new URL("../dist/", import.meta.url));
const staffStatuses = {
  admin: ACTIVE,
  kitchen: ["queued", "preparing"],
  waiter: ["ready"],
  cashier: ACTIVE,
};

function limiter(limit, windowMs) {
  return rateLimit({
    limit,
    windowMs,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMIT",
        message: "Too many attempts. Please wait and try again.",
      },
    },
  });
}

function requireId(value) {
  const id = objectId(value);
  if (!id)
    throw new HttpError(404, "NOT_FOUND", "This record could not be found.");
  return id;
}

const tableView = (table) => ({
  number: table.number,
  open: Boolean(table.activeVisitId),
  openedAt: table.openedAt,
  billingState: table.billingState || "open",
  visitKey: table.activeVisitId ? tableVisitKey(table.activeVisitId) : null,
});

export function createApp(store, config, frontendMiddleware) {
  const { db, tables, orders, dishes, reviews, staff, sessions } = store;
  const app = express();
  app.disable("x-powered-by");
  if (config.proxyHops) app.set("trust proxy", config.proxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: config.dev
        ? false
        : {
            directives: {
              upgradeInsecureRequests: config.production ? [] : null,
            },
          },
      strictTransportSecurity: config.production ? undefined : false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(cookieParser(config.cookieSecret));
  registerGatewayCallbacks(app, store, config);

  app.get("/healthz", async (req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: "ok" });
  });
  app.get("/t/:token", limiter(150, 15 * 60 * 1000), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = req.params.token;
    const table = /^[A-Za-z0-9_-]{32}$/.test(token)
      ? await tables.findOne({ qrToken: token })
      : null;
    if (!table) {
      res.clearCookie(TABLE_COOKIE, cookieOptions(config));
      return res.redirect(303, "/menu?scan=invalid");
    }
    getGuest(req, res, config);
    res.cookie(
      TABLE_COOKIE,
      `${table._id}:${table.activeVisitId || "-"}`,
      cookieOptions(config, {
        signed: true,
        maxAge: SESSION_LIFETIME,
      }),
    );
    res.redirect(303, "/menu");
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (["POST", "PATCH", "DELETE"].includes(req.method)) {
      if (req.get("origin") !== config.origin)
        throw new HttpError(
          403,
          "ORIGIN",
          "This request must come from the restaurant website.",
        );
      const photoUpload =
        req.method === "POST" &&
        /^\/orders\/[a-f0-9]{24}\/reviews\/[a-z0-9-]+\/photo$/.test(req.path) &&
        req.is(["image/jpeg", "image/png", "image/webp"]);
      if (!photoUpload && !req.is("application/json"))
        throw new HttpError(415, "CONTENT_TYPE", "Send a JSON request.");
    }
    next();
  });
  api.use(express.json({ limit: "18kb" }));
  api.use(customerMiddleware(store));

  api.get("/menu", async (req, res) => {
    const [menu, aggregates] = await Promise.all([
      dishes.find({}).sort({ position: 1 }).toArray(),
      reviews
        .aggregate([
          { $match: { status: "approved", visibility: { $ne: "private" } } },
          {
            $group: {
              _id: "$dishId",
              count: { $sum: 1 },
              average: { $avg: "$rating" },
            },
          },
        ])
        .toArray(),
    ]);
    const ratings = new Map(
      aggregates.map(({ _id, ...rating }) => [_id, rating]),
    );
    res.json({
      dishes: menu.map((dish) => ({
        ...normalizeDish(dish),
        rating: ratings.get(dish._id) || null,
      })),
    });
  });
  api.get("/menu/:id/reviews", async (req, res) => {
    const dish = await dishes.findOne(
      { _id: req.params.id },
      { projection: { _id: 1 } },
    );
    if (!dish)
      throw new HttpError(404, "NOT_FOUND", "This dish could not be found.");
    const recent = await reviews
      .find({
        dishId: dish._id,
        status: "approved",
        visibility: { $ne: "private" },
      })
      .sort({ createdAt: -1 })
      .limit(12)
      .toArray();
    res.json({ reviews: recent.map(publicReview) });
  });

  api.get("/context", async (req, res) => {
    getGuest(req, res, config);
    const cookie = getTableCookie(req);
    const table = cookie ? await tables.findOne({ _id: cookie.tableId }) : null;
    const active = Boolean(
      table?.activeVisitId && table.activeVisitId.equals(cookie.visitId),
    );
    res.json({
      table: table
        ? {
            number: table.number,
            active,
            visitKey: active ? tableVisitKey(table.activeVisitId) : null,
            billingState: table.billingState || "open",
          }
        : null,
    });
  });
  api.post("/context/leave", (req, res) => {
    res.clearCookie(TABLE_COOKIE, cookieOptions(config));
    res.status(204).end();
  });

  api.get("/orders", async (req, res) => {
    const guestHash = getGuest(req, res, config);
    const recent = await orders
      .find({
        ...orderOwner(req, guestHash),
        ...(req.query.id ? { _id: requireId(req.query.id) } : {}),
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();
    const ownReviews = await reviews
      .find(
        { orderId: { $in: recent.map((order) => order._id) } },
        {
          projection: { orderId: 1, dishId: 1, status: 1, visibility: 1 },
        },
      )
      .toArray();
    const byOrder = new Map();
    for (const review of ownReviews) {
      const id = review.orderId.toString();
      if (!byOrder.has(id)) byOrder.set(id, []);
      byOrder.get(id).push({
        dishId: review.dishId,
        status: review.status,
        visibility: review.visibility || "public",
      });
    }
    const bills = await store.bills
      .find({ visitId: { $in: recent.map((order) => order.visitId) } })
      .toArray();
    res.json({
      orders: recent.map((order) => ({
        ...orderView(order),
        reviews: byOrder.get(order._id.toString()) || [],
        bill: bills.find((bill) => bill.visitId.equals(order.visitId))
          ? billView(bills.find((bill) => bill.visitId.equals(order.visitId)))
          : null,
      })),
    });
  });
  api.post("/orders", limiter(120, 15 * 60 * 1000), async (req, res) => {
    const requestKey = req.get("idempotency-key");
    if (!requestKey || !/^[a-f0-9]{32}$/.test(requestKey)) {
      throw new HttpError(400, "INVALID_KEY", "Missing checkout attempt key.");
    }
    const input = body(orderInput, req.body);
    const result = await placeOrder(
      store,
      getGuest(req, res, config),
      getTableCookie(req),
      requestKey,
      input,
      req.customer ? { customerId: req.customer._id } : {},
    );
    res.status(result.replay ? 200 : 201).json({ order: result.order });
  });
  api.post(
    "/orders/:id/reviews",
    limiter(100, 15 * 60 * 1000),
    async (req, res) => {
      const id = requireId(req.params.id);
      const input = body(reviewInput, req.body);
      const order = await orders.findOne({
        _id: id,
        ...orderOwner(req, getGuest(req, res, config)),
      });
      if (!order || !order.items.some((item) => item.dishId === input.dishId)) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This item is not in your order.",
        );
      }
      if (order.status !== "served")
        throw new HttpError(
          409,
          "NOT_SERVED",
          "You can review this dish once it has been served.",
        );
      const dish = order.items.find((item) => item.dishId === input.dishId);
      try {
        await reviews.insertOne({
          ...input,
          orderId: id,
          dishName: dish.name,
          orderCode: order.code,
          status: "pending",
          source: "guest",
          createdAt: new Date(),
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        throw new HttpError(
          409,
          "REVIEW_EXISTS",
          "You already reviewed this dish in this order.",
        );
      }
      res.status(201).json({ status: "pending" });
    },
  );

  async function requireStaff(req, res, next) {
    const token = req.cookies[STAFF_COOKIE];
    const session = sessionToken(token)
      ? await sessions.findOne({
          _id: hash(token),
          expiresAt: { $gt: new Date() },
        })
      : null;
    const user = session
      ? await staff.findOne(
          { _id: session.staffId, active: true },
          { projection: { passwordHash: 0 } },
        )
      : null;
    if (!user || (user.authVersion || 0) !== (session.authVersion || 0))
      throw new HttpError(
        401,
        "STAFF_REQUIRED",
        "Sign in to the staff workspace.",
      );
    req.staff = user;
    if (
      staffPayload(user, config).mfaSetupRequired &&
      !["/me", "/password"].includes(req.path) &&
      !/^\/mfa(?:\/|$)/.test(req.path)
    )
      throw new HttpError(
        403,
        "MFA_REQUIRED",
        "Set up your administrator authenticator before using this workspace.",
      );
    if (user.mustChangePassword && !["/me", "/password"].includes(req.path))
      throw new HttpError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Change your temporary staff password before using the workspace.",
      );
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.staff.role !== "admin")
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Only an admin can make this change.",
      );
    next();
  }

  const staffApi = express.Router();
  registerMfaLogin(staffApi, store, config);
  staffApi.post("/login", limiter(20, 15 * 60 * 1000), async (req, res) => {
    const { username, password } = body(loginInput, req.body);
    const user = await staff.findOne({ username, active: true });
    if (!(await passwordMatches(password, user?.passwordHash))) {
      await store.audit.insertOne({
        type: "staff.login_failed",
        by: username,
        at: new Date(),
      });
      throw new HttpError(
        401,
        "LOGIN_FAILED",
        "The username or password is incorrect.",
      );
    }
    await beginStaffLogin(store, config, req, res, user);
  });
  staffApi.post("/logout", async (req, res) => {
    const token = req.cookies[STAFF_COOKIE];
    if (sessionToken(token)) await sessions.deleteOne({ _id: hash(token) });
    res.clearCookie(STAFF_COOKIE, cookieOptions(config));
    await clearPendingMfa(store, req, res, config);
    res.status(204).end();
  });
  staffApi.use(requireStaff);
  staffApi.get("/me", (req, res) => res.json(staffPayload(req.staff, config)));
  staffApi.get("/orders", async (req, res) => {
    const role = req.staff.role;
    const [active, recent] = await Promise.all([
      orders
        .find({ status: { $in: staffStatuses[role] } })
        .sort({ createdAt: 1 })
        .limit(121)
        .toArray(),
      role === "admin"
        ? orders
            .find({ status: { $in: ["served", "cancelled"] } })
            .sort({ updatedAt: -1 })
            .limit(20)
            .toArray()
        : [],
    ]);
    res.json({
      orders: active.slice(0, 120).map((order) => orderView(order, true)),
      recent: recent.map((order) => orderView(order, true)),
      more: active.length > 120,
    });
  });
  staffApi.post("/orders/:id/action", async (req, res) => {
    const id = requireId(req.params.id);
    const { action, reason } = body(actionInput, req.body);
    const order = await moveOrder(store, id, action, reason, req.staff);
    res.json({ order });
  });
  staffApi.get(
    "/tables",
    allowRoles("admin", "waiter", "cashier"),
    async (req, res) => {
      const rows = await tables.find({}).sort({ number: 1 }).toArray();
      res.json({ tables: rows.map(tableView) });
    },
  );
  staffApi.post(
    "/tables/:number/open",
    allowRoles("admin", "waiter"),
    async (req, res) => {
      const table = await openWalkInTable(store, req.params.number);
      res.json({ table: tableView(table) });
    },
  );
  staffApi.post(
    "/tables/:number/close",
    allowRoles("admin", "waiter"),
    async (req, res) => {
      await closeTable(store, req.params.number);
      res.status(204).end();
    },
  );
  staffApi.get("/reviews", requireAdmin, async (req, res) => {
    const [pending, moderated] = await Promise.all([
      reviews
        .find({ status: "pending" })
        .sort({ createdAt: 1 })
        .limit(80)
        .toArray(),
      reviews
        .find({ status: { $in: ["approved", "hidden"] }, source: "guest" })
        .sort({ moderatedAt: -1 })
        .limit(25)
        .toArray(),
    ]);
    res.json({
      reviews: [...pending, ...moderated].map((review) => ({
        id: review._id.toString(),
        dishName: review.dishName,
        orderCode: review.orderCode,
        ...publicReview(review),
        photo: review.imageFile
          ? "/api/staff/review-media/" + review.imageFile
          : null,
        status: review.status,
        visibility: review.visibility || "public",
        reason: review.reason || "",
      })),
    });
  });
  staffApi.patch("/reviews/:id", requireAdmin, async (req, res) => {
    const id = requireId(req.params.id);
    const { status, reason, reply } = body(reviewDecisionInput, req.body);
    const review = await reviews.findOneAndUpdate(
      { _id: id, source: "guest" },
      {
        $set: {
          status,
          reason,
          reply,
          moderatedAt: new Date(),
          moderatedBy: req.staff.username,
        },
      },
      { returnDocument: "after" },
    );
    if (!review)
      throw new HttpError(404, "NOT_FOUND", "This review could not be found.");
    res.json({ status: review.status });
  });
  staffApi.patch(
    "/menu/:id/availability",
    allowRoles("admin", "kitchen"),
    async (req, res) => {
      const input = body(
        z.strictObject({
          available: z.boolean(),
          expectedAvailable: z.boolean(),
        }),
        req.body,
      );
      const dish = await store.client.withSession((session) =>
        session.withTransaction(async () => {
          const changed = await dishes.findOneAndUpdate(
            { _id: req.params.id, available: input.expectedAvailable },
            { $set: { available: input.available, updatedAt: new Date() } },
            { session, returnDocument: "after" },
          );
          if (!changed)
            throw new HttpError(
              409,
              "MENU_UPDATED",
              "Availability changed. Refresh the menu and try again.",
            );
          await store.audit.insertOne(
            {
              type: "dish.availability",
              dishId: changed._id,
              available: input.available,
              by: req.staff.username,
              at: new Date(),
            },
            { session },
          );
          return changed;
        }),
      );
      res.json({ dish: normalizeDish(dish) });
    },
  );
  staffApi.patch("/menu/:id", requireAdmin, async (req, res) => {
    const changes = body(dishEditInput, req.body);
    const dish = await dishes.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { ...changes, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!dish)
      throw new HttpError(404, "NOT_FOUND", "This dish could not be found.");
    res.json({ dish });
  });
  staffApi.post("/menu", requireAdmin, async (req, res) => {
    const input = body(
      dishEditInput.extend({
        _id: dishId,
        image: z.string().regex(/^\/assets\/[a-z0-9-]+\.webp$/),
      }),
      req.body,
    );
    if (!input.name || !input.description || !input.category)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Enter a name, description and category.",
      );
    const dish = normalizeDish({
      ...input,
      position: await dishes.countDocuments({}),
    });
    try {
      await dishes.insertOne(dish);
    } catch (error) {
      if (error.code !== 11000) throw error;
      throw new HttpError(409, "DISH_EXISTS", "Use a different dish ID.");
    }
    res.status(201).json({ dish });
  });
  registerGuestFeatures(api, store, config, requireId);
  registerStaffFeatures(staffApi, store, config, requireAdmin, requireId);
  api.use("/staff", staffApi);
  api.use((req, res) =>
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "This endpoint could not be found.",
      },
    }),
  );
  app.use("/api", api);

  if (frontendMiddleware) {
    app.use(frontendMiddleware);
  } else {
    app.use(
      express.static(publicDir, {
        index: false,
        maxAge: config.production ? "1h" : 0,
      }),
    );
    app.get(
      [
        "/",
        "/menu",
        "/orders",
        "/about",
        "/events",
        "/staff",
        "/account",
        "/account/action",
        "/notifications",
        "/takeaway",
        "/reservations",
        "/payment",
        "/receipt/:id",
      ],
      (req, res) => res.sendFile(path.join(publicDir, "index.html")),
    );
  }
  app.use((req, res) =>
    res
      .status(404)
      .type("text")
      .send("Page not found. Open / for the restaurant website."),
  );
  app.use(errorHandler);
  return app;
}
