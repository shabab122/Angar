import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash, passwordHash } from "./security.js";
import { transaction } from "./money.js";

export const mailReady = (config) =>
  Boolean(
    config.mailer ||
    (config.mail?.mode === "outbox" && !config.production) ||
    (config.mail?.mode === "smtp" && config.mail.host && config.mail.from),
  );
export function mailStatus(config) {
  return { enabled: mailReady(config), mode: config.mail?.mode || "off" };
}

async function deliver(config, message) {
  if (config.mailer) return config.mailer(message);
  if (config.mail?.mode === "outbox" && !config.production) {
    await mkdir(config.mail.outboxDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(
        config.mail.outboxDir,
        Date.now() + "-" + randomBytes(8).toString("hex") + ".json",
      ),
      JSON.stringify({ ...message, createdAt: new Date() }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    requireTLS: !config.mail.secure,
    ...(config.mail.user
      ? { auth: { user: config.mail.user, pass: config.mail.password } }
      : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  await transport.sendMail({ from: config.mail.from, ...message });
}

export async function issueAccountMail(store, config, customer, purpose) {
  if (!mailReady(config)) return { sent: false, reason: "setup" };
  const now = new Date(),
    field = purpose === "verify" ? "verificationSentAt" : "recoverySentAt";
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    now.getTime() + (purpose === "verify" ? 24 * 3600000 : 30 * 60000),
  );
  const issued = await transaction(store, async (session) => {
    const current = await store.customers.findOneAndUpdate(
      {
        _id: customer._id,
        active: true,
        $or: [
          { [field]: { $lt: new Date(now.getTime() - 60000) } },
          { [field]: { $exists: false } },
        ],
      },
      { $set: { [field]: now } },
      { session, returnDocument: "after" },
    );
    if (!current || (purpose === "verify" && current.emailVerifiedAt))
      return false;
    await store.accountTokens.deleteMany(
      { customerId: current._id, purpose },
      { session },
    );
    await store.accountTokens.insertOne(
      {
        _id: hash(token),
        customerId: current._id,
        email: current.email,
        authVersion: current.authVersion || 0,
        purpose,
        expiresAt,
        createdAt: now,
      },
      { session },
    );
    return true;
  });
  if (!issued) return { sent: false, reason: "recent" };
  const link =
    config.origin +
    "/account/action#" +
    new URLSearchParams({ purpose, token });
  try {
    await deliver(config, {
      to: customer.email,
      subject:
        purpose === "verify"
          ? "Verify your Angar Kitchen email"
          : "Reset your Angar Kitchen password",
      text:
        (purpose === "verify"
          ? "Confirm your email address using the link below. The link expires in 24 hours."
          : "Choose a new password using the link below. The link expires in 30 minutes.") +
        "\n\n" +
        link +
        "\n\nIf you did not request this, ignore this message. No change happens until you confirm in the website.",
    });
    return { sent: true };
  } catch {
    await store.accountTokens.deleteOne({ _id: hash(token) });
    await store.customers.updateOne(
      { _id: customer._id, [field]: now },
      { $unset: { [field]: "" } },
    );
    return { sent: false, reason: "delivery" };
  }
}

export function registerAccountMail(api, store, config, requireCustomer) {
  const limit = rateLimit({
    windowMs: 15 * 60000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMIT",
        message: "Too many email requests. Please try again later.",
      },
    },
  });
  api.post(
    "/account/verification",
    requireCustomer,
    limit,
    async (req, res) => {
      if (req.customer.emailVerifiedAt)
        return res.json({ message: "Your email is already verified." });
      if (!mailReady(config))
        throw new HttpError(
          503,
          "MAIL_SETUP",
          "Email delivery is not configured. Please contact the restaurant.",
        );
      const result = await issueAccountMail(
        store,
        config,
        req.customer,
        "verify",
      );
      if (result.reason === "delivery")
        throw new HttpError(
          503,
          "MAIL_DELIVERY",
          "Email could not be sent. Please try again later.",
        );
      res.json({
        message:
          "Check your email for a verification link. Requests are limited to one per minute.",
      });
    },
  );
  api.post("/account/forgot-password", limit, async (req, res) => {
    const input = body(
      z.strictObject({
        email: z.string().trim().toLowerCase().email().max(254),
      }),
      req.body,
    );
    const customer = await store.customers.findOne({
      email: input.email,
      active: true,
    });
    if (customer) await issueAccountMail(store, config, customer, "reset");
    res.json({
      message:
        "If this email belongs to an active account and email delivery is available, a password reset link will arrive shortly.",
    });
  });
  for (const purpose of ["verify", "reset"]) {
    api.post(
      purpose === "verify"
        ? "/account/verify-email"
        : "/account/reset-password",
      limit,
      async (req, res) => {
        const input = body(
          z.strictObject({
            token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            ...(purpose === "reset"
              ? { newPassword: z.string().min(12).max(128) }
              : {}),
          }),
          req.body,
        );
        const newHash =
          purpose === "reset" ? await passwordHash(input.newPassword) : null;
        await transaction(store, async (session) => {
          const record = await store.accountTokens.findOneAndDelete(
            { _id: hash(input.token), purpose, expiresAt: { $gt: new Date() } },
            { session },
          );
          const customer =
            record &&
            (await store.customers.findOne(
              { _id: record.customerId, email: record.email, active: true },
              { session },
            ));
          if (!customer || (customer.authVersion || 0) !== record.authVersion)
            throw new HttpError(
              400,
              "INVALID_LINK",
              "This link is invalid, expired or already used. Request a new link.",
            );
          await store.customers.updateOne(
            { _id: customer._id },
            {
              $set: {
                emailVerifiedAt: customer.emailVerifiedAt || new Date(),
                ...(newHash
                  ? { passwordHash: newHash, passwordChangedAt: new Date() }
                  : {}),
              },
              ...(newHash ? { $inc: { authVersion: 1 } } : {}),
            },
            { session },
          );
          if (newHash) {
            await store.customerSessions.deleteMany(
              { customerId: customer._id },
              { session },
            );
            await store.accountTokens.deleteMany(
              { customerId: customer._id },
              { session },
            );
          }
          await store.audit.insertOne(
            {
              type:
                purpose === "verify"
                  ? "customer.email_verified"
                  : "customer.password_recovered",
              customerId: customer._id,
              at: new Date(),
            },
            { session },
          );
        });
        res.json({
          message:
            purpose === "verify"
              ? "Email verified. You can return to your account."
              : "Password updated. Sign in again with your new password.",
        });
      },
    );
  }
}
