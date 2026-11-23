import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash, randomToken, getGuest } from "./security.js";
import { orderOwner } from "./customer.js";
import { transaction, paidMinor, heldMinor } from "./money.js";
import { restaurantSettings } from "./restaurant.js";
import { branchPath } from "./branches.js";
import { assertStaffAction } from "./access.js";
import { passwordMatches } from "./security.js";
import {
  ecourierProvider,
  ecourierReady,
  prepareEcourier,
  ecourierInput,
} from "./courier-ecourier.js";
const key = z.string().regex(/^[a-f0-9]{32}$/),
  reason = z.string().trim().min(3).max(160),
  revision = z.number().int().min(0),
  id = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const position = z.strictObject({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(5000),
  capturedAt: z.iso.datetime(),
});
const providerInput = z.strictObject({
  id: id.optional(),
  reference: id,
  status: z.enum([
    "booked",
    "in_transit",
    "delivered",
    "cancelled",
    "not_found",
  ]),
  trackingUrl: z.string().max(1500).default(""),
  feeMinor: z.number().int().min(0).max(10_000_000).optional(),
  location: position.optional(),
  proof: z.string().trim().max(300).default(""),
});
const active = [
  "submitting",
  "booked",
  "in_transit",
  "delivered",
  "unknown",
  "cancel_unknown",
];
const providerReady = (config) =>
  config.courier?.provider === "ecourier"
    ? ecourierReady(config)
    : Boolean(
        config.courier?.url &&
        config.courier?.token &&
        (config.courier?.webhookSecret || "").length >= 32,
      );
export function safeCourierUrl(value) {
  if (!value) return "";
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      u.hostname === "localhost" ||
      /^\[|^\d+(?:\.\d+){3}$/.test(u.hostname) ||
      !u.hostname.includes(".")
    )
      throw 0;
    return u.href;
  } catch {
    throw new HttpError(
      400,
      "COURIER_URL",
      "Use an HTTPS courier address without credentials or a local host.",
    );
  }
}
function provider(config) {
  if (config.courier?.provider === "ecourier") return ecourierProvider(config);
  const configured = config.courier || {};
  const request = async (method, reference, payload) => {
    if (!providerReady(config))
      throw new HttpError(
        503,
        "COURIER_UNAVAILABLE",
        "Configure the courier adapter URL, token and webhook signing secret first.",
      );
    const base = safeCourierUrl(configured.url).replace(/\/$/, "");
    if (new URL(base).search)
      throw new HttpError(
        400,
        "COURIER_URL",
        "The courier adapter base URL cannot contain a query string.",
      );
    const response = config.courierTransport
      ? await config.courierTransport({ method, reference, payload })
      : await fetch(
          base +
            "/bookings" +
            (method === "POST" ? "" : "/" + encodeURIComponent(reference)),
          {
            method,
            headers: {
              Authorization: "Bearer " + configured.token,
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": reference,
            },
            body: method === "POST" ? JSON.stringify(payload) : undefined,
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        );
    let value;
    if (config.courierTransport) value = response;
    else {
      let text = "",
        size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 32 * 1024) throw new Error("Courier response too large");
        text += Buffer.from(chunk).toString("utf8");
      }
      if (!response.ok && response.status !== 404)
        throw new Error("Courier request not confirmed");
      value = JSON.parse(text);
    }
    const parsed = providerInput.safeParse(value);
    if (!parsed.success || parsed.data.reference !== reference)
      throw new Error("Courier response did not match its reference");
    if (parsed.data.trackingUrl)
      parsed.data.trackingUrl = safeCourierUrl(parsed.data.trackingUrl);
    return parsed.data;
  };
  return {
    book: (reference, payload) => request("POST", reference, payload),
    status: (reference) => request("GET", reference),
    cancel: (reference) => request("DELETE", reference),
  };
}
const referenceFor = (store, order) =>
  "AK-" + hash(store.db.databaseName + ":" + order._id).slice(0, 28);
