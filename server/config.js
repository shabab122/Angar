import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatbotConfig } from "./chatbot-config.js";

export function loadConfig(env = process.env) {
  const required = ["MONGODB_URI", "COOKIE_SECRET", "APP_ORIGIN"];
  for (const name of required) {
    if (!env[name])
      throw new Error(`Missing ${name}. Run npm run setup or configure .env.`);
  }
  if (env.COOKIE_SECRET.length < 32)
    throw new Error("COOKIE_SECRET must be at least 32 characters.");
  const origin = new URL(env.APP_ORIGIN);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    env.APP_ORIGIN !== origin.origin
  ) {
    throw new Error(
      "APP_ORIGIN must be an HTTP(S) origin with no trailing slash or path.",
    );
  }

  const production = env.NODE_ENV === "production";
  const mailMode = env.MAIL_MODE || "off";
  if (!["off", "smtp", "outbox"].includes(mailMode))
    throw new Error("MAIL_MODE must be off, smtp or outbox.");
  if (production && mailMode === "outbox")
    throw new Error(
      "Local mail outbox is disabled in production. Configure SMTP.",
    );
  const smtpPort = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
    throw new Error("Invalid SMTP_PORT.");
  if (mailMode === "smtp" && (!env.SMTP_HOST || !env.MAIL_FROM))
    throw new Error("SMTP mode requires SMTP_HOST and MAIL_FROM.");
  if ((env.MAIL_FROM || "").match(/[\r\n]/))
    throw new Error("Invalid MAIL_FROM.");
  const smsMode = env.SMS_MODE || "off";
  if (!["off", "outbox", "twilio"].includes(smsMode))
    throw new Error("SMS_MODE must be off, outbox or twilio.");
  if (production && smsMode === "outbox")
    throw new Error("Local SMS outbox is disabled in production.");
  if (
    smsMode === "twilio" &&
    (!/^AC[a-fA-F0-9]{32}$/.test(env.TWILIO_ACCOUNT_SID || "") ||
      !env.TWILIO_AUTH_TOKEN ||
      !/^\+[1-9]\d{7,14}$/.test(env.TWILIO_FROM || ""))
  )
    throw new Error(
      "Twilio SMS mode requires valid account credentials and an international sender number.",
    );
  const pushEnabled = env.WEB_PUSH_ENABLED === "true";
  if (
    pushEnabled &&
    (!env.PUSH_VAPID_PUBLIC_KEY ||
      !env.PUSH_VAPID_PRIVATE_KEY ||
      !/^(https:\/\/|mailto:)/.test(env.PUSH_VAPID_SUBJECT || ""))
  )
    throw new Error(
      "Web Push requires a complete VAPID key pair and an HTTPS or mailto subject.",
    );
  if (production && origin.protocol !== "https:")
    throw new Error("Production requires an HTTPS APP_ORIGIN.");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const proxyHops = Number(env.TRUST_PROXY || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5)
    throw new Error("Invalid TRUST_PROXY.");

  const gatewayMode = env.SSLCOMMERZ_MODE || "sandbox";
  if (!["generic", "ecourier"].includes(env.COURIER_PROVIDER || "generic"))
    throw new Error("COURIER_PROVIDER must be generic or ecourier.");
  if (!["sandbox", "live"].includes(env.ECOURIER_MODE || "sandbox"))
    throw new Error("ECOURIER_MODE must be sandbox or live.");
  if (!["sandbox", "live"].includes(gatewayMode))
    throw new Error("SSLCOMMERZ_MODE must be sandbox or live.");
  const publicOrigin =
    env.SSLCOMMERZ_PUBLIC_ORIGIN ||
    (origin.protocol === "https:" ? origin.origin : "");
  if (
    publicOrigin &&
    (new URL(publicOrigin).origin !== publicOrigin ||
      new URL(publicOrigin).protocol !== "https:")
  )
    throw new Error(
      "SSLCOMMERZ_PUBLIC_ORIGIN must be a public HTTPS origin without a path.",
    );
  return {
    chatbot: chatbotConfig(env),
    kitchenPrinters: parsePrinters(env.KITCHEN_PRINTERS_JSON || "[]"),
    monitoring: {
      emailEnabled: env.MONITOR_EMAIL_ENABLED === "true",
      emails: (env.MONITOR_EMAIL_TO || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => {
          if (!/^[^\s@,;<>\r\n]+@[^\s@,;<>\r\n]+\.[^\s@,;<>\r\n]+$/.test(v))
            throw new Error("Invalid MONITOR_EMAIL_TO.");
          return v;
        }),
      slowMs: 3000,
    },
    courier: {
      provider: env.COURIER_PROVIDER || "generic",
      ecourier: {
        mode: env.ECOURIER_MODE || "sandbox",
        apiKey: env.ECOURIER_API_KEY || "",
        apiSecret: env.ECOURIER_API_SECRET || "",
        userId: env.ECOURIER_USER_ID || "",
      },
      name: env.COURIER_NAME || "Configured courier",
      url: env.COURIER_API_URL || "",
      token: env.COURIER_API_TOKEN || "",
      webhookSecret: env.COURIER_WEBHOOK_SECRET || "",
    },
    kitchenPrinter: {
      host: env.KITCHEN_PRINTER_HOST || "",
      port: Number(env.KITCHEN_PRINTER_PORT || 9100),
      columns: Number(env.KITCHEN_PRINTER_COLUMNS || 42),
      cut: env.KITCHEN_PRINTER_CUT === "true",
    },
    staffAlertEmails: (env.STAFF_ALERT_EMAIL_TO || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    staffMfa: {
      key: env.MFA_ENCRYPTION_KEY || "",
      requireAdmin: env.STAFF_REQUIRE_2FA_ADMIN === "true",
    },
    backupS3: {
      bucket: env.BACKUP_S3_BUCKET || "",
      region: env.BACKUP_S3_REGION || "us-east-1",
      endpoint: env.BACKUP_S3_ENDPOINT || "",
      prefix: env.BACKUP_S3_PREFIX || "angar-backups/",
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID || "",
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY || "",
      sessionToken: env.BACKUP_S3_SESSION_TOKEN || "",
      forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === "true",
      useDefaultCredentials: env.BACKUP_S3_USE_DEFAULT_CREDENTIALS === "true",
    },
    sms: {
      mode: smsMode,
      accountSid: env.TWILIO_ACCOUNT_SID || "",
      token: env.TWILIO_AUTH_TOKEN || "",
      from: env.TWILIO_FROM || "",
      outboxDir: path.resolve(
        env.SMS_OUTBOX_DIR ||
          fileURLToPath(new URL("../data/sms-outbox/", import.meta.url)),
      ),
    },
    push: {
      enabled: pushEnabled,
      publicKey: env.PUSH_VAPID_PUBLIC_KEY || "",
      privateKey: env.PUSH_VAPID_PRIVATE_KEY || "",
      subject: env.PUSH_VAPID_SUBJECT || "",
    },
    backup: {
      key: env.BACKUP_ENCRYPTION_KEY || "",
      directory: path.resolve(
        env.BACKUP_DIR ||
          fileURLToPath(new URL("../data/backups/", import.meta.url)),
      ),
    },
    mail: {
      mode: mailMode,
      host: env.SMTP_HOST || "",
      port: smtpPort,
      secure:
        env.SMTP_SECURE === "true" || (!env.SMTP_SECURE && smtpPort === 465),
      user: env.SMTP_USER || "",
      password: env.SMTP_PASSWORD || "",
      from: env.MAIL_FROM || "",
      outboxDir: path.resolve(
        env.MAIL_OUTBOX_DIR ||
          fileURLToPath(new URL("../data/mail-outbox/", import.meta.url)),
      ),
    },
    gateway: {
      mode: gatewayMode,
      storeId: env.SSLCOMMERZ_STORE_ID || "",
      storePassword: env.SSLCOMMERZ_STORE_PASSWORD || "",
      publicOrigin,
    },
    mongoUri: env.MONGODB_URI,
    mongoDatabase: env.MONGODB_DB || "angar",
    cookieSecret: env.COOKIE_SECRET,
    secureCookies: origin.protocol === "https:",
    origin: origin.origin,
    production,
    port,
    host: env.HOST || "127.0.0.1",
    proxyHops,
    dev: false,
    uploadDir: path.resolve(
      env.UPLOAD_DIR ||
        fileURLToPath(new URL("../data/reviews/", import.meta.url)),
    ),
  };
}
function parsePrinters(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error("KITCHEN_PRINTERS_JSON must be a JSON array.");
  }
  if (!Array.isArray(rows) || rows.length > 10)
    throw new Error(
      "Configure at most ten additional kitchen printer profiles.",
    );
  const seen = new Set(["default"]);
  return rows.map((p) => {
    if (
      !p ||
      typeof p !== "object" ||
      !Object.keys(p).every((k) =>
        ["id", "name", "host", "port", "columns", "cut"].includes(k),
      ) ||
      !/^[a-z][a-z0-9-]{1,23}$/.test(p.id || "") ||
      seen.has(p.id) ||
      typeof p.name !== "string" ||
      p.name.length < 2 ||
      p.name.length > 60 ||
      typeof p.host !== "string" ||
      p.host.length > 253 ||
      !/^[A-Za-z0-9.:-]+$/.test(p.host) ||
      !Number.isInteger(p.port) ||
      p.port < 1 ||
      p.port > 65535 ||
      !Number.isInteger(p.columns) ||
      p.columns < 32 ||
      p.columns > 48 ||
      typeof p.cut !== "boolean"
    )
      throw new Error(
        "Invalid kitchen printer profile; use a unique id, name, host, port, columns and cut.",
      );
    seen.add(p.id);
    return p;
  });
}
