import { randomBytes } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { getGuest, hash } from "./security.js";
import { actorKey, contactPhone } from "./customer.js";
import { transaction, heldMinor, remainingMinor, parseMinor } from "./money.js";
import { appendPayment } from "./payments.js";
import { requireBillOwner } from "./commerce.js";

const SUCCESS = new Set(["VALID", "VALIDATED"]);
const TERMINAL = new Set(["FAILED", "CANCELLED", "EXPIRED"]);
async function requireIntentOwner(store, intent, req, res, config) {
  const guestHash = getGuest(req, res, config);
  if (
    !intent ||
    (intent.customerId
      ? !intent.customerId.equals(req.customer?._id)
      : intent.guestHash !== guestHash)
  )
    throw new HttpError(404, "NOT_FOUND", "This payment could not be found.");
  const bill = await store.bills.findOne({ _id: intent.billId });
  await requireBillOwner(store, bill, req, res, config);
}
const view = (intent) => ({
  id: intent._id,
  billId: intent.billId.toString(),
  amountMinor: intent.amountMinor,
  splitId: intent.splitId || "",
  status: intent.status,
  createdAt: intent.createdAt,
  updatedAt: intent.updatedAt,
  checkoutUrl: ["pending", "creating"].includes(intent.status)
    ? intent.checkoutUrl || null
    : null,
  message: intent.message || "",
  mode: intent.mode,
});

export function gatewayClient(config) {
  const settings = config.gateway || {};
  const host =
    settings.mode === "live"
      ? "https://securepay.sslcommerz.com"
      : "https://sandbox.sslcommerz.com";
  const ready = Boolean(
    settings.storeId && settings.storePassword && settings.publicOrigin,
  );
  async function call(path, fields, post = false) {
    if (!ready)
      throw new HttpError(
        503,
        "GATEWAY_SETUP",
        "Configure SSLCOMMERZ credentials and a public HTTPS callback origin first.",
      );
    const form = new URLSearchParams({
      store_id: settings.storeId,
      store_passwd: settings.storePassword,
      ...fields,
    });
    let response;
    try {
      response = await (config.gatewayFetch || fetch)(
        host + path + (post ? "" : "?" + form),
        {
          method: post ? "POST" : "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          ...(post
            ? {
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: form.toString(),
              }
            : {}),
        },
      );
      if (!response.ok) throw Error();
      return await response.json();
    } catch {
      throw new HttpError(
        503,
        "GATEWAY_UNAVAILABLE",
        "The payment provider did not confirm a response. Check payment status before starting another attempt.",
      );
    }
  }
  return {
    ready,
    mode: settings.mode || "sandbox",
    publicOrigin: settings.publicOrigin,
    create: (fields) => call("/gwprocess/v4/api.php", fields, true),
    validate: (valId) =>
      call("/validator/api/validationserverAPI.php", {
        val_id: valId,
        format: "json",
      }),
    query: (intent) =>
      call("/validator/api/merchantTransIDvalidationAPI.php", {
        tran_id: intent._id,
        format: "json",
      }),
    refund: (fields) =>
      call("/validator/api/merchantTransIDvalidationAPI.php", fields),
    refundStatus: (reference) =>
      call("/validator/api/merchantTransIDvalidationAPI.php", {
        refund_ref_id: reference,
        format: "json",
      }),
  };
}

async function releaseHold(store, id, status, message) {
  return transaction(store, async (session) => {
    const intent = await store.gatewayTransactions.findOne(
      { _id: id },
      { session },
    );
    if (!intent || ["paid", "overpayment_review"].includes(intent.status))
      return intent;
    await store.bills.updateOne(
      { _id: intent.billId },
      { $pull: { holds: { id } }, $inc: { revision: 1 } },
      { session },
    );
    const result = await store.gatewayTransactions.findOneAndUpdate(
      { _id: id },
      { $set: { status, message, updatedAt: new Date() } },
      { session, returnDocument: "after" },
    );
    return result;
  });
}

