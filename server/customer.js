import { ObjectId } from "mongodb";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { body, HttpError } from "./http.js";
import {
  issueAccountMail,
  mailStatus,
  registerAccountMail,
} from "./account-mail.js";
import {
  cookieOptions,
  getGuest,
  hash,
  passwordHash,
  passwordMatches,
  randomToken,
  sessionToken,
} from "./security.js";

export const CUSTOMER_COOKIE = "angar_customer";
const lifetime = 30 * 86400000;
const email = z.string().trim().toLowerCase().email().max(254);
export const contactPhone = z
  .string()
  .trim()
  .regex(/^[+\d][\d ()-]{6,24}$/, "Enter a valid contact phone number.");
const password = z.string().min(12, "Use at least 12 characters.").max(128);
export const customerView = (customer) =>
  customer
    ? {
        id: customer._id.toString(),
        name: customer.name,
        email: customer.email,
        phone: customer.phone || "",
        points: customer.points || 0,
        emailVerified: Boolean(customer.emailVerifiedAt),
      }
    : null;
export function requireCustomer(req, res, next) {
  if (!req.customer)
    throw new HttpError(
      401,
      "CUSTOMER_REQUIRED",
      "Sign in to your customer account first.",
    );
  next();
}
export const orderOwner = (req, guestHash) =>
  req.customer
    ? {
        $or: [
          { customerId: req.customer._id },
          { guestHash, customerId: null },
        ],
      }
    : { guestHash, customerId: null };
export const actorKey = (req, guestHash) =>
  req.customer ? "customer:" + req.customer._id : "guest:" + guestHash;

export function customerMiddleware(store) {
  return async (req, res, next) => {
    const token = req.cookies[CUSTOMER_COOKIE];
    req.customer = null;
    if (sessionToken(token)) {
      const session = await store.customerSessions.findOne({
        _id: hash(token),
        expiresAt: { $gt: new Date() },
      });
      if (session) {
        const customer = await store.customers.findOne(
          { _id: session.customerId, active: true },
          { projection: { passwordHash: 0 } },
        );
        if (
          customer &&
          (customer.authVersion || 0) === (session.authVersion || 0)
        )
          req.customer = customer;
      }
    }
    next();
  };
}
async function signIn(store, req, res, config, customer) {
  const old = req.cookies[CUSTOMER_COOKIE];
  if (sessionToken(old))
    await store.customerSessions.deleteOne({ _id: hash(old) });
  const token = randomToken();
  await store.customerSessions.insertOne({
    _id: hash(token),
    customerId: customer._id,
    authVersion: customer.authVersion || 0,
    expiresAt: new Date(Date.now() + lifetime),
  });
  res.cookie(
    CUSTOMER_COOKIE,
    token,
    cookieOptions(config, { maxAge: lifetime }),
  );
  const guestHash = getGuest(req, res, config);
  // Possession of the signed guest cookie proves ownership of unclaimed history.
  for (const collection of [
    store.orders,
    store.reservations,
    store.waitlist,
    store.fulfillments,
  ])
    await collection.updateMany(
      { guestHash, customerId: null },
      { $set: { customerId: customer._id } },
    );
}

