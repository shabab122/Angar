import {
  hasBranchAccess,
  assertManageStaff,
  effectiveStaff,
} from "./access.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";
import {
  cookieOptions,
  hash,
  passwordMatches,
  randomToken,
  sessionToken,
  STAFF_COOKIE,
  SESSION_LIFETIME,
} from "./security.js";
import { staffIdentity } from "./staff-accounts.js";

const pendingCookie = "angar_staff_pending",
  now = (config) => (config.mfaNow ? config.mfaNow() : Date.now());
const keyReady = (config) => /^[a-f0-9]{64}$/i.test(config.staffMfa?.key || "");
export const staffPayload = (user, config) => {
  const current = effectiveStaff(user, config.branchId || "main");
  return {
    ...staffIdentity(current),
    branchId: config.branchId || "main",
    mfaEnabled: Boolean(user.mfa?.enabled),
    mfaSetupRequired: Boolean(
      config.staffMfa?.requireAdmin &&
      current.role === "admin" &&
      !user.mfa?.enabled,
    ),
  };
};
function encrypt(config, staffId, secret) {
  if (!keyReady(config))
    throw new HttpError(
      503,
      "MFA_SETUP",
      "Run setup and preserve MFA_ENCRYPTION_KEY before enabling staff two-factor authentication.",
    );
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(config.staffMfa.key, "hex"),
      iv,
    );
  cipher.setAAD(Buffer.from("angar-staff-mfa:" + staffId));
  return {
    iv: iv.toString("base64url"),
    data: Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]).toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}
