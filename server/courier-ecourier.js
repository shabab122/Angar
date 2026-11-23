import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
const text = z.string().trim().min(1).max(40);
export const ecourierInput = z.strictObject({
  city: text,
  thana: text,
  area: text,
  zip: z
    .string()
    .trim()
    .regex(/^\d{4}$/),
  address: text,
  packageCode: z.string().trim().min(1).max(60),
  foodServiceConfirmed: z.literal(true),
});
export const ecourierReady = (config) =>
  Boolean(
    ["sandbox", "live"].includes(config.courier?.ecourier?.mode) &&
    config.courier.ecourier.apiKey &&
    config.courier.ecourier.apiSecret &&
    config.courier.ecourier.userId,
  );
export const ecourierAccount = (config) =>
  hash(
    "ecourier:" +
      config.courier?.ecourier?.mode +
      ":" +
      config.courier?.ecourier?.userId,
  );
export function prepareEcourier(config, order, bill, paid, input, restaurant) {
  if (!ecourierReady(config))
    throw new HttpError(
      503,
      "COURIER_UNAVAILABLE",
      "Configure the eCourier merchant credentials first.",
    );
  const native = body(ecourierInput, input),
    collection = Math.max(0, (bill?.totalMinor || 0) - paid);
  if (!bill || !Number.isSafeInteger(collection) || collection % 100)
    throw new HttpError(
      409,
      "ECOURIER_COD_PRECISION",
      "eCourier accepts whole-taka collection amounts. Reconcile the bill balance before booking; amounts are never rounded.",
    );
  const mobile = String(order.phone).replace(/^\+?88(?=01)/, "");
  if (!/^01\d{9}$/.test(mobile))
    throw new HttpError(
      400,
      "ECOURIER_PHONE",
      "eCourier requires an 11-digit Bangladesh mobile number.",
    );
  const pickup = restaurant.address || restaurant.location || "";
  if (!pickup || pickup.length > 255)
    throw new HttpError(
      409,
      "ECOURIER_PICKUP",
      "Set a complete restaurant pickup address within 255 characters first.",
    );
  const productId =
    "A" +
    BigInt("0x" + String(order._id))
      .toString(36)
      .padStart(19, "0");
  return {
    account: ecourierAccount(config),
    productId,
    payload: {
      recipient_name: order.name,
      recipient_mobile: mobile,
      recipient_city: native.city,
      recipient_thana: native.thana,
      recipient_area: native.area,
      recipient_address: native.address,
      recipient_zip: native.zip,
      package_code: native.packageCode,
      product_id: productId,
      product_price: collection / 100,
      payment_method: collection ? "COD" : "POS",
      pick_address: pickup,
      number_of_item: order.items.reduce((s, i) => s + i.quantity, 0),
      comments:
        "Prepared restaurant food. Service and delivery timing confirmed by merchant.",
      parcel_type: "BOX",
      sending_type: 1,
      is_ipay: 0,
    },
  };
}
const baseFor = (config) =>
  config.courier.ecourier.mode === "live"
    ? "https://backoffice.ecourier.com.bd/api"
    : "https://staging.ecourier.com.bd/api";