export function registerCustomers(api, store, config, requireId) {
  registerAccountMail(api, store, config, requireCustomer);
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMIT",
        message: "Too many account attempts. Please wait before trying again.",
      },
    },
  });
  api.get("/account", (req, res) =>
    res.json({
      customer: customerView(req.customer),
      mail: mailStatus(config),
      loyalty: { earnPerBdt: 100, valuePerPoint: 1, maxRedemptionPercent: 20 },
    }),
  );
  api.post("/account/register", authLimit, async (req, res) => {
    const input = body(
      z.strictObject({
        name: z.string().trim().min(2).max(80),
        email,
        password,
        phone: contactPhone.optional(),
      }),
      req.body,
    );
    const customer = {
      _id: new ObjectId(),
      name: input.name,
      email: input.email,
      phone: input.phone || "",
      passwordHash: await passwordHash(input.password),
      points: 0,
      active: true,
      createdAt: new Date(),
    };
    try {
      await store.customers.insertOne(customer);
    } catch (error) {
      if (error.code === 11000)
        throw new HttpError(
          409,
          "ACCOUNT_EXISTS",
          "An account is already registered with that email. Sign in instead.",
        );
      throw error;
    }
    await signIn(store, req, res, config, customer);
    const verification = await issueAccountMail(
      store,
      config,
      customer,
      "verify",
    );
    res.status(201).json({ customer: customerView(customer), verification });
  });
  api.post("/account/login", authLimit, async (req, res) => {
    const input = body(
      z.strictObject({ email, password: z.string().min(1).max(128) }),
      req.body,
    );
    const customer = await store.customers.findOne({
      email: input.email,
      active: true,
    });
    if (!(await passwordMatches(input.password, customer?.passwordHash)))
      throw new HttpError(
        401,
        "LOGIN_FAILED",
        "The email or password is incorrect.",
      );
    await signIn(store, req, res, config, customer);
    res.json({ customer: customerView(customer) });
  });
  api.post("/account/logout", async (req, res) => {
    const token = req.cookies[CUSTOMER_COOKIE];
    if (sessionToken(token))
      await store.customerSessions.deleteOne({ _id: hash(token) });
    res.clearCookie(CUSTOMER_COOKIE, cookieOptions(config));
    res.status(204).end();
  });
  api.patch("/account", requireCustomer, async (req, res) => {
    const input = body(
      z.strictObject({
        name: z.string().trim().min(2).max(80),
        phone: contactPhone.or(z.literal("")),
      }),
      req.body,
    );
    const customer = await store.customers.findOneAndUpdate(
      { _id: req.customer._id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    res.json({ customer: customerView(customer) });
  });
  api.post(
    "/account/password",
    requireCustomer,
    authLimit,
    async (req, res) => {
      const input = body(
        z.strictObject({
          currentPassword: z.string().min(1).max(128),
          newPassword: password,
        }),
        req.body,
      );
      const customer = await store.customers.findOne({ _id: req.customer._id });
      if (
        !(await passwordMatches(input.currentPassword, customer.passwordHash))
      )
        throw new HttpError(
          401,
          "LOGIN_FAILED",
          "The current password is incorrect.",
        );
      const updated = await store.customers.findOneAndUpdate(
        { _id: customer._id },
        {
          $set: { passwordHash: await passwordHash(input.newPassword) },
          $inc: { authVersion: 1 },
        },
        { returnDocument: "after" },
      );
      await store.customerSessions.deleteMany({ customerId: customer._id });
      await store.accountTokens.deleteMany({ customerId: customer._id });
      await signIn(store, req, res, config, updated);
      res.status(204).end();
    },
  );
  api.get("/account/loyalty", requireCustomer, async (req, res) => {
    const customer = await store.customers.findOne({ _id: req.customer._id });
    const rows = await store.loyaltyLedger
      .find({ customerId: customer._id })
      .sort({ at: -1 })
      .limit(50)
      .toArray();
    res.json({
      points: customer.points || 0,
      ledger: rows.map(({ key, delta, reason, at }) => ({
        id: key,
        delta,
        reason,
        at,
      })),
    });
  });
  api.get("/account/history", requireCustomer, async (req, res) => {
    let cursor;
    if (req.query.before) {
      try {
        cursor = JSON.parse(
          Buffer.from(String(req.query.before), "base64url").toString(),
        );
        if (
          !ObjectId.isValid(cursor.id) ||
          !Number.isFinite(new Date(cursor.at).getTime())
        )
          throw Error();
      } catch {
        throw new HttpError(400, "INVALID_CURSOR", "Invalid history page.");
      }
    }
    const filter = {
      customerId: req.customer._id,
      ...(cursor
        ? {
            $or: [
              { createdAt: { $lt: new Date(cursor.at) } },
              {
                createdAt: new Date(cursor.at),
                _id: { $lt: new ObjectId(cursor.id) },
              },
            ],
          }
        : {}),
    };
    const rows = await store.orders
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(26)
      .toArray();
    const page = rows.slice(0, 25),
      last = page.at(-1);
    res.json({
      orders: page.map((order) => ({
        id: order._id.toString(),
        code: order.code,
        tableNumber: order.tableNumber,
        status: order.status,
        total: order.total,
        createdAt: order.createdAt,
        items: order.items,
      })),
      next:
        rows.length > 25
          ? Buffer.from(
              JSON.stringify({
                id: last._id.toString(),
                at: last.createdAt.toISOString(),
              }),
            ).toString("base64url")
          : null,
    });
  });
  api.post("/account/orders/:id/reorder", requireCustomer, async (req, res) => {
    const order = await store.orders.findOne({
      _id: requireId(req.params.id),
      customerId: req.customer._id,
    });
    if (!order)
      throw new HttpError(404, "NOT_FOUND", "This order could not be found.");
    const dishes = await store.dishes
      .find({ _id: { $in: order.items.map((item) => item.dishId) } })
      .toArray();
    const items = [],
      warnings = [];
    for (const item of order.items) {
      const dish = dishes.find((row) => row._id === item.dishId);
      const variant = item.variant
        ? dish?.variants?.find((option) => option.id === item.variant.id)
        : null;
      const addons = (item.addons || []).map((addon) =>
        dish?.addons?.find((option) => option.id === addon.id),
      );
      if (
        !dish?.available ||
        (item.variant && !variant) ||
        addons.some((addon) => !addon)
      ) {
        warnings.push(item.name + " is unavailable or its options changed.");
        continue;
      }
      const unitPrice =
        dish.price +
        (variant?.price || 0) +
        addons.reduce((sum, addon) => sum + addon.price, 0);
      if (unitPrice !== item.unitPrice)
        warnings.push(
          item.name + " now costs BDT " + unitPrice + " per portion.",
        );
      items.push({
        dishId: dish._id,
        quantity: item.quantity,
        ...(variant ? { variantId: variant.id } : {}),
        addonIds: addons.map((addon) => addon.id),
        expectedPrice: unitPrice,
      });
    }
    res.json({ items, warnings, note: order.note || "" });
  });
}