function decrypt(config, staffId, value) {
  try {
    if (!keyReady(config)) throw Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.staffMfa.key, "hex"),
      Buffer.from(value.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from("angar-staff-mfa:" + staffId));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, "base64url")),
      decipher.final(),
    ]).toString();
  } catch {
    throw new HttpError(
      503,
      "MFA_KEY",
      "The original MFA encryption key is unavailable. Restore it, use a saved recovery code, or follow the local operator recovery guide.",
    );
  }
}
export const makeTotp = (secret, username) =>
  new OTPAuth.TOTP({
    issuer: "Angar Kitchen Staff",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
const normalizeCode = (value) =>
  String(value || "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
const secureEqual = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const recoverySet = () =>
  Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").toUpperCase().match(/.{8}/g).join("-"),
  );
function verifyFactor(user, input, config) {
  if (!user.mfa?.enabled) return null;
  const code = normalizeCode(input);
  if (/^[A-F0-9]{32}$/.test(code)) {
    const digest = hash(code),
      matched = (user.mfa.recovery || []).find((value) =>
        secureEqual(value, digest),
      );
    return matched ? { recovery: matched } : null;
  }
  if (!/^\d{6}$/.test(code)) return null;
  const totp = makeTotp(
      decrypt(config, user._id, user.mfa.secret),
      user.username,
    ),
    timestamp = now(config),
    delta = totp.validate({ token: code, window: 1, timestamp });
  if (delta === null) return null;
  const counter = Math.floor(timestamp / 30000) + delta;
  return counter > (user.mfa.lastCounter ?? -1) ? { counter } : null;
}
const afterFactor = (user, proof) => ({
  ...user.mfa,
  ...(proof.counter !== undefined ? { lastCounter: proof.counter } : {}),
  ...(proof.recovery
    ? {
        recovery: user.mfa.recovery.filter((value) => value !== proof.recovery),
      }
    : {}),
});

// Call after locking the staff record. Return failures so the surrounding
// transaction commits the attempt counter instead of rolling it back.
async function checkFactor(store, user, code, config, session) {
  if (user.mfaLockedUntil && user.mfaLockedUntil > new Date())
    return { failed: "MFA_LOCKED" };
  const proof = verifyFactor(user, code, config);
  if (!proof) {
    const inWindow =
        user.mfaFailureSince &&
        user.mfaFailureSince > new Date(Date.now() - 15 * 60000),
      failures = (inWindow ? user.mfaFailures || 0 : 0) + 1;
    await store.staff.updateOne(
      { _id: user._id },
      {
        $set: {
          mfaFailures: failures,
          mfaFailureSince: inWindow ? user.mfaFailureSince : new Date(),
          ...(failures >= 10
            ? { mfaLockedUntil: new Date(Date.now() + 15 * 60000) }
            : {}),
        },
      },
      { session },
    );
    await store.audit.insertOne(
      {
        type: "staff.mfa_failed",
        staffId: user._id,
        by: user.username,
        at: new Date(),
      },
      { session },
    );
    return { failed: "MFA_CODE" };
  }
  const mfa = afterFactor(user, proof);
  await store.staff.updateOne(
    { _id: user._id },
    {
      $set: { mfa, mfaFailures: 0 },
      $unset: { mfaLockedUntil: "", mfaFailureSince: "" },
    },
    { session },
  );
  return { proof, mfa };
}
function factorError(result) {
  if (result.failed)
    throw new HttpError(
      400,
      result.failed,
      result.failed === "MFA_LOCKED"
        ? "Two-factor attempts are temporarily locked. Wait 15 minutes before trying again."
        : "A fresh authenticator code or unused recovery code is required.",
    );
}

export async function issueStaffSession(
  store,
  config,
  req,
  res,
  user,
  session,
) {
  const current = await store.staff.findOne(
    { _id: user._id, active: true, authVersion: user.authVersion || 0 },
    { session },
  );
  // Older accounts omit authVersion; their effective version is still zero.
  const actual =
    current ||
    (user.authVersion
      ? null
      : await store.staff.findOne(
          { _id: user._id, active: true, authVersion: { $exists: false } },
          { session },
        ));
  if (!actual)
    throw new HttpError(
      401,
      "STAFF_REQUIRED",
      "Your access changed. Sign in again.",
    );
  if (!hasBranchAccess(actual, store.branchId || "main"))
    throw new HttpError(
      403,
      "BRANCH_FORBIDDEN",
      "Your branch access changed. Choose an assigned branch.",
    );
  const previous = req.cookies[STAFF_COOKIE];
  if (sessionToken(previous))
    await store.sessions.deleteOne({ _id: hash(previous) }, { session });
  const token = randomToken();
  await store.sessions.insertOne(
    {
      _id: hash(token),
      staffId: actual._id,
      authVersion: actual.authVersion || 0,
      expiresAt: new Date(Date.now() + SESSION_LIFETIME),
    },
    { session },
  );
  await store.staff.updateOne(
    { _id: actual._id },
    { $set: { lastLoginAt: new Date() } },
    { session },
  );
  res.cookie(
    STAFF_COOKIE,
    token,
    cookieOptions(config, { maxAge: SESSION_LIFETIME }),
  );
  res.clearCookie(pendingCookie, cookieOptions(config));
  return staffPayload(actual, config);
}
export async function beginStaffLogin(store, config, req, res, user) {
  if (!hasBranchAccess(user, store.branchId || "main"))
    throw new HttpError(
      403,
      "BRANCH_FORBIDDEN",
      "This account is not assigned to the selected branch.",
    );
  if (!user.mfa?.enabled)
    return res.json(await issueStaffSession(store, config, req, res, user));
  const old = req.cookies[STAFF_COOKIE];
  if (sessionToken(old)) await store.sessions.deleteOne({ _id: hash(old) });
  res.clearCookie(STAFF_COOKIE, cookieOptions(config));
  const previous = req.signedCookies[pendingCookie];
  if (sessionToken(previous))
    await store.staffMfaChallenges.deleteOne({ _id: hash(previous) });
  const token = randomToken();
  await store.staffMfaChallenges.insertOne({
    _id: hash(token),
    staffId: user._id,
    authVersion: user.authVersion || 0,
    attempts: 0,
    expiresAt: new Date(Date.now() + 5 * 60000),
  });
  res.cookie(
    pendingCookie,
    token,
    cookieOptions(config, { signed: true, maxAge: 5 * 60000 }),
  );
  res.json({
    needsMfa: true,
    message: "Enter a fresh authenticator code or one unused recovery code.",
  });
}
export async function clearPendingMfa(store, req, res, config) {
  const token = req.signedCookies[pendingCookie];
  if (sessionToken(token))
    await store.staffMfaChallenges.deleteOne({ _id: hash(token) });
  res.clearCookie(pendingCookie, cookieOptions(config));
}

export function registerMfaLogin(api, store, config) {
  const limit = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  api.post("/login/verify", limit, async (req, res) => {
    const input = body(
        z.strictObject({ code: z.string().trim().min(6).max(80) }),
        req.body,
      ),
      token = req.signedCookies[pendingCookie];
    if (!sessionToken(token))
      throw new HttpError(
        401,
        "MFA_CHALLENGE",
        "Start again with your staff username and password.",
      );
    const result = await transaction(store, async (session) => {
      const challenge = await store.staffMfaChallenges.findOneAndUpdate(
        {
          _id: hash(token),
          expiresAt: { $gt: new Date() },
          attempts: { $lt: 5 },
        },
        { $inc: { attempts: 1 } },
        { session, returnDocument: "after" },
      );
      if (!challenge) return { failed: "MFA_CHALLENGE" };
      const user = await store.staff.findOneAndUpdate(
        { _id: challenge.staffId, active: true },
        { $inc: { mfaRevision: 1 } },
        { session, returnDocument: "after" },
      );
      if (
        !user?.mfa?.enabled ||
        (user.authVersion || 0) !== challenge.authVersion
      )
        return { failed: "MFA_CHALLENGE" };
      const checked = await checkFactor(
        store,
        user,
        input.code,
        config,
        session,
      );
      if (checked.failed) return checked;
      const { proof, mfa } = checked;
      await store.staffMfaChallenges.deleteOne(
        { _id: hash(token) },
        { session },
      );
      await store.audit.insertOne(
        {
          type: proof.recovery ? "staff.recovery_code_used" : "staff.mfa_login",
          staffId: user._id,
          by: user.username,
          at: new Date(),
        },
        { session },
      );
      const identity = await issueStaffSession(
        store,
        config,
        req,
        res,
        { ...user, mfa },
        session,
      );
      return { identity };
    });
    if (result.failed)
      throw new HttpError(
        result.failed === "MFA_CHALLENGE" ? 401 : 400,
        result.failed,
        result.failed === "MFA_LOCKED"
          ? "Two-factor attempts are temporarily locked. Wait 15 minutes before trying again."
          : "The code is invalid, already used or expired. Use a fresh authenticator code, a saved recovery code, or restart staff sign-in.",
      );
    res.json(result.identity);
  });
}

export function registerStaffMfa(api, store, config, requireAdmin, requireId) {
  const limited = rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const passwordInput = z.string().min(1).max(128),
    codeInput = z.string().trim().min(6).max(80);
  const currentUser = async (req, password) => {
    const user = await store.staff.findOne({
      _id: req.staff._id,
      active: true,
    });
    if (
      !user ||
      (user.authVersion || 0) !== (req.staff.authVersion || 0) ||
      !(await passwordMatches(password, user.passwordHash))
    )
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter your current staff password.",
      );
    return user;
  };
  api.get("/mfa", async (req, res) => {
    const user = await store.staff.findOne({ _id: req.staff._id });
    res.json({
      enabled: Boolean(user.mfa?.enabled),
      configured: keyReady(config),
      recoveryCodesRemaining: user.mfa?.recovery?.length || 0,
      required: Boolean(
        config.staffMfa?.requireAdmin &&
        effectiveStaff(user, store.branchId).role === "admin",
      ),
      enrolledAt: user.mfa?.enrolledAt || null,
    });
  });
  api.post("/mfa/begin", limited, async (req, res) => {
    const input = body(
        z.strictObject({ currentPassword: passwordInput }),
        req.body,
      ),
      user = await currentUser(req, input.currentPassword);
    if (user.mfa?.enabled)
      throw new HttpError(
        409,
        "MFA_ENABLED",
        "Verify and disable the current factor before enrolling a replacement.",
      );
    const secret = new OTPAuth.Secret({ size: 20 }),
      totp = makeTotp(secret, user.username),
      encrypted = encrypt(config, user._id, secret.base32),
      sessionHash = hash(req.cookies[STAFF_COOKIE]);
    await store.staffMfaEnrollments.replaceOne(
      { _id: user._id },
      {
        _id: user._id,
        secret: encrypted,
        sessionHash,
        authVersion: user.authVersion || 0,
        attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60000),
      },
      { upsert: true },
    );
    res.json({
      secret: secret.base32,
      uri: totp.toString(),
      qr: await QRCode.toDataURL(totp.toString(), { width: 240, margin: 2 }),
      expiresInMinutes: 10,
    });
  });
  api.post("/mfa/enable", limited, async (req, res) => {
    const input = body(z.strictObject({ code: codeInput }), req.body),
      enrollment = await store.staffMfaEnrollments.findOneAndUpdate(
        {
          _id: req.staff._id,
          sessionHash: hash(req.cookies[STAFF_COOKIE]),
          expiresAt: { $gt: new Date() },
          attempts: { $lt: 5 },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" },
      );
    if (!enrollment)
      throw new HttpError(
        409,
        "MFA_ENROLLMENT",
        "Start a fresh two-factor setup in this browser.",
      );
    const candidate = {
        ...req.staff,
        mfa: { enabled: true, secret: enrollment.secret },
      },
      proof = verifyFactor(candidate, input.code, config);
    if (!proof || proof.counter === undefined)
      throw new HttpError(
        400,
        "MFA_CODE",
        "Enter a valid current code from the authenticator you just added.",
      );
    const recoveryCodes = recoverySet();
    const identity = await transaction(store, async (session) => {
      const consumed = await store.staffMfaEnrollments.deleteOne(
        {
          _id: req.staff._id,
          sessionHash: enrollment.sessionHash,
          secret: enrollment.secret,
        },
        { session },
      );
      if (!consumed.deletedCount)
        throw new HttpError(
          409,
          "MFA_ENROLLMENT",
          "This setup was replaced or already completed.",
        );
      const user = await store.staff.findOneAndUpdate(
        { _id: req.staff._id, active: true, "mfa.enabled": { $ne: true } },
        { $inc: { mfaRevision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!user || (user.authVersion || 0) !== enrollment.authVersion)
        throw new HttpError(
          409,
          "ACCESS_CHANGED",
          "Your access changed. Start again.",
        );
      const mfa = {
          enabled: true,
          secret: enrollment.secret,
          lastCounter: proof.counter,
          enrolledAt: new Date(),
          recovery: recoveryCodes.map((code) => hash(normalizeCode(code))),
        },
        next = { ...user, mfa, authVersion: (user.authVersion || 0) + 1 };
      await store.staff.updateOne(
        { _id: user._id },
        { $set: { mfa, authVersion: next.authVersion } },
        { session },
      );
      await store.sessions.deleteMany({ staffId: user._id }, { session });
      await store.staffMfaChallenges.deleteMany(
        { staffId: user._id },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "staff.mfa_enabled",
          staffId: user._id,
          by: user.username,
          at: new Date(),
        },
        { session },
      );
      return issueStaffSession(store, config, req, res, next, session);
    });
    res.json({ staff: identity, recoveryCodes });
  });
  for (const action of ["disable", "recovery-codes"])
    api.post("/mfa/" + action, limited, async (req, res) => {
      const input = body(
          z.strictObject({ currentPassword: passwordInput, code: codeInput }),
          req.body,
        ),
        authenticated = await currentUser(req, input.currentPassword),
        recoveryCodes = action === "recovery-codes" ? recoverySet() : [];
      const result = await transaction(store, async (session) => {
        const user = await store.staff.findOneAndUpdate(
          { _id: authenticated._id, active: true },
          { $inc: { mfaRevision: 1 } },
          { session, returnDocument: "after" },
        );
        if (
          !user ||
          (user.authVersion || 0) !== (authenticated.authVersion || 0)
        )
          throw new HttpError(
            409,
            "ACCESS_CHANGED",
            "Sign in again before changing two-factor authentication.",
          );
        const checked = await checkFactor(
          store,
          user,
          input.code,
          config,
          session,
        );
        if (checked.failed) return checked;
        const mfa =
            action === "disable"
              ? null
              : {
                  ...checked.mfa,
                  recovery: recoveryCodes.map((code) =>
                    hash(normalizeCode(code)),
                  ),
                },
          next = { ...user, mfa, authVersion: (user.authVersion || 0) + 1 };
        await store.staff.updateOne(
          { _id: user._id },
          { $set: { mfa, authVersion: next.authVersion } },
          { session },
        );
        await store.sessions.deleteMany({ staffId: user._id }, { session });
        await store.staffMfaChallenges.deleteMany(
          { staffId: user._id },
          { session },
        );
        await store.audit.insertOne(
          {
            type:
              action === "disable"
                ? "staff.mfa_disabled"
                : "staff.recovery_codes_rotated",
            staffId: user._id,
            by: user.username,
            at: new Date(),
          },
          { session },
        );
        return {
          staff: await issueStaffSession(
            store,
            config,
            req,
            res,
            next,
            session,
          ),
        };
      });
      factorError(result);
      res.json({
        ...result,
        ...(recoveryCodes.length ? { recoveryCodes } : {}),
      });
    });
  api.post("/team/:id/mfa-reset", requireAdmin, limited, async (req, res) => {
    const input = body(
        z.strictObject({
          currentPassword: passwordInput,
          code: z.string().max(80).default(""),
          confirmUsername: z.string().min(1).max(32),
          reason: z.string().trim().min(3).max(160),
        }),
        req.body,
      ),
      actor = await currentUser(req, input.currentPassword),
      id = requireId(req.params.id);
    if (actor._id.equals(id))
      throw new HttpError(
        409,
        "OWN_MFA",
        "Use your own two-factor settings or an unused recovery code.",
      );
    const result = await transaction(store, async (session) => {
      const admin = await store.staff.findOneAndUpdate(
        { _id: actor._id, active: true },
        { $inc: { mfaRevision: 1 } },
        { session, returnDocument: "after" },
      );
      if (
        !admin ||
        (admin.authVersion || 0) !== (actor.authVersion || 0) ||
        effectiveStaff(admin, store.branchId).role !== "admin"
      )
        throw new HttpError(401, "STAFF_REQUIRED", "Your access changed.");
      if (admin.mfa?.enabled) {
        const checked = await checkFactor(
          store,
          admin,
          input.code,
          config,
          session,
        );
        if (checked.failed) return checked;
      }
      const existing = await store.staff.findOne({ _id: id }, { session });
      if (!existing)
        throw new HttpError(404, "NOT_FOUND", "Staff account not found.");
      assertManageStaff(admin, existing, store.branchId);
      const target = await store.staff.findOneAndUpdate(
        { _id: id, username: input.confirmUsername, "mfa.enabled": true },
        {
          $set: { mfa: null, mustChangePassword: true },
          $inc: { authVersion: 1 },
        },
        { session },
      );
      if (!target)
        throw new HttpError(
          409,
          "MFA_RESET",
          "Confirm the username of an account with enabled two-factor authentication.",
        );
      await store.sessions.deleteMany({ staffId: id }, { session });
      await store.staffMfaChallenges.deleteMany({ staffId: id }, { session });
      await store.staffMfaEnrollments.deleteOne({ _id: id }, { session });
      await store.audit.insertOne(
        {
          type: "staff.mfa_reset",
          staffId: id,
          by: admin.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return { reset: true };
    });
    factorError(result);
    res.json(result);
  });
}
