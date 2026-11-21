import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { fixture, post, ok, error, password } from "./support.js";

async function setup(t, policy = false) {
  let timestamp = Math.floor(Date.now() / 30000) * 30000 + 5000;
  const f = await fixture(t, {
    staffMfa: { key: randomBytes(32).toString("hex"), requireAdmin: policy },
    mfaNow: () => timestamp,
  });
  return { ...f, advance: () => (timestamp += 30000), time: () => timestamp };
}
async function enroll(f, role = "admin") {
  const result = ok(
    await post(f.staff[role], "/api/staff/mfa/begin", {
      currentPassword: password,
    }),
  );
  assert.ok(result.qr.startsWith("data:image/png;base64,"));
  assert.ok(result.uri.startsWith("otpauth://totp/"));
  const totp = new OTPAuth.TOTP({ secret: result.secret }),
    code = () => totp.generate({ timestamp: f.time() });
  const enabled = ok(
    await post(f.staff[role], "/api/staff/mfa/enable", { code: code() }),
  );
  assert.equal(enabled.recoveryCodes.length, 10);
  assert.equal(enabled.staff.mfaEnabled, true);
  return { ...enabled, secret: result.secret, code };
}
test("authenticator enrollment encrypts its seed, hides recovery material and revokes other staff sessions", async (t) => {
  const f = await setup(t),
    other = f.browser();
  ok(await post(other, "/api/staff/login", { username: "admin", password }));
  const enrollment = await enroll(f),
    user = await f.store.staff.findOne({ username: "admin" });
  assert.equal(JSON.stringify(user).includes(enrollment.secret), false);
  assert.equal(
    JSON.stringify(user).includes(enrollment.recoveryCodes[0]),
    false,
  );
  error(await other("/api/staff/me"), 401);
  assert.equal(ok(await f.staff.admin("/api/staff/me")).mfaEnabled, true);
  const team = ok(await f.staff.admin("/api/staff/team"));
  assert.equal(JSON.stringify(team).includes(enrollment.secret), false);
  ok(await post(f.staff.admin, "/api/staff/logout"), 204);
  assert.equal(
    ok(
      await post(f.staff.admin, "/api/staff/login", {
        username: "admin",
        password,
      }),
    ).needsMfa,
    true,
  );
  error(await f.staff.admin("/api/staff/me"), 401);
  error(
    await post(other, "/api/staff/login/verify", { code: enrollment.code() }),
    401,
    "MFA_CHALLENGE",
  );
  error(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.code(),
    }),
    400,
    "MFA_CODE",
  );
  f.advance();
  const fresh = enrollment.code();
  assert.equal(
    ok(await post(f.staff.admin, "/api/staff/login/verify", { code: fresh }))
      .mfaEnabled,
    true,
  );
  error(
    await post(f.staff.admin, "/api/staff/login/verify", { code: fresh }),
    401,
    "MFA_CHALLENGE",
  );
  const audit = ok(await f.staff.admin("/api/staff/audit"));
  assert.equal(JSON.stringify(audit).includes(enrollment.secret), false);
  assert.equal(JSON.stringify(audit).includes(fresh), false);
});
test("recovery codes are single-use under concurrent login attempts and enrollment is browser-bound", async (t) => {
  const f = await setup(t),
    another = f.browser();
  ok(await post(another, "/api/staff/login", { username: "admin", password }));
  ok(
    await post(f.staff.admin, "/api/staff/mfa/begin", {
      currentPassword: password,
    }),
  );
  error(
    await post(another, "/api/staff/mfa/enable", { code: "123456" }),
    409,
    "MFA_ENROLLMENT",
  );
  const enrollment = await enroll(f);
  ok(await post(f.staff.admin, "/api/staff/logout"), 204);
  ok(
    await post(f.staff.admin, "/api/staff/login", {
      username: "admin",
      password,
    }),
  );
  const results = await Promise.all([
    post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
    post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
  ]);
  assert.equal(results.filter((row) => row.status === 200).length, 1);
  assert.equal(
    (await f.store.staff.findOne({ username: "admin" })).mfa.recovery.length,
    9,
  );
  ok(
    await post(f.staff.admin, "/api/staff/login", {
      username: "admin",
      password,
    }),
  );
  error(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
    400,
    "MFA_CODE",
  );
  ok(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[1],
    }),
  );
  error(
    await post(f.staff.admin, "/api/staff/mfa/disable", {
      currentPassword: password,
      code: "not-a-valid-code",
    }),
    400,
    "MFA_CODE",
  );
  ok(
    await post(f.staff.admin, "/api/staff/mfa/disable", {
      currentPassword: password,
      code: enrollment.recoveryCodes[2],
    }),
  );
  assert.equal(ok(await f.staff.admin("/api/staff/mfa")).enabled, false);
});
test("administrator policy gates business access until enrollment and reset requires the administrator's own second factor", async (t) => {
  const f = await setup(t, true);
  error(await f.staff.admin("/api/staff/overview"), 403, "MFA_REQUIRED");
  const admin = await enroll(f),
    kitchen = await enroll(f, "kitchen");
  ok(await f.staff.admin("/api/staff/overview"));
  const user = await f.store.staff.findOne({ username: "kitchen" });
  const input = {
    currentPassword: password,
    confirmUsername: "kitchen",
    reason: "Device lost and identity verified by manager",
    code: "not-a-valid-code",
  };
  error(
    await post(
      f.staff.admin,
      "/api/staff/team/" + user._id + "/mfa-reset",
      input,
    ),
    400,
    "MFA_CODE",
  );
  f.advance();
  ok(
    await post(f.staff.admin, "/api/staff/team/" + user._id + "/mfa-reset", {
      ...input,
      code: admin.code(),
    }),
  );
  error(await f.staff.kitchen("/api/staff/me"), 401);
  assert.equal(
    (await f.store.staff.findOne({ _id: user._id })).mustChangePassword,
    true,
  );
  assert.equal(
    JSON.stringify(ok(await f.staff.admin("/api/staff/team"))).includes(
      kitchen.secret,
    ),
    false,
  );
});
test("five failed challenge guesses require restarting sign-in and recovery works with an unavailable encryption key", async (t) => {
  const f = await setup(t),
    enrollment = await enroll(f);
  ok(
    await post(f.staff.admin, "/api/staff/login", {
      username: "admin",
      password,
    }),
  );
  for (let i = 0; i < 5; i++)
    error(
      await post(f.staff.admin, "/api/staff/login/verify", { code: "INVALID" }),
      400,
      "MFA_CODE",
    );
  error(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
    401,
    "MFA_CHALLENGE",
  );
  ok(
    await post(f.staff.admin, "/api/staff/login", {
      username: "admin",
      password,
    }),
  );
  f.config.staffMfa.key = randomBytes(32).toString("hex");
  f.advance();
  error(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.code(),
    }),
    503,
    "MFA_KEY",
  );
  ok(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
  );
});

