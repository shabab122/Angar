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