export async function validateGatewayPayment(
  store,
  config,
  id,
  valId,
  { riskApprovedBy = null } = {},
) {
  const client = gatewayClient(config);
  const intent = await store.gatewayTransactions.findOne({ _id: id });
  if (!intent)
    throw new HttpError(404, "NOT_FOUND", "This payment could not be found.");
  if (
    intent.mode !== client.mode ||
    (intent.merchantKey &&
      intent.merchantKey !== hash(client.mode + ":" + config.gateway.storeId))
  )
    throw new HttpError(
      409,
      "GATEWAY_ACCOUNT",
      "This attempt belongs to a different gateway mode or merchant configuration.",
    );
  const data = await client.validate(valId);
  if (
    !SUCCESS.has(data.status) ||
    data.tran_id !== intent._id ||
    parseMinor(data.amount) !== intent.amountMinor ||
    data.currency !== "BDT" ||
    (data.currency_type && data.currency_type !== "BDT") ||
    (data.store_id && data.store_id !== config.gateway.storeId) ||
    (data.val_id && data.val_id !== valId) ||
    typeof data.bank_tran_id !== "string" ||
    !data.bank_tran_id ||
    data.bank_tran_id.length > 100
  )
    throw new HttpError(
      409,
      "PAYMENT_MISMATCH",
      "The provider did not verify this transaction, amount and currency.",
    );
  const highRisk = String(data.risk_level) !== "0";
  if (highRisk && !riskApprovedBy) {
    await store.gatewayTransactions.updateOne(
      { _id: id, status: { $ne: "paid" } },
      {
        $set: {
          status: "review",
          validationId: valId,
          message: "Provider-verified payment requires manager risk review.",
          updatedAt: new Date(),
        },
      },
    );
    return store.gatewayTransactions.findOne({ _id: id });
  }
  try {
    return await transaction(store, async (session) => {
      const current = await store.gatewayTransactions.findOneAndUpdate(
        { _id: id },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (current.status === "paid" || current.status === "overpayment_review")
        return current;
      let bill = await store.bills.findOneAndUpdate(
        { _id: current.billId },
        { $inc: { revision: 1 }, $pull: { holds: { id } } },
        { session, returnDocument: "after" },
      );
      if (!bill)
        throw new HttpError(
          404,
          "NOT_FOUND",
          "The associated bill could not be found.",
        );
      const verified = {
        validationId: valId,
        bankTransactionId: data.bank_tran_id,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      };
      const remaining = remainingMinor(bill, current.splitId);
      if (
        bill.status === "paid" ||
        remaining < current.amountMinor ||
        remaining - heldMinor(bill, current.splitId) < current.amountMinor
      ) {
        await store.gatewayTransactions.updateOne(
          { _id: id },
          {
            $set: {
              ...verified,
              status: "overpayment_review",
              message:
                "Verified funds exceed the bill balance. Manager reconciliation/refund required.",
            },
          },
          { session },
        );
        await store.audit.insertOne(
          {
            type: "gateway.overpayment_review",
            transactionId: id,
            billId: bill._id,
            amountMinor: current.amountMinor,
            at: new Date(),
          },
          { session },
        );
      } else {
        bill = await appendPayment(
          store,
          bill,
          {
            key: "ssl:" + id,
            method: "sslcommerz",
            amountMinor: current.amountMinor,
            splitId: current.splitId,
            reference: data.bank_tran_id,
            by: riskApprovedBy || "sslcommerz",
          },
          session,
        );
        await store.gatewayTransactions.updateOne(
          { _id: id },
          {
            $set: {
              ...verified,
              status: "paid",
              message: "Payment verified and credited.",
              ...(riskApprovedBy ? { riskApprovedBy } : {}),
            },
          },
          { session },
        );
      }
      return store.gatewayTransactions.findOne({ _id: id }, { session });
    });
  } catch (error) {
    if (error.code === 11000)
      throw new HttpError(
        409,
        "PAYMENT_REUSED",
        "This provider payment was already linked to another transaction.",
      );
    throw error;
  }
}

export async function reconcileGateway(store, config, id) {
  const intent = await store.gatewayTransactions.findOne({ _id: id });
  if (!intent)
    throw new HttpError(404, "NOT_FOUND", "This payment could not be found.");
  if (["paid", "overpayment_review"].includes(intent.status)) return intent;
  if (
    intent.mode !== gatewayClient(config).mode ||
    (intent.merchantKey &&
      intent.merchantKey !==
        hash(gatewayClient(config).mode + ":" + config.gateway.storeId))
  )
    throw new HttpError(
      409,
      "GATEWAY_ACCOUNT",
      "Restore the gateway mode and merchant used for this attempt before reconciling it.",
    );
  const result = await gatewayClient(config).query(intent);
  if (result.APIConnect !== "DONE")
    throw new HttpError(
      503,
      "GATEWAY_UNAVAILABLE",
      "The provider could not confirm the transaction query.",
    );
  const rows = Array.isArray(result.element)
    ? result.element.filter((row) => row.tran_id === id)
    : result.tran_id === id
      ? [result]
      : [];
  const success = rows.find((row) => SUCCESS.has(row.status) && row.val_id);
  if (success) return validateGatewayPayment(store, config, id, success.val_id);
  // A pending/success-capable session must not be released on a browser cancel alone.
  if (rows.length && rows.every((row) => TERMINAL.has(row.status)))
    return releaseHold(
      store,
      id,
      "failed",
      "The provider confirmed this attempt ended without payment.",
    );
  await store.gatewayTransactions.updateOne(
    { _id: id, status: { $nin: ["paid", "review", "overpayment_review"] } },
    {
      $set: {
        status: "pending",
        message:
          "Awaiting authoritative provider confirmation; the amount remains reserved.",
        updatedAt: new Date(),
      },
    },
  );
  return store.gatewayTransactions.findOne({ _id: id });
}

export function registerGatewayCallbacks(app, store, config) {
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.use(
    express.urlencoded({ extended: false, limit: "16kb" }),
    express.json({ limit: "16kb" }),
  );
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.post("/ipn", async (req, res) => {
    const input = body(
      z.object({
        tran_id: z.string().regex(/^AK[A-Fa-f0-9]{24}$/),
        val_id: z.string().max(100).optional(),
      }),
      req.body,
    );
    if (input.val_id)
      await validateGatewayPayment(store, config, input.tran_id, input.val_id);
    else await reconcileGateway(store, config, input.tran_id);
    res.json({ received: true });
  });
  router.all("/return/:id", async (req, res) => {
    const intent = /^AK[0-9a-f]{24}$/.test(req.params.id)
      ? await store.gatewayTransactions.findOne({ _id: req.params.id })
      : null;
    if (!intent) return res.redirect(303, config.origin + "/orders");
    try {
      const valId =
        typeof req.body?.val_id === "string"
          ? req.body.val_id
          : typeof req.query.val_id === "string"
            ? req.query.val_id
            : "";
      if (valId) await validateGatewayPayment(store, config, intent._id, valId);
      else await reconcileGateway(store, config, intent._id);
    } catch {
      /* IPN or an explicit status check can recover an interrupted return. */
    }
    res.redirect(
      303,
      config.origin +
        "/payment?bill=" +
        intent.billId +
        "&transaction=" +
        intent._id,
    );
  });
  app.use("/api/payments/sslcommerz", router);
}

export function registerGuestGateway(api, store, config, requireId) {
  api.use(
    "/bills/:id/online-payments",
    rateLimit({
      windowMs: 15 * 60000,
      limit: 50,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  api.use(
    "/online-payments/:id/reconcile",
    rateLimit({
      windowMs: 60000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  api.get("/payments/options", (req, res) =>
    res.json({
      provider: "SSLCOMMERZ",
      enabled: gatewayClient(config).ready,
      mode: gatewayClient(config).mode,
    }),
  );
  api.post("/bills/:id/online-payments", async (req, res) => {
    const client = gatewayClient(config);
    if (!client.ready)
      throw new HttpError(
        503,
        "GATEWAY_SETUP",
        "Online checkout needs SSLCOMMERZ credentials and a public HTTPS callback origin.",
      );
    const input = body(
      z.strictObject({
        requestKey: z.string().regex(/^[a-f0-9]{32}$/),
        amountMinor: z.number().int().positive(),
        splitId: z.string().max(32).optional(),
        name: z.string().trim().min(2).max(50),
        email: z.string().trim().email().max(50),
        phone: contactPhone,
        consent: z.literal(true, {
          error:
            "Allow your receipt details to be sent to the payment provider.",
        }),
      }),
      req.body,
    );
    const billId = requireId(req.params.id),
      ownerKey = actorKey(req, getGuest(req, res, config)),
      clientKey = hash(ownerKey + ":" + input.requestKey);
    const fingerprint = hash(
      JSON.stringify({
        ...input,
        name: input.name.trim(),
        email: input.email.toLowerCase(),
      }),
    );
    const intent = await transaction(store, async (session) => {
      const bill = await store.bills.findOneAndUpdate(
        { _id: billId },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      await requireBillOwner(store, bill, req, res, config);
      const existing = await store.gatewayTransactions.findOne(
        { clientKey },
        { session },
      );
      if (existing) {
        if (
          !existing.billId.equals(billId) ||
          existing.fingerprint !== fingerprint
        )
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This payment key belongs to a different checkout.",
          );
        return { existing: true, record: existing };
      }
      if (bill.status !== "finalized")
        throw new HttpError(
          409,
          "BILL_NOT_FINAL",
          "This bill is not awaiting payment.",
        );
      if (bill.splits?.length && !input.splitId)
        throw new HttpError(400, "SPLIT_REQUIRED", "Choose a split to pay.");
      if (
        input.amountMinor >
        remainingMinor(bill, input.splitId) - heldMinor(bill, input.splitId)
      )
        throw new HttpError(
          409,
          "PAYMENT_AMOUNT",
          "This amount exceeds the unreserved balance.",
        );
      if ((bill.holds || []).length >= 20)
        throw new HttpError(
          409,
          "PAYMENT_LIMIT",
          "Too many pending payment attempts; ask the cashier to reconcile them.",
        );
      const record = {
        _id: "AK" + randomBytes(12).toString("hex"),
        billId,
        ownerKey,
        clientKey,
        fingerprint,
        guestHash: getGuest(req, res, config),
        ...(req.customer ? { customerId: req.customer._id } : {}),
        amountMinor: input.amountMinor,
        ...(input.splitId ? { splitId: input.splitId } : {}),
        mode: client.mode,
        merchantKey: hash(client.mode + ":" + config.gateway.storeId),
        status: "creating",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await store.gatewayTransactions.insertOne(record, { session });
      await store.bills.updateOne(
        { _id: billId },
        {
          $push: {
            holds: {
              id: record._id,
              amountMinor: input.amountMinor,
              ...(input.splitId ? { splitId: input.splitId } : {}),
            },
          },
        },
        { session },
      );
      return { existing: false, record };
    });
    if (intent.existing) return res.json({ transaction: view(intent.record) });
    const record = intent.record,
      returnUrl =
        client.publicOrigin + "/api/payments/sslcommerz/return/" + record._id;
    try {
      const response = await client.create({
        total_amount: (record.amountMinor / 100).toFixed(2),
        currency: "BDT",
        tran_id: record._id,
        success_url: returnUrl,
        fail_url: returnUrl,
        cancel_url: returnUrl,
        ipn_url: client.publicOrigin + "/api/payments/sslcommerz/ipn",
        cus_name: input.name,
        cus_email: input.email,
        cus_phone: input.phone,
        cus_add1: "Dine-in restaurant",
        cus_city: "Dhaka",
        cus_country: "Bangladesh",
        shipping_method: "NO",
        num_of_item: "1",
        product_name: "Angar Kitchen table bill",
        product_category: "food",
        product_profile: "general",
        emi_option: "0",
      });
      if (response.status === "FAILED") {
        await releaseHold(
          store,
          record._id,
          "failed",
          "The provider rejected checkout creation.",
        );
        throw new HttpError(
          502,
          "GATEWAY_REJECTED",
          "The provider rejected checkout creation. Check the merchant configuration.",
        );
      }
      let url;
      try {
        url = new URL(response.GatewayPageURL);
      } catch {
        throw new HttpError(
          503,
          "GATEWAY_UNAVAILABLE",
          "Checkout creation was not confirmed. Recheck this attempt before retrying.",
        );
      }
      if (
        response.status !== "SUCCESS" ||
        !response.sessionkey ||
        url.protocol !== "https:" ||
        !(
          url.hostname === "sslcommerz.com" ||
          url.hostname.endsWith(".sslcommerz.com")
        ) ||
        url.username ||
        url.password
      )
        throw new HttpError(
          503,
          "GATEWAY_UNAVAILABLE",
          "The provider returned an unrecognized checkout. Recheck this attempt.",
        );
      await store.gatewayTransactions.updateOne(
        { _id: record._id, status: "creating" },
        {
          $set: {
            checkoutUrl: url.href,
            sessionKey: response.sessionkey,
            status: "pending",
            updatedAt: new Date(),
          },
        },
      );
    } catch (error) {
      await store.gatewayTransactions.updateOne(
        { _id: record._id, status: "creating" },
        {
          $set: {
            status: "unknown",
            message:
              "Checkout creation may have been interrupted. Reconcile before trying another payment.",
            updatedAt: new Date(),
          },
        },
      );
      throw error;
    }
    res.status(201).json({
      transaction: view(
        await store.gatewayTransactions.findOne({ _id: record._id }),
      ),
    });
  });
  api.get("/online-payments/:id", async (req, res) => {
    const intent = await store.gatewayTransactions.findOne({
      _id: req.params.id,
    });
    await requireIntentOwner(store, intent, req, res, config);
    res.json({ transaction: view(intent) });
  });
  api.post("/online-payments/:id/reconcile", async (req, res) => {
    const intent = await store.gatewayTransactions.findOne({
      _id: req.params.id,
    });
    await requireIntentOwner(store, intent, req, res, config);
    res.json({
      transaction: view(await reconcileGateway(store, config, intent._id)),
    });
  });
}

export function registerStaffGateway(
  api,
  store,
  config,
  billingRoles,
  requireAdmin,
) {
  api.get("/online-payments", billingRoles, async (req, res) => {
    const rows = await store.gatewayTransactions
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const bills = await store.bills
      .find({ _id: { $in: rows.map((row) => row.billId) } })
      .toArray();
    res.json({
      transactions: rows.map((row) => {
        const bill = bills.find((bill) => bill._id.equals(row.billId));
        const { checkoutUrl, ...visible } = view(row);
        return {
          ...visible,
          receiptNo: bill?.receiptNo || "",
          tableNumber: bill?.tableNumber || "",
        };
      }),
      enabled: gatewayClient(config).ready,
      mode: gatewayClient(config).mode,
    });
  });
  api.post("/online-payments/:id/reconcile", billingRoles, async (req, res) =>
    res.json({
      transaction: view(await reconcileGateway(store, config, req.params.id)),
    }),
  );
  api.post(
    "/online-payments/:id/approve-risk",
    requireAdmin,
    async (req, res) => {
      const { reason } = body(
        z.strictObject({ reason: z.string().trim().min(3).max(160) }),
        req.body,
      );
      const intent = await store.gatewayTransactions.findOne({
        _id: req.params.id,
        status: "review",
      });
      if (!intent?.validationId)
        throw new HttpError(
          409,
          "PAYMENT_UPDATED",
          "This payment is not awaiting risk review.",
        );
      const result = await validateGatewayPayment(
        store,
        config,
        intent._id,
        intent.validationId,
        { riskApprovedBy: req.staff.username },
      );
      await store.audit.insertOne({
        type: "gateway.risk_approved",
        transactionId: intent._id,
        by: req.staff.username,
        reason,
        at: new Date(),
      });
      res.json({ transaction: view(result) });
    },
  );
}