export function ecourierProvider(config) {
  async function request(path, payload) {
    if (!ecourierReady(config))
      throw new HttpError(
        503,
        "COURIER_UNAVAILABLE",
        "Configure eCourier API-KEY, API-SECRET and USER-ID first.",
      );
    const credentials = config.courier.ecourier,
      headers = {
        "API-KEY": credentials.apiKey,
        "API-SECRET": credentials.apiSecret,
        "USER-ID": credentials.userId,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
    if (config.ecourierTransport)
      return config.ecourierTransport({
        url: baseFor(config) + path,
        method: "POST",
        path,
        headers,
        payload,
      });
    const response = await fetch(baseFor(config) + path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    let size = 0,
      parts = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error("eCourier response exceeds limit");
      parts.push(Buffer.from(chunk));
    }
    if (!response.ok) throw new Error("eCourier did not confirm the request");
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }
  const checkJob = (job) => {
    if (!job?.native || job.native.account !== ecourierAccount(config))
      throw new HttpError(
        409,
        "COURIER_ACCOUNT",
        "Restore the original eCourier mode and merchant USER-ID before reconciling this booking.",
      );
  };
  const normalized = (reference, providerId, status, extra = {}) => ({
    reference,
    id: providerId,
    status,
    trackingUrl: "",
    proof: "",
    ...extra,
  });
  return {
    async book(reference, payload, job) {
      checkJob(job);
      const result = await request("/order-place", job.native.payload);
      if (
        result?.response_code !== 200 ||
        !Array.isArray(result.errors) ||
        result.errors.length ||
        !/^ECR[A-Za-z0-9]{1,60}$/.test(result.ID || "")
      )
        throw new Error("eCourier booking is unconfirmed");
      return normalized(reference, result.ID, "booked");
    },
    async status(reference, job) {
      checkJob(job);
      const result = await request(
        "/track",
        job.providerId
          ? { ecr: job.providerId }
          : { product_id: job.native.productId },
      );
      if (
        result?.response_code !== 200 ||
        !Array.isArray(result.query_data) ||
        result.query_data.length > 50
      )
        throw new HttpError(
          409,
          "COURIER_NOT_CONFIRMED",
          "eCourier has not confirmed this reference. Keep its uncertain state and check with the merchant support team; do not create another booking.",
        );
      const candidates = result.query_data.filter((row) =>
        job.providerId
          ? row.REFID === job.providerId
          : row.product_id === job.native.productId,
      );
      if (candidates.length !== 1)
        throw new HttpError(
          409,
          "COURIER_AMBIGUOUS",
          "The eCourier reference is missing or ambiguous. Review it with the courier.",
        );
      const row = candidates[0];
      if (
        !/^ECR[A-Za-z0-9]{1,60}$/.test(row.REFID || "") ||
        (row.product_id && row.product_id !== job.native.productId)
      )
        throw new Error("eCourier reference mismatch");
      const latest = String(row.status?.[0]?.[0] || "")
          .trim()
          .toLowerCase(),
        status = {
          initiated: "booked",
          "initiated api": "booked",
          "picked up": "in_transit",
          "in source branch": "in_transit",
          "in transit": "in_transit",
          "in destination branch": "in_transit",
          "on the way to delivery": "in_transit",
          delivered: "delivered",
        }[latest];
      if (!status)
        throw new HttpError(
          409,
          "COURIER_STATUS_REVIEW",
          "This eCourier status needs operator review. No delivery or payment was assumed.",
        );
      const fee = String(row.shipping_price ?? "");
      const extra = /^\d{1,6}(?:\.\d{1,2})?$/.test(fee)
        ? { feeMinor: Math.round(Number(fee) * 100) }
        : {};
      return normalized(reference, row.REFID, status, {
        ...extra,
        proof:
          latest === "delivered"
            ? "eCourier reported delivery; restaurant review required."
            : "",
      });
    },
    async cancel(reference, job, reason) {
      checkJob(job);
      if (!job.providerId)
        throw new HttpError(
          409,
          "COURIER_NOT_CONFIRMED",
          "Reconcile the eCourier booking ID before requesting cancellation.",
        );
      const result = await request("/cancel-order", {
        tracking: job.providerId,
        comment: reason,
      });
      if (result?.success !== "true" && result?.success !== true)
        throw new Error("eCourier cancellation unconfirmed");
      return normalized(reference, job.providerId, "cancelled");
    },
    async options() {
      const [packages, cities] = await Promise.all([
        request("/packages", {}),
        request("/city-list", {}),
      ]);
      if (
        !Array.isArray(packages) ||
        packages.length > 500 ||
        !Array.isArray(cities) ||
        cities.length > 1000
      )
        throw new Error("Invalid eCourier catalogue");
      return {
        packages: packages.map((p) =>
          body(
            z.object({
              package_name: z.string().max(160),
              package_code: z.string().max(60),
              delivery_time: z.string().max(100),
              coverage: z.string().max(100),
              shipping_charge: z.union([z.string().max(30), z.number()]),
            }),
            p,
          ),
        ),
        cities: cities.map((c) =>
          body(z.object({ name: text, value: text }), c),
        ),
      };
    },
  };
}
