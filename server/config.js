import path from "node:path";
import { fileURLToPath } from "node:url";

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
  if (production && origin.protocol !== "https:")
    throw new Error("Production requires an HTTPS APP_ORIGIN.");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const proxyHops = Number(env.TRUST_PROXY || 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5)
    throw new Error("Invalid TRUST_PROXY.");

  const gatewayMode = env.SSLCOMMERZ_MODE || "sandbox";
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