const codeHash = (config, id, code) =>
  createHmac("sha256", config.cookieSecret)
    .update("delivery:" + id + ":" + code)
    .digest("hex");
const jobView = (row) =>
  row
    ? {
        id: row._id,
        orderId: String(row.orderId),
        source: row.source,
        providerType: row.providerType || "generic",
        pollNeedsReview: Boolean(row.pollNeedsReview),
        reference: row.reference || "",
        providerId: row.providerId || "",
        status: row.status,
        trackingUrl: row.trackingUrl || "",
        feeMinor: row.feeMinor ?? null,
        driverName: row.driverName || "",
        location: row.location || null,
        locationAt: row.locationAt || null,
        expiresAt: row.expiresAt || null,
        deliveryPendingReview: Boolean(row.deliveryPendingReview),
        confirmedAt: row.confirmedAt || null,
        proof: row.proof || "",
        updatedAt: row.updatedAt,
      }
    : null;
async function completeDelivery(store, orderId, actor, session) {
  const order = await store.fulfillments.findOneAndUpdate(
    { _id: orderId },
    { $inc: { revision: 1 } },
    { session, returnDocument: "before" },
  );
  if (!order || order.kind !== "delivery")
    throw new HttpError(404, "NOT_FOUND", "Delivery order not found.");
  if (order.status === "delivered") return order;
  if (order.status !== "dispatched")
    throw new HttpError(
      409,
      "FULFILLMENT_STATE",
      "Dispatch this delivery before confirming handover.",
    );
  const bill = await store.bills.findOneAndUpdate(
    { _id: order.billId },
    { $inc: { revision: 1 } },
    { session, returnDocument: "after" },
  );
  if (bill?.status !== "paid")
    throw new HttpError(
      409,
      "PAYMENT_REQUIRED",
      "Record and verify the full bill payment before confirming delivery.",
    );
  const at = new Date();
  await store.fulfillments.updateOne(
    { _id: order._id },
    {
      $set: { status: "delivered", updatedAt: at },
      $push: { history: { status: "delivered", at, by: actor } },
    },
    { session },
  );
  await store.audit.insertOne(
    {
      type: "courier.delivery_confirmed",
      fulfillmentId: order._id,
      by: actor,
      at,
    },
    { session },
  );
  return { ...order, status: "delivered" };
}
async function applyProvider(store, jobId, result, session) {
  const job = await store.courierJobs.findOne({ _id: jobId }, { session });
  if (!job || job.source !== "external")
    throw new HttpError(404, "COURIER_NOT_FOUND", "Courier booking not found.");
  // Provider status is evidence about a delivery, never evidence of payment.
  const terminal = ["cancelled", "confirmed"].includes(job.status);
  if (terminal) return job;
  const order = await store.fulfillments.findOne(
    { _id: job.orderId },
    { session },
  );
  const change = {
    providerId: result.id || job.providerId || "",
    status: result.status,
    trackingUrl: result.trackingUrl,
    updatedAt: new Date(),
    ...(result.feeMinor === undefined ? {} : { feeMinor: result.feeMinor }),
    proof: result.proof || job.proof || "",
  };
  if (result.status === "not_found" && job.providerId)
    throw new HttpError(
      409,
      "COURIER_STATUS",
      "The provider no longer finds an existing booking. Review it with the courier before assigning another driver.",
    );
  if (
    job.status === "delivered" &&
    ["booked", "in_transit"].includes(result.status)
  )
    change.status = "delivered";
  if (result.status === "delivered")
    change.deliveryPendingReview = order?.status !== "delivered";
  if (
    result.location &&
    order?.status === "dispatched" &&
    Date.now() - Date.parse(result.location.capturedAt) < 120000 &&
    Date.parse(result.location.capturedAt) > Date.now() - 120000 &&
    Date.parse(result.location.capturedAt) < Date.now() + 30000 &&
    (!job.location ||
      Date.parse(result.location.capturedAt) >
        Date.parse(job.location.capturedAt))
  )
    Object.assign(change, {
      location: result.location,
      locationAt: new Date(),
    });
  if (["cancelled", "delivered"].includes(order?.status)) {
    delete change.location;
    change.deliveryPendingReview = false;
  }
  await store.courierJobs.updateOne(
    { _id: job._id },
    {
      $set: change,
      ...(["cancelled", "delivered"].includes(order?.status) ||
      result.status === "cancelled"
        ? { $unset: { driverTokenHash: "", location: "", locationAt: "" } }
        : {}),
    },
    { session },
  );
  return { ...job, ...change };
}
export function registerCourierCallback(app, store, config) {
  app.post(
    "/api/courier/webhook",
    express.raw({ type: "application/json", limit: "16kb" }),
    async (req, res) => {
      const timestamp = req.get("x-courier-timestamp") || "",
        signature = req.get("x-courier-signature") || "";
      if (
        (config.courier?.webhookSecret || "").length < 32 ||
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        !Buffer.isBuffer(req.body) ||
        !/^([a-f0-9]{64})$/i.test(signature)
      )
        throw new HttpError(
          401,
          "COURIER_SIGNATURE",
          "Invalid courier signature.",
        );
      const expected = createHmac("sha256", config.courier.webhookSecret)
        .update(timestamp + ".")
        .update(req.body)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
        throw new HttpError(
          401,
          "COURIER_SIGNATURE",
          "Invalid courier signature.",
        );
      let value;
      try {
        value = JSON.parse(req.body.toString("utf8"));
      } catch {
        throw new HttpError(400, "INVALID_BODY", "Invalid courier event.");
      }
      const event = body(
          z.strictObject({ eventId: id, booking: providerInput }),
          value,
        ),
        fingerprint = hash(req.body);
      if (event.booking.trackingUrl)
        event.booking.trackingUrl = safeCourierUrl(event.booking.trackingUrl);
      const replay = await transaction(store, async (session) => {
        const old = await store.courierWebhookEvents.findOne(
          { _id: event.eventId },
          { session },
        );
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new HttpError(
              409,
              "COURIER_EVENT",
              "This event identifier was reused for a different message.",
            );
          return true;
        }
        const job = await store.courierJobs.findOne(
          { reference: event.booking.reference, source: "external" },
          { session },
        );
        if (!job || job.providerType === "ecourier")
          throw new HttpError(
            404,
            "COURIER_NOT_FOUND",
            "Courier booking not found.",
          );
        await applyProvider(store, job._id, event.booking, session);
        await store.courierWebhookEvents.insertOne(
          {
            _id: event.eventId,
            fingerprint,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * 86400000),
          },
          { session },
        );
        return false;
      });
      res.json({ accepted: true, replay });
    },
  );
}
export function registerCourierGuest(api, store, config, requireId) {
  const limited = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  api.get("/fulfillment/orders/:id/tracking", async (req, res) => {
    const order = await store.fulfillments.findOne({
      _id: requireId(req.params.id),
      ...orderOwner(req, getGuest(req, res, config)),
    });
    if (!order || order.kind !== "delivery")
      throw new HttpError(404, "NOT_FOUND", "Delivery order not found.");
    const job = await store.courierJobs.findOne({ _id: String(order._id) });
    const current =
      order.status === "dispatched" &&
      job &&
      (!job.expiresAt || job.expiresAt > new Date());
    res.json({
      tracking: job
        ? {
            ...jobView(job),
            location: current ? job.location || null : null,
            locationAt: current ? job.locationAt || null : null,
            deliveryCode: current && job.deliveryCode ? job.deliveryCode : null,
          }
        : null,
    });
  });
  const driver = async (req, res, next) => {
    const token = req.get("authorization")?.replace(/^Bearer /, "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || ""))
      throw new HttpError(
        401,
        "DRIVER_ACCESS",
        "Open your current private delivery link.",
      );
    const job = await store.courierJobs.findOne({
      driverTokenHash: hash(token),
      expiresAt: { $gt: new Date() },
      source: "staff",
      trackingRevoked: { $ne: true },
    });
    if (!job)
      throw new HttpError(
        401,
        "DRIVER_ACCESS",
        "This private delivery link expired or was revoked.",
      );
    const order = await store.fulfillments.findOne({
      _id: job.orderId,
      status: "dispatched",
      kind: "delivery",
    });
    if (!order)
      throw new HttpError(
        409,
        "DRIVER_STATE",
        "This order is no longer out for delivery.",
      );
    req.driverJob = job;
    req.deliveryOrder = order;
    next();
  };
  api.get("/courier/driver", driver, async (req, res) => {
    const order = req.deliveryOrder;
    res.json({
      delivery: {
        code: order.code,
        name: order.name,
        phone: order.phone,
        address: order.address,
        driverName: req.driverJob.driverName,
        expiresAt: req.driverJob.expiresAt,
      },
    });
  });
  api.post("/courier/driver/location", limited, driver, async (req, res) => {
    const input = body(position, req.body),
      at = Date.parse(input.capturedAt);
    if (at < Date.now() - 120000 || at > Date.now() + 30000)
      throw new HttpError(400, "LOCATION_TIME", "Share a fresh GPS reading.");
    const job = req.driverJob;
    if (job.location && at <= Date.parse(job.location.capturedAt))
      throw new HttpError(
        409,
        "LOCATION_OLD",
        "A newer GPS reading is already stored.",
      );
    if (job.locationAt && Date.now() - job.locationAt.getTime() < 4000)
      return res.status(202).json({ accepted: false });
    const changed = await store.courierJobs.updateOne(
      {
        _id: job._id,
        driverTokenHash: job.driverTokenHash,
        trackingRevoked: { $ne: true },
        ...(job.locationAt
          ? { locationAt: job.locationAt }
          : { locationAt: { $exists: false } }),
      },
      {
        $set: {
          location: input,
          locationAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    if (!changed.matchedCount)
      throw new HttpError(
        409,
        "DRIVER_ACCESS",
        "The delivery assignment changed.",
      );
    res.json({ accepted: true });
  });
  api.post("/courier/driver/confirm", limited, driver, async (req, res) => {
    const input = body(
      z.strictObject({
        code: z.string().regex(/^\d{6}$/),
        note: z.string().trim().max(160).default(""),
      }),
      req.body,
    );
    const result = await transaction(store, async (session) => {
      const job = await store.courierJobs.findOneAndUpdate(
        {
          _id: req.driverJob._id,
          driverTokenHash: req.driverJob.driverTokenHash,
          trackingRevoked: { $ne: true },
          expiresAt: { $gt: new Date() },
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!job || (job.confirmAttempts || 0) >= 5)
        throw new HttpError(
          403,
          "DELIVERY_CODE_LOCKED",
          "Ask the restaurant to review or reassign this delivery.",
        );
      if (
        !timingSafeEqual(
          Buffer.from(codeHash(config, job._id, input.code), "hex"),
          Buffer.from(job.deliveryCodeHash, "hex"),
        )
      ) {
        await store.courierJobs.updateOne(
          { _id: job._id },
          { $inc: { confirmAttempts: 1 } },
          { session },
        );
        return { invalid: true };
      }
      await completeDelivery(store, job.orderId, "delivery-staff", session);
      await store.courierJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "confirmed",
            confirmedAt: new Date(),
            proof: input.note,
            trackingRevoked: true,
            deliveryPendingReview: false,
          },
          $unset: {
            driverTokenHash: "",
            location: "",
            locationAt: "",
            deliveryCode: "",
            deliveryCodeHash: "",
          },
        },
        { session },
      );
      return { confirmed: true };
    });
    if (result.invalid)
      throw new HttpError(
        400,
        "DELIVERY_CODE",
        "The customer delivery code did not match.",
      );
    res.json(result);
  });
}
export function registerCourierStaff(api, store, config, requireId) {
  api.get("/courier", async (req, res) =>
    res.json({
      configured: providerReady(config),
      providerType: config.courier?.provider || "generic",
      mode:
        config.courier?.provider === "ecourier"
          ? config.courier.ecourier?.mode
          : null,
      providerName:
        config.courier?.provider === "ecourier"
          ? "eCourier"
          : config.courier?.name || "Configured courier",
      jobs: (
        await store.courierJobs
          .find({})
          .sort({ updatedAt: -1 })
          .limit(100)
          .toArray()
      ).map(jobView),
    }),
  );
  api.get("/courier/options", async (req, res) => {
    if (config.courier?.provider !== "ecourier")
      return res.json({ packages: [], cities: [] });
    try {
      res.json(await ecourierProvider(config).options());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        "COURIER_CATALOGUE",
        "The eCourier package and city catalogue could not be confirmed.",
      );
    }
  });
  api.post("/courier/:id/driver", async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: revision,
          name: z.string().trim().min(2).max(80),
          phone: z.string().trim().max(25).default(""),
          reason,
        }),
        req.body,
      ),
      orderId = requireId(req.params.id),
      token = randomToken(),
      code = String(randomInt(100000, 1000000));
    const job = await transaction(store, async (session) => {
      const old = await store.courierJobs.findOne(
        { _id: String(orderId) },
        { session },
      );
      if (old?.source === "external" && active.includes(old.status))
        throw new HttpError(
          409,
          "COURIER_ACTIVE",
          "Confirm the external booking cancellation before assigning a staff driver.",
        );
      const order = await store.fulfillments.findOneAndUpdate(
        {
          _id: orderId,
          kind: "delivery",
          revision: input.expectedRevision,
          status: { $in: ["ready", "dispatched"] },
        },
        {
          $inc: { revision: 1 },
          $set: {
            status: "dispatched",
            courier: { name: input.name, phone: input.phone },
            updatedAt: new Date(),
          },
          $push: {
            history: {
              status: "dispatched",
              by: req.staff.username,
              at: new Date(),
              reason: input.reason,
            },
          },
        },
        { session, returnDocument: "after" },
      );
      if (!order)
        throw new HttpError(
          409,
          "FULFILLMENT_UPDATED",
          "Refresh this ready or dispatched delivery before assigning a driver.",
        );
      const row = {
        _id: String(orderId),
        orderId,
        source: "staff",
        status: "in_transit",
        driverName: input.name,
        driverTokenHash: hash(token),
        deliveryCode: code,
        deliveryCodeHash: codeHash(config, String(orderId), code),
        confirmAttempts: 0,
        expiresAt: new Date(Date.now() + 6 * 3600000),
        trackingRevoked: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await store.courierJobs.replaceOne({ _id: row._id }, row, {
        upsert: true,
        session,
      });
      await store.audit.insertOne(
        {
          type: "courier.driver_assigned",
          fulfillmentId: orderId,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({
      job: jobView(job),
      driverLink:
        config.origin +
        branchPath("/driver", config.branchId) +
        "#token=" +
        token,
    });
  });
  api.post("/courier/:id/book", async (req, res) => {
    if (!providerReady(config))
      throw new HttpError(
        503,
        "COURIER_UNAVAILABLE",
        "Configure the courier adapter URL, token and webhook signing secret first.",
      );
    const input = body(
        z.strictObject({
          expectedRevision: revision,
          requestKey: key,
          native: ecourierInput.optional(),
        }),
        req.body,
      ),
      orderId = requireId(req.params.id),
      restaurant = await restaurantSettings(store);
    const claim = await transaction(store, async (session) => {
      const old = await store.courierJobs.findOne(
        { _id: String(orderId) },
        { session },
      );
      if (
        old?.source === "staff" &&
        !old.trackingRevoked &&
        old.expiresAt > new Date()
      )
        throw new HttpError(
          409,
          "COURIER_ACTIVE",
          "A staff driver already has this delivery. Revoke the assignment first.",
        );
      if (
        old?.source === "external" &&
        !["not_found", "cancelled"].includes(old.status)
      )
        return { replay: true, job: old };
      const order = await store.fulfillments.findOneAndUpdate(
        {
          _id: orderId,
          kind: "delivery",
          revision: input.expectedRevision,
          status: { $in: ["accepted", "preparing", "ready"] },
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!order)
        throw new HttpError(
          409,
          "FULFILLMENT_UPDATED",
          "Book a courier for an unchanged accepted delivery before dispatch.",
        );
      const reference = referenceFor(store, order);
      if (old?.status === "cancelled")
        throw new HttpError(
          409,
          "COURIER_CANCELLED",
          "This provider reference was cancelled. Use a staff driver or resolve rebooking with the courier.",
        );
      const bill = await store.bills.findOne(
        { _id: order.billId },
        { session },
      );
      if (bill && heldMinor(bill))
        throw new HttpError(
          409,
          "PAYMENT_PENDING",
          "Reconcile pending online payments before booking courier cash collection.",
        );
      const row = {
        _id: String(orderId),
        orderId,
        reference,
        requestKey: input.requestKey,
        source: "external",
        providerType: config.courier?.provider || "generic",
        ...(config.courier?.provider === "ecourier"
          ? {
              native: prepareEcourier(
                config,
                order,
                bill,
                bill ? paidMinor(bill) : 0,
                input.native,
                restaurant,
              ),
            }
          : {}),
        status: "submitting",
        createdAt: old?.createdAt || new Date(),
        updatedAt: new Date(),
      };
      await store.courierJobs.replaceOne({ _id: row._id }, row, {
        upsert: true,
        session,
      });
      await store.audit.insertOne(
        {
          type: "courier.booking_requested",
          fulfillmentId: orderId,
          reference,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { job: row, order, bill };
    });
    if (claim.replay) return res.json({ job: jobView(claim.job) });
    const payload = {
      reference: claim.job.reference,
      branchId: store.branchId || "main",
      orderCode: claim.order.code,
      pickup: {
        name: restaurant.name || "Angar Kitchen",
        address: restaurant.address || restaurant.location,
        phone: restaurant.phone || "",
      },
      recipient: {
        name: claim.order.name,
        phone: claim.order.phone,
        address: claim.order.address,
      },
      package: {
        description: "Prepared restaurant food",
        itemCount: claim.order.items.reduce((sum, i) => sum + i.quantity, 0),
      },
      collectionMinor: Math.max(
        0,
        (claim.bill?.totalMinor || 0) -
          (claim.bill ? paidMinor(claim.bill) : 0),
      ),
      currency: "BDT",
      webhookUrl:
        config.origin + branchPath("/api/courier/webhook", config.branchId),
    };
    try {
      const result = await provider(config).book(
        claim.job.reference,
        payload,
        claim.job,
      );
      const job = await transaction(store, (session) =>
        applyProvider(store, claim.job._id, result, session),
      );
      res.status(201).json({ job: jobView(job) });
    } catch (error) {
      await store.courierJobs.updateOne(
        { _id: claim.job._id, status: "submitting" },
        { $set: { status: "unknown", updatedAt: new Date() } },
      );
      if (error instanceof HttpError) throw error;
      res.status(202).json({
        job: jobView(await store.courierJobs.findOne({ _id: claim.job._id })),
        message:
          "The booking result is uncertain. Reconcile its original reference before retrying or assigning another driver.",
      });
    }
  });
  api.post("/courier/:id/reconcile", async (req, res) => {
    body(z.strictObject({}), req.body);
    const job = await store.courierJobs.findOne({
      _id: String(requireId(req.params.id)),
      source: "external",
    });
    if (!job)
      throw new HttpError(
        404,
        "COURIER_NOT_FOUND",
        "External booking not found.",
      );
    try {
      assertConfiguredProvider(config, job);
      const result = await provider(config).status(job.reference, job),
        updated = await transaction(store, (session) =>
          applyProvider(store, job._id, result, session),
        );
      res.json({ job: jobView(updated) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        503,
        "COURIER_RECONCILE",
        "The provider could not confirm the original booking. Its uncertain state is preserved.",
      );
    }
  });
  api.post("/courier/:id/cancel", async (req, res) => {
    const input = body(z.strictObject({ reason }), req.body),
      jobId = String(requireId(req.params.id));
    const before = await store.courierJobs.findOne({ _id: jobId });
    if (before?.source === "external") assertConfiguredProvider(config, before);
    if (
      before?.providerType === "ecourier" &&
      ["submitting", "unknown", "cancel_unknown"].includes(before.status)
    )
      throw new HttpError(
        409,
        "COURIER_NOT_CONFIRMED",
        "Reconcile the existing eCourier operation before requesting cancellation again.",
      );
    const job = await store.courierJobs.findOneAndUpdate(
      {
        _id: jobId,
        status:
          before?.providerType === "ecourier"
            ? { $in: ["booked", "in_transit", "delivered"] }
            : { $nin: ["confirmed", "cancelled"] },
      },
      {
        $set: {
          trackingRevoked: true,
          updatedAt: new Date(),
          ...(before?.providerType === "ecourier"
            ? { status: "cancel_unknown" }
            : {}),
        },
        $unset: {
          driverTokenHash: "",
          location: "",
          locationAt: "",
          deliveryCode: "",
          deliveryCodeHash: "",
        },
      },
      { returnDocument: "after" },
    );
    if (!job)
      throw new HttpError(
        409,
        "COURIER_STATE",
        "This assignment already ended.",
      );
    if (job.source === "staff") {
      await store.courierJobs.updateOne(
        { _id: jobId },
        { $set: { status: "cancelled" } },
      );
    } else {
      await store.courierJobs.updateOne(
        { _id: jobId },
        { $set: { status: "cancel_unknown" } },
      );
      try {
        const result = await provider(config).cancel(
          job.reference,
          job,
          input.reason,
        );
        if (result.status !== "cancelled")
          throw new Error("Cancellation unconfirmed");
        await transaction(store, (session) =>
          applyProvider(store, jobId, result, session),
        );
      } catch {
        throw new HttpError(
          409,
          "COURIER_CANCEL_UNKNOWN",
          "Courier cancellation is not confirmed. Reconcile before another assignment or cancelling the food order.",
        );
      }
    }
    await store.audit.insertOne({
      type: "courier.assignment_cancelled",
      fulfillmentId: job.orderId,
      by: req.staff.username,
      reason: input.reason,
      at: new Date(),
    });
    res.json({ job: jobView(await store.courierJobs.findOne({ _id: jobId })) });
  });
  api.post("/courier/:id/confirm-delivery", async (req, res) => {
    const input = body(z.strictObject({ reason }), req.body),
      orderId = requireId(req.params.id);
    await transaction(store, async (session) => {
      await completeDelivery(store, orderId, req.staff.username, session);
      await store.courierJobs.updateOne(
        { _id: String(orderId) },
        {
          $set: {
            status: "confirmed",
            confirmedAt: new Date(),
            proof: input.reason,
            trackingRevoked: true,
            deliveryPendingReview: false,
          },
          $unset: {
            driverTokenHash: "",
            location: "",
            locationAt: "",
            deliveryCode: "",
            deliveryCodeHash: "",
          },
        },
        { session },
      );
    });
    res.json({ confirmed: true });
  });
  api.post("/courier/:id/review-cancellation", async (req, res) => {
    if (req.staff.role !== "admin")
      throw new HttpError(
        403,
        "FORBIDDEN",
        "An administrator reviews uncertain native courier assignments.",
      );
    const input = body(
        z.strictObject({
          currentPassword: z.string().min(1).max(128),
          reason,
          confirmedWithProvider: z.literal(true),
          expectedUpdatedAt: z.iso.datetime(),
        }),
        req.body,
      ),
      jobId = String(requireId(req.params.id)),
      actor = await store.staff.findOne({ _id: req.staff._id, active: true });
    if (
      !actor ||
      !(await passwordMatches(input.currentPassword, actor.passwordHash))
    )
      throw new HttpError(
        403,
        "PASSWORD_CHECK",
        "Administrator password did not match.",
      );
    const job = await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "courier.manage", session);
      const current = await store.courierJobs.findOne(
        {
          _id: jobId,
          source: "external",
          providerType: "ecourier",
          status: { $in: ["unknown", "cancel_unknown"] },
          updatedAt: new Date(input.expectedUpdatedAt),
        },
        { session },
      );
      if (!current)
        throw new HttpError(
          409,
          "COURIER_UPDATED",
          "Refresh an uncertain native booking before recording the provider confirmation.",
        );
      const updated = {
        status: "cancelled",
        trackingRevoked: true,
        deliveryPendingReview: false,
        updatedAt: new Date(),
        providerReview: {
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
      };
      await store.courierJobs.updateOne(
        { _id: jobId },
        {
          $set: updated,
          $unset: { driverTokenHash: "", location: "", locationAt: "" },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "courier.provider_cancellation_reviewed",
          fulfillmentId: current.orderId,
          reference: current.reference,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return { ...current, ...updated };
    });
    res.json({ job: jobView(job) });
  });
}
export async function guardCourierTransition(store, row, action, session) {
  if (!["cancel", "deliver"].includes(action)) return;
  const job = await store.courierJobs.findOne(
    { _id: String(row._id) },
    { session },
  );
  if (!job) return;
  if (
    action === "cancel" &&
    job.source === "external" &&
    active.includes(job.status)
  )
    throw new HttpError(
      409,
      "COURIER_ACTIVE",
      "Confirm courier cancellation before cancelling the food order.",
    );
  await store.courierJobs.updateOne(
    { _id: job._id },
    {
      $set: {
        trackingRevoked: true,
        ...(action === "deliver"
          ? {
              status: "confirmed",
              confirmedAt: new Date(),
              deliveryPendingReview: false,
            }
          : { status: "cancelled" }),
      },
      $unset: {
        driverTokenHash: "",
        location: "",
        locationAt: "",
        deliveryCode: "",
        deliveryCodeHash: "",
      },
    },
    { session },
  );
}
export async function expireCourierTracking(store) {
  await store.courierJobs.updateMany(
    { expiresAt: { $lte: new Date() }, trackingRevoked: { $ne: true } },
    {
      $set: { trackingRevoked: true },
      $unset: {
        driverTokenHash: "",
        location: "",
        locationAt: "",
        deliveryCode: "",
        deliveryCodeHash: "",
      },
    },
  );
  await store.courierJobs.updateMany(
    { locationAt: { $lt: new Date(Date.now() - 24 * 3600000) } },
    { $unset: { location: "", locationAt: "" } },
  );
}
function assertConfiguredProvider(config, job) {
  if (
    (job.providerType || "generic") !== (config.courier?.provider || "generic")
  )
    throw new HttpError(
      409,
      "COURIER_PROVIDER_CHANGED",
      "Restore the original courier provider to reconcile or cancel this booking.",
    );
}
export async function pollNativeCourier(store, config) {
  if (config.courier?.provider !== "ecourier" || !ecourierReady(config)) return;
  for (let i = 0; i < 5; i++) {
    const job = await store.courierJobs.findOneAndUpdate(
      {
        source: "external",
        providerType: "ecourier",
        status: { $in: ["booked", "in_transit", "unknown"] },
        $or: [
          { nextPollAt: { $lte: new Date() } },
          { nextPollAt: { $exists: false } },
        ],
      },
      { $set: { nextPollAt: new Date(Date.now() + 60000) } },
      { sort: { updatedAt: 1 }, returnDocument: "after" },
    );
    if (!job) break;
    try {
      const result = await provider(config).status(job.reference, job);
      await transaction(store, (session) =>
        applyProvider(store, job._id, result, session),
      );
      await store.courierJobs.updateOne(
        { _id: job._id },
        { $unset: { pollNeedsReview: "" } },
      );
    } catch (error) {
      await store.courierJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            pollNeedsReview: true,
            pollCode:
              error instanceof HttpError ? error.code : "COURIER_UNAVAILABLE",
          },
        },
      );
    }
  }
}
