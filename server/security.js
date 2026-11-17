import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";

const deriveKey = promisify(scrypt);
export const STAFF_ROLES = ["admin", "kitchen", "waiter", "cashier"];
export const randomToken = (size = 32) =>
  randomBytes(size).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const tableVisitKey = (visitId) =>
  hash(visitId.toHexString()).slice(0, 16);
export const sessionToken = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const objectId = (value) =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value)
    ? new ObjectId(value)
    : null;
const hour = 60 * 60 * 1000;
export const SESSION_LIFETIME = 12 * hour;
export const TABLE_COOKIE = "angar_table";
export const STAFF_COOKIE = "angar_staff";
const GUEST_COOKIE = "angar_guest";

export function cookieOptions(config, extra = {}) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    path: "/",
    ...extra,
  };
}

export function getGuest(req, res, config) {
  let token = req.signedCookies[GUEST_COOKIE];
  if (!sessionToken(token)) {
    token = randomToken();
    res.cookie(
      GUEST_COOKIE,
      token,
      cookieOptions(config, { signed: true, maxAge: 30 * 24 * hour }),
    );
  }
  return hash(token);
}

export function getTableCookie(req) {
  const cookie = req.signedCookies[TABLE_COOKIE];
  if (typeof cookie !== "string") return null;
  const [table, visit] = cookie.split(":");
  const tableId = objectId(table);
  return tableId ? { tableId, visitId: objectId(visit) } : null;
}

export async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}

export async function passwordMatches(password, stored) {
  // Unknown usernames still perform the same expensive password derivation.
  const fallback = "0".repeat(32) + ":" + "0".repeat(128);
  const [salt, digest] = (stored || fallback).split(":");
  const key = await deriveKey(password, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return (
    expected.length === key.length &&
    timingSafeEqual(key, expected) &&
    Boolean(stored)
  );
}
