import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key, password } from "./support.js";
import { ecourierProvider } from "../server/courier-ecourier.js";
import { pollNativeCourier } from "../server/courier.js";
const courier = {
  provider: "ecourier",
  ecourier: {
    mode: "sandbox",
    apiKey: "test-key",
    apiSecret: "test-secret",
    userId: "test-merchant",
  },
};
const native = {
  city: "Dhaka",
  thana: "Badda",
  area: "Badda",
  zip: "1212",
  address: "House 12 Road 4",
  packageCode: "#TEST",
  foodServiceConfirmed: true,
};
test("an uncertain native assignment requires administrator review and provider confirmation before manual release", async (t) => {
  const f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async () => {
        throw new Error("lost booking acknowledgement");
      },
    }),
    { order } = await delivery(f);
  const job = ok(await booking(f, order), 202).job,
    request = {
      currentPassword: password,
      reason: "Provider support ticket confirms no shipment exists",
      confirmedWithProvider: true,
      expectedUpdatedAt: job.updatedAt,
    },
    url = "/api/staff/courier/" + order._id + "/review-cancellation";
  error(await post(f.staff.waiter, url, request), 403, "FORBIDDEN");
  error(
    await post(f.staff.admin, url, { ...request, currentPassword: "wrong" }),
    403,
    "PASSWORD_CHECK",
  );
  error(
    await post(f.staff.admin, url, {
      ...request,
      confirmedWithProvider: false,
    }),
    400,
    "INVALID_INPUT",
  );
  assert.equal(
    ok(await post(f.staff.admin, url, request)).job.status,
    "cancelled",
  );
  error(await post(f.staff.admin, url, request), 409, "COURIER_UPDATED");
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: order._id })).status,
    "ready",
  );
});
test("concurrent native cancellation posts once and an explicit success releases the external assignment", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async (input) => {
        if (input.path === "/order-place")
          return { response_code: 200, errors: [], ID: "ECR777" };
        if (input.path === "/cancel-order") {
          calls++;
          return { success: "true" };
        }
        throw new Error("Unexpected call");
      },
    }),
    { order } = await delivery(f);
  ok(await booking(f, order), 201);
  const cancel = () =>
      post(f.staff.admin, "/api/staff/courier/" + order._id + "/cancel", {
        reason: "Merchant confirmed cancellation",
      }),
    results = await Promise.all([cancel(), cancel()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(calls, 1);
  assert.equal(
    (await f.store.courierJobs.findOne({ _id: String(order._id) })).status,
    "cancelled",
  );
});
async function delivery(f, amount = 12300) {
  const bill = {
      _id: new ObjectId(),
      status: "finalized",
      totalMinor: amount,
      payments: [],
      revision: 0,
    },
    order = {
      _id: new ObjectId(),
      kind: "delivery",
      billId: bill._id,
      code: "DL-TEST",
      status: "ready",
      name: "Native test customer",
      phone: "+8801700000000",
      address: { line: "House 12 Road 4", area: "Badda", note: "" },
      items: [{ quantity: 1 }],
      revision: 0,
      history: [],
    };
  await f.store.bills.insertOne(bill);
  await f.store.fulfillments.insertOne(order);
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    { $set: { address: "Test pickup address" } },
    { upsert: true },
  );
  return { order, bill };
}
const booking = (f, order, extra = {}) =>
  post(f.staff.admin, "/api/staff/courier/" + order._id + "/book", {
    expectedRevision: order.revision,
    requestKey: key(),
    native,
    ...extra,
  });
