import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key } from "./support.js";
import { fulfillmentDefaults } from "../server/fulfillment.js";
const settings = {
  ...fulfillmentDefaults,
  pickupEnabled: true,
  deliveryEnabled: true,
  zones: [
    {
      id: "local",
      name: "Local delivery",
      feeMinor: 5000,
      minimumFoodMinor: 0,
      estimatedMinutes: 30,
    },
  ],
  expectedRevision: 0,
  reason: "Enable local delivery",
};
async function delivery(f) {
  ok(await post(f.staff.admin, "/api/staff/fulfillment/settings", settings));
  const guest = f.browser(),
    input = {
      kind: "delivery",
      zoneId: "local",
      scheduledAt:
        new Date(Date.now() + 86400000 + 6 * 3600000)
          .toISOString()
          .slice(0, 10) + "T12:00:00+06:00",
      items: [{ dishId: "mutton-kacchi", quantity: 1, expectedPrice: 420 }],
      couponCode: "",
      loyaltyPoints: 0,
    };
  const quote = ok(await post(guest, "/api/fulfillment/quote", input)).quote;
  let order = ok(
    await post(guest, "/api/fulfillment/orders", {
      ...input,
      quoteHash: quote.quoteHash,
      name: "Delivery guest",
      phone: "01700000000",
      address: {
        line: "House 12 Road 4",
        area: "Local",
        note: "Call when outside",
      },
      note: "",
      requestKey: key(),
    }),
    201,
  ).order;
  for (const action of ["accept", "prepare", "ready"])
    order = ok(
      await post(
        f.staff.admin,
        "/api/staff/fulfillment/orders/" + order.id + "/action",
        { action, expectedRevision: order.revision },
      ),
    ).order;
  return { guest, order };
}
const gps = () => ({
  lat: 23.75,
  lng: 90.37,
  accuracy: 12,
  capturedAt: new Date().toISOString(),
});
test("staff GPS links are private, fresh, replaceable and require both recipient code and full verified payment", async (t) => {
  const f = await fixture(t),
    { guest, order } = await delivery(f),
    assigned = ok(
      await post(f.staff.waiter, "/api/staff/courier/" + order.id + "/driver", {
        expectedRevision: order.revision,
        name: "Delivery staff",
        phone: "01700000001",
        reason: "Staff accepted this delivery",
      }),
      201,
    ),
    token = new URLSearchParams(new URL(assigned.driverLink).hash.slice(1)).get(
      "token",
    ),
    headers = { Authorization: "Bearer " + token },
    driver = f.browser();
  const detail = ok(await driver("/api/courier/driver", { headers }));
  assert.equal(detail.delivery.address.line, "House 12 Road 4");
  assert.equal("deliveryCode" in detail.delivery, false);
  const point = gps();
  ok(await post(driver, "/api/courier/driver/location", point, headers));
  const tracking = ok(
    await guest("/api/fulfillment/orders/" + order.id + "/tracking"),
  ).tracking;
  assert.equal(tracking.location.lat, 23.75);
  assert.match(tracking.deliveryCode, /^\d{6}$/);
  error(
    await f.browser()("/api/fulfillment/orders/" + order.id + "/tracking"),
    404,
    "NOT_FOUND",
  );
  error(
    await post(
      driver,
      "/api/courier/driver/location",
      { ...point, capturedAt: new Date(Date.now() - 300000).toISOString() },
      headers,
    ),
    400,
    "LOCATION_TIME",
  );
  error(
    await post(
      driver,
      "/api/courier/driver/confirm",
      { code: "000000" },
      headers,
    ),
    400,
    "DELIVERY_CODE",
  );
  error(
    await post(
      driver,
      "/api/courier/driver/confirm",
      { code: tracking.deliveryCode },
      headers,
    ),
    409,
    "PAYMENT_REQUIRED",
  );
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: new ObjectId(order.id) }))
      .status,
    "dispatched",
  );
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + order.bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
  );
  ok(
    await post(
      driver,
      "/api/courier/driver/confirm",
      { code: tracking.deliveryCode, note: "Food handed to recipient" },
      headers,
    ),
  );
  error(await driver("/api/courier/driver", { headers }), 401, "DRIVER_ACCESS");
  const finished = ok(
    await guest("/api/fulfillment/orders/" + order.id + "/tracking"),
  ).tracking;
  assert.equal(finished.status, "confirmed");
  assert.equal(finished.location, null);
  assert.equal(finished.deliveryCode, null);
  assert.equal(
    await f.store.audit.countDocuments({ type: "courier.delivery_confirmed" }),
    1,
  );
});
test("reassignment revokes old GPS capability and recipient code guesses lock after five failures", async (t) => {
  const f = await fixture(t),
    { order } = await delivery(f),
    assign = (revision) =>
      post(f.staff.admin, "/api/staff/courier/" + order.id + "/driver", {
        expectedRevision: revision,
        name: "Assigned staff",
        reason: "Assignment reviewed",
      }),
    a = ok(await assign(order.revision), 201),
    oldToken = new URLSearchParams(new URL(a.driverLink).hash.slice(1)).get(
      "token",
    ),
    row = await f.store.fulfillments.findOne({ _id: new ObjectId(order.id) }),
    b = ok(await assign(row.revision), 201),
    token = new URLSearchParams(new URL(b.driverLink).hash.slice(1)).get(
      "token",
    );
  error(
    await f.browser()("/api/courier/driver", {
      headers: { Authorization: "Bearer " + oldToken },
    }),
    401,
    "DRIVER_ACCESS",
  );
  const driver = f.browser(),
    headers = { Authorization: "Bearer " + token };
  for (let i = 0; i < 5; i++)
    error(
      await post(
        driver,
        "/api/courier/driver/confirm",
        { code: "000000" },
        headers,
      ),
      400,
      "DELIVERY_CODE",
    );
  error(
    await post(
      driver,
      "/api/courier/driver/confirm",
      { code: "000000" },
      headers,
    ),
    403,
    "DELIVERY_CODE_LOCKED",
  );
});
test("external courier booking preserves uncertain references, verifies webhooks, and never treats delivery as payment", async (t) => {
  const calls = [],
    bookings = new Map();
  let lost = true;
  const courier = {
    name: "Controlled test courier",
    url: "https://courier.example.test/api",
    token: "test-only-token",
    webhookSecret: "test-only-courier-signing-secret-32-bytes",
  };
  const f = await fixture(t, {
      courier,
      courierTransport: async ({ method, reference, payload }) => {
        calls.push({ method, reference, payload });
        if (method === "POST") {
          const value = {
            id: "CX-1",
            reference,
            status: "booked",
            trackingUrl: "https://courier.example.test/track/CX-1",
            feeMinor: 6000,
          };
          bookings.set(reference, value);
          if (lost) {
            lost = false;
            throw new Error("Controlled response lost after booking");
          }
          return value;
        }
        if (method === "DELETE") {
          const value = { ...bookings.get(reference), status: "cancelled" };
          bookings.set(reference, value);
          return value;
        }
        return bookings.get(reference) || { reference, status: "not_found" };
      },
    }),
    { guest, order } = await delivery(f);
  const booked = ok(
    await post(f.staff.admin, "/api/staff/courier/" + order.id + "/book", {
      expectedRevision: order.revision,
      requestKey: key(),
    }),
    202,
  ).job;
  assert.equal(booked.status, "unknown");
  assert.equal(calls[0].payload.recipient.address.line, "House 12 Road 4");
  assert.equal(calls[0].payload.collectionMinor, 47000);
  ok(
    await post(f.staff.admin, "/api/staff/courier/" + order.id + "/book", {
      expectedRevision: order.revision,
      requestKey: key(),
    }),
  );
  assert.equal(calls.filter((row) => row.method === "POST").length, 1);
  const reconciled = ok(
    await post(f.staff.waiter, "/api/staff/courier/" + order.id + "/reconcile"),
  ).job;
  assert.equal(reconciled.status, "booked");
  assert.equal(reconciled.reference, booked.reference);
  const current = ok(await guest("/api/fulfillment/orders")).orders[0];
  ok(
    await post(
      f.staff.waiter,
      "/api/staff/fulfillment/orders/" + order.id + "/action",
      {
        action: "dispatch",
        expectedRevision: current.revision,
        courierName: "Controlled test courier",
      },
    ),
  );
  const event = {
      eventId: "event-delivered-1",
      booking: {
        id: "CX-1",
        reference: booked.reference,
        status: "delivered",
        trackingUrl: "",
        proof: "Provider reports recipient handover",
      },
    },
    raw = JSON.stringify(event),
    timestamp = String(Math.floor(Date.now() / 1000)),
    signature = createHmac("sha256", courier.webhookSecret)
      .update(timestamp + "." + raw)
      .digest("hex"),
    headers = {
      "Content-Type": "application/json",
      "X-Courier-Timestamp": timestamp,
      "X-Courier-Signature": signature,
    };
  error(
    await f.browser()("/api/courier/webhook", {
      method: "POST",
      raw,
      headers: { ...headers, "X-Courier-Signature": "0".repeat(64) },
    }),
    401,
    "COURIER_SIGNATURE",
  );

  const originalSecret = courier.webhookSecret;
  courier.webhookSecret = "short";
  const weakSignature = createHmac("sha256", "short")
    .update(timestamp + "." + raw)
    .digest("hex");
  error(
    await f.browser()("/api/courier/webhook", {
      method: "POST",
      raw,
      headers: { ...headers, "X-Courier-Signature": weakSignature },
    }),
    401,
    "COURIER_SIGNATURE",
  );
  courier.webhookSecret = originalSecret;
  const webhook = f.browser();
  ok(await webhook("/api/courier/webhook", { method: "POST", raw, headers }));
  assert.equal(
    ok(await webhook("/api/courier/webhook", { method: "POST", raw, headers }))
      .replay,
    true,
  );
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: new ObjectId(order.id) }))
      .status,
    "dispatched",
  );
  assert.equal(
    (await f.store.bills.findOne({ _id: new ObjectId(order.bill.id) })).status,
    "finalized",
  );
  assert.equal(
    ok(await guest("/api/fulfillment/orders/" + order.id + "/tracking"))
      .tracking.deliveryPendingReview,
    true,
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/courier/" + order.id + "/confirm-delivery",
      { reason: "Physical delivery verified" },
    ),
    409,
    "PAYMENT_REQUIRED",
  );
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + order.bill.id + "/pay", {
      method: "cash",
      verified: true,
      requestKey: key(),
    }),
  );
  ok(
    await post(
      f.staff.waiter,
      "/api/staff/courier/" + order.id + "/confirm-delivery",
      { reason: "Recipient handover confirmed and counter paid" },
    ),
  );
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: new ObjectId(order.id) }))
      .status,
    "delivered",
  );
});
test("manual dispatch still works when external courier is unconfigured and active external jobs block unsafe cancellation", async (t) => {
  const f = await fixture(t),
    { guest, order } = await delivery(f);
  error(
    await post(f.staff.waiter, "/api/staff/courier/" + order.id + "/book", {
      expectedRevision: order.revision,
      requestKey: key(),
    }),
    503,
    "COURIER_UNAVAILABLE",
  );
  ok(
    await post(
      f.staff.waiter,
      "/api/staff/fulfillment/orders/" + order.id + "/action",
      {
        action: "dispatch",
        expectedRevision: order.revision,
        courierName: "Manual driver",
        courierPhone: "01700000001",
      },
    ),
  );
  assert.equal(
    ok(await guest("/api/fulfillment/orders")).orders[0].status,
    "dispatched",
  );
  await f.store.courierJobs.insertOne({
    _id: order.id,
    orderId: new ObjectId(order.id),
    source: "external",
    status: "unknown",
    reference: "test-unknown",
  });
  const row = await f.store.fulfillments.findOne({
    _id: new ObjectId(order.id),
  });
  error(
    await post(
      f.staff.admin,
      "/api/staff/fulfillment/orders/" + order.id + "/action",
      {
        action: "cancel",
        expectedRevision: row.revision,
        reason: "Meal cancellation requested",
      },
    ),
    409,
    "COURIER_ACTIVE",
  );
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: row._id })).status,
    "dispatched",
  );
});
