import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, post, ok, error, password, key } from "./support.js";
const tokenFrom = (message) =>
  new URLSearchParams(
    new URL(message.text.match(/https?:\/\/\S+/)[0]).hash.slice(1),
  ).get("token");

test("local outbox stores real one-use mail privately and never serves it as a public page", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "angar-mail-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, {
      mail: { mode: "outbox", outboxDir: directory },
      production: false,
    }),
    guest = f.browser();
  await f.account(guest);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const file = path.join(directory, files[0]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const mail = JSON.parse(await readFile(file, "utf8"));
  assert.ok(mail.subject.includes("Verify"));
  ok(
    await post(guest, "/api/account/verify-email", { token: tokenFrom(mail) }),
  );
  assert.equal((await guest("/data/mail-outbox/" + files[0])).status, 404);
});

test("email verification is explicit, purpose-bound, expires and can only be used once", async (t) => {
  const messages = [],
    f = await fixture(t, { mailer: async (mail) => messages.push(mail) }),
    guest = f.browser();
  const account = await f.account(guest);
  assert.equal(account.emailVerified, false);
  assert.equal(messages.length, 1);
  const token = tokenFrom(messages[0]);
  assert.equal(
    (
      await f.store.accountTokens.findOne({
        customerId: (await f.store.customers.findOne({ email: account.email }))
          ._id,
      })
    )._id.includes(token),
    false,
  );
  error(
    await post(guest, "/api/account/reset-password", {
      token,
      newPassword: password,
    }),
    400,
    "INVALID_LINK",
  );
  ok(await post(guest, "/api/account/verify-email", { token }));
  assert.equal(ok(await guest("/api/account")).customer.emailVerified, true);
  error(
    await post(guest, "/api/account/verify-email", { token }),
    400,
    "INVALID_LINK",
  );
  const other = f.browser();
  await f.account(other);
  const expired = tokenFrom(messages.at(-1));
  await f.store.accountTokens.updateMany(
    {},
    { $set: { expiresAt: new Date(0) } },
  );
  error(
    await post(other, "/api/account/verify-email", { token: expired }),
    400,
    "INVALID_LINK",
  );
});

test("password recovery hides account existence and revokes all sessions and old links", async (t) => {
  const messages = [],
    f = await fixture(t, { mailer: async (mail) => messages.push(mail) }),
    first = f.browser(),
    second = f.browser();
  const account = await f.account(first);
  ok(
    await post(second, "/api/account/login", {
      email: account.email,
      password,
    }),
  );
  const existing = ok(
    await post(first, "/api/account/forgot-password", { email: account.email }),
  );
  const missing = ok(
    await post(first, "/api/account/forgot-password", {
      email: key() + "@example.test",
    }),
  );
  assert.deepEqual(existing, missing);
  const token = tokenFrom(messages.at(-1));
  const newPassword = "Recovered-customer-password-456!";
  ok(await post(first, "/api/account/reset-password", { token, newPassword }));
  assert.equal(ok(await first("/api/account")).customer, null);
  assert.equal(ok(await second("/api/account")).customer, null);
  error(
    await post(second, "/api/account/login", {
      email: account.email,
      password,
    }),
    401,
  );
  const current = ok(
    await post(second, "/api/account/login", {
      email: account.email,
      password: newPassword,
    }),
  ).customer;
  assert.equal(current.emailVerified, true);
  error(
    await post(first, "/api/account/reset-password", { token, newPassword }),
    400,
    "INVALID_LINK",
  );
  error(
    await post(first, "/api/account/verify-email", {
      token: tokenFrom(messages[0]),
    }),
    400,
    "INVALID_LINK",
  );
});

test("email outages do not lose registration or reveal reset tokens; unavailable mail is explicit", async (t) => {
  const f = await fixture(t, {
      mailer: async () => {
        throw Error("simulated SMTP outage");
      },
    }),
    guest = f.browser();
  const registered = await f.account(guest);
  assert.ok(registered.id);
  assert.equal(await f.store.accountTokens.countDocuments({}), 0);
  const result = ok(
    await post(guest, "/api/account/forgot-password", {
      email: registered.email,
    }),
  );
  assert.equal(result.token, undefined);
  const off = await fixture(t, { mail: { mode: "off" } }),
    other = off.browser();
  await off.account(other);
  error(await post(other, "/api/account/verification"), 503, "MAIL_SETUP");
  assert.equal(ok(await other("/api/account")).mail.enabled, false);
});