test("native eCourier booking uses documented authentication and field names, whole-taka COD and a stable 20-character product id", async (t) => {
  const calls = [],
    f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async (input) => {
        calls.push(input);
        return { errors: [], response_code: 200, ID: "ECR123456" };
      },
    }),
    { order } = await delivery(f),
    created = ok(await booking(f, order), 201);
  assert.equal(created.job.providerType, "ecourier");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://staging.ecourier.com.bd/api/order-place");
  assert.equal(call.headers["API-SECRET"], "test-secret");
  assert.equal(call.payload.product_price, 123);
  assert.equal(call.payload.payment_method, "COD");
  assert.equal(call.payload.recipient_mobile, "01700000000");
  assert.equal(call.payload.product_id.length, 20);
  assert.equal(call.payload.recipient_zip, "1212");
  assert.equal("native" in created.job, false);
  ok(await booking(f, order));
  assert.equal(calls.length, 1);
  assert.equal(await f.store.courierJobs.countDocuments({}), 1);
});
test("invalid native fields and fractional COD reject before claiming a booking or contacting the courier", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async () => {
        calls++;
        throw new Error("unexpected call");
      },
    }),
    { order } = await delivery(f, 12345);
  error(await booking(f, order), 409, "ECOURIER_COD_PRECISION");
  assert.equal(calls, 0);
  assert.equal(await f.store.courierJobs.countDocuments({}), 0);
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: order._id })).revision,
    0,
  );
  error(
    await booking(f, order, { native: { ...native, address: "X".repeat(41) } }),
    400,
    "INVALID_INPUT",
  );
  error(
    await booking(f, order, {
      native: { ...native, foodServiceConfirmed: false },
    }),
    400,
    "INVALID_INPUT",
  );
});
test("lost native booking acknowledgements preserve uncertainty; empty or ambiguous tracking never permits duplicate bookings", async (t) => {
  let bookCalls = 0,
    mode = "empty",
    productId;
  const f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async (input) => {
        if (input.path === "/order-place") {
          bookCalls++;
          productId = input.payload.product_id;
          throw new Error("Acknowledgement lost");
        }
        if (input.path === "/track")
          return {
            response_code: 200,
            query_data:
              mode === "empty"
                ? "No Data Found"
                : Array.from({ length: mode === "ambiguous" ? 2 : 1 }, () => ({
                    REFID: "ECR123",
                    product_id: productId,
                    status: [["Initiated", "", "2026-01-01"]],
                  })),
          };
        throw new Error("Unexpected path");
      },
    }),
    { order } = await delivery(f);
  assert.equal(ok(await booking(f, order), 202).job.status, "unknown");
  const reconcile = () =>
    post(f.staff.admin, "/api/staff/courier/" + order._id + "/reconcile");
  error(await reconcile(), 409, "COURIER_NOT_CONFIRMED");
  ok(await booking(f, order));
  assert.equal(bookCalls, 1);
  mode = "ambiguous";
  error(await reconcile(), 409, "COURIER_AMBIGUOUS");
  mode = "found";
  assert.equal(ok(await reconcile()).job.providerId, "ECR123");
  assert.equal(bookCalls, 1);
});
test("native tracking delivery remains separate from bill payment, rider GPS and restaurant handover confirmation", async (t) => {
  let productId;
  const f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async (input) => {
        if (input.path === "/order-place") {
          productId = input.payload.product_id;
          return { response_code: 200, errors: [], ID: "ECR999" };
        }
        if (input.path === "/track")
          return {
            response_code: 200,
            query_data: [
              {
                REFID: "ECR999",
                product_id: productId,
                status: [["Delivered", "", "2026-01-01"]],
                shipping_price: "60.50",
                lat: 23.7,
                lng: 90.4,
              },
            ],
          };
        throw new Error("Unexpected request");
      },
    }),
    { order, bill } = await delivery(f);
  ok(await booking(f, order), 201);
  await f.store.fulfillments.updateOne(
    { _id: order._id },
    { $set: { status: "dispatched" } },
  );
  await pollNativeCourier(f.store, f.config);
  const job = ok(await f.staff.admin("/api/staff/courier")).jobs[0];
  assert.equal(job.status, "delivered");
  assert.equal(job.deliveryPendingReview, true);
  assert.equal(job.location, null);
  assert.equal(job.feeMinor, 6050);
  assert.deepEqual(
    (await f.store.bills.findOne({ _id: bill._id })).payments,
    [],
  );
  assert.equal(
    (await f.store.fulfillments.findOne({ _id: order._id })).status,
    "dispatched",
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/courier/" + order._id + "/confirm-delivery",
      { reason: "Provider says delivered" },
    ),
    409,
    "PAYMENT_REQUIRED",
  );
});
test("native cancellation requires explicit confirmation, preserves uncertain writes and remains bound to the original merchant", async (t) => {
  let cancelCalls = 0;
  const f = await fixture(t, {
      courier: structuredClone(courier),
      ecourierTransport: async (input) => {
        if (input.path === "/order-place")
          return { response_code: 200, errors: [], ID: "ECR888" };
        if (input.path === "/cancel-order") {
          cancelCalls++;
          assert.equal(input.payload.tracking, "ECR888");
          return { success: "false" };
        }
        throw new Error("Unexpected path");
      },
    }),
    { order } = await delivery(f);
  ok(await booking(f, order), 201);
  error(
    await post(f.staff.admin, "/api/staff/courier/" + order._id + "/cancel", {
      reason: "Booking no longer needed",
    }),
    409,
    "COURIER_CANCEL_UNKNOWN",
  );
  error(
    await post(f.staff.admin, "/api/staff/courier/" + order._id + "/cancel", {
      reason: "Retry uncertain cancellation",
    }),
    409,
    "COURIER_NOT_CONFIRMED",
  );
  assert.equal(cancelCalls, 1);
  f.config.courier.ecourier.userId = "another-merchant";
  error(
    await post(f.staff.admin, "/api/staff/courier/" + order._id + "/reconcile"),
    409,
    "COURIER_ACCOUNT",
  );
});
test("native package and city lookup exposes only bounded public service fields and has no adapter webhook dependency", async () => {
  const calls = [],
    config = {
      courier,
      ecourierTransport: async (input) => {
        calls.push(input);
        return input.path === "/packages"
          ? [
              {
                package_name: "Test",
                package_code: "#TEST",
                shipping_charge: "60",
                weight: "500g",
                delivery_time: "Same day",
                coverage: "Dhaka",
                secret: "private",
              },
            ]
          : [{ name: "Dhaka", value: "Dhaka" }];
      },
    };
  const data = await ecourierProvider(config).options();
  assert.equal(data.packages[0].package_code, "#TEST");
  assert.equal("secret" in data.packages[0], false);
  assert.deepEqual(calls.map((c) => c.path).sort(), [
    "/city-list",
    "/packages",
  ]);
});