test("factor changes and sign-in share a persistent account lock that cannot consume recovery codes while locked", async (t) => {
  const f = await setup(t),
    enrollment = await enroll(f);
  for (let i = 0; i < 10; i++)
    error(
      await post(f.staff.admin, "/api/staff/mfa/recovery-codes", {
        currentPassword: password,
        code: "INVALID",
      }),
      400,
      "MFA_CODE",
    );
  const locked = await f.store.staff.findOne({ username: "admin" });
  assert.equal(locked.mfaFailures, 10);
  assert.ok(locked.mfaLockedUntil > new Date());
  error(
    await post(f.staff.admin, "/api/staff/mfa/disable", {
      currentPassword: password,
      code: enrollment.recoveryCodes[0],
    }),
    400,
    "MFA_LOCKED",
  );
  assert.equal(
    (await f.store.staff.findOne({ username: "admin" })).mfa.recovery.length,
    10,
  );
  ok(
    await post(f.staff.admin, "/api/staff/login", {
      username: "admin",
      password,
    }),
  );
  error(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
    400,
    "MFA_LOCKED",
  );
  assert.equal(
    (
      await f.store.staff.findOne({ username: "admin" })
    ).mfaLockedUntil.getTime(),
    locked.mfaLockedUntil.getTime(),
  );
  await f.store.staff.updateOne(
    { username: "admin" },
    { $set: { mfaLockedUntil: new Date(Date.now() - 1000) } },
  );
  ok(
    await post(f.staff.admin, "/api/staff/login/verify", {
      code: enrollment.recoveryCodes[0],
    }),
  );
  const unlocked = await f.store.staff.findOne({ username: "admin" });
  assert.equal(unlocked.mfaFailures, 0);
  assert.equal(unlocked.mfaLockedUntil, undefined);
  assert.equal(unlocked.mfa.recovery.length, 9);
});
