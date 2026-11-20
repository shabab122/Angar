import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createECDH } from "node:crypto";
import { ObjectId } from "mongodb";
import * as webpush from "web-push";
import { fixture, post, patch, ok, error, key } from "./support.js";
import {
  scanNotifications,
  runNotificationJobs,
} from "../server/notifications.js";

test("opted-in order emails and private inbox notices deduplicate and suppress obsolete states", async (t) => {
  const mails = [],
    f = await fixture(t, { mailer: async (message) => mails.push(message) }),
    guest = f.browser(),
    outsider = f.browser();
  const customer = await f.account(guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(customer.id) },
    { $set: { emailVerifiedAt: new Date() } },
  );
  ok(await guest("/api/notifications/preferences"));
  ok(
    await patch(guest, "/api/notifications/preferences", {
      inApp: true,
      email: true,
      sms: false,
      push: false,
      language: "en",
    }),
  );
  const order = await f.order(guest, await f.open());
  await scanNotifications(f.store, f.config);
  await scanNotifications(f.store, f.config);
  assert.equal(await f.store.notificationsInbox.countDocuments({}), 1);
  ok(
    await post(f.staff.admin, "/api/staff/orders/" + order.id + "/action", {
      action: "send",
    }),
  );
  await scanNotifications(f.store, f.config);
  await runNotificationJobs(f.store, f.config);
  assert.equal(
    mails.filter((message) => message.subject === "Angar update").length,
    1,
  );
  assert.ok(mails.at(-1).text.includes("accepted by staff"));
  assert.equal(
    ok(await outsider("/api/notifications")).notifications.length,
    0,
  );
  assert.equal(ok(await guest("/api/notifications")).notifications.length, 2);
  ok(await post(guest, "/api/account/logout"), 204);
  assert.equal(ok(await guest("/api/notifications")).notifications.length, 0);
});

test("SMS requires verified phone ownership, has bounded code attempts and sends only after opt-in", async (t) => {
  const messages = [],
    f = await fixture(t, {
      smsTransport: async (message) => {
        messages.push(message);
        return { reference: "controlled-sms" };
      },
    }),
    guest = f.browser();
  ok(await guest("/api/notifications/preferences"));
  error(
    await patch(guest, "/api/notifications/preferences", {
      inApp: true,
      email: false,
      sms: true,
      push: false,
      language: "en",
    }),
    409,
    "PHONE_VERIFY",
  );
  ok(
    await post(guest, "/api/notifications/phone-code", {
      phone: "01700000000",
      consent: true,
    }),
  );
  await runNotificationJobs(f.store, f.config);
  const code = messages[0].text.match(/\b\d{6}\b/)[0];
  error(
    await post(guest, "/api/notifications/phone-verify", { code: "000000" }),
    400,
    "PHONE_CODE",
  );
  assert.equal(
    ok(await post(guest, "/api/notifications/phone-verify", { code })).phone,
    "+8801700000000",
  );
  ok(
    await patch(guest, "/api/notifications/preferences", {
      inApp: true,
      email: false,
      sms: true,
      push: false,
      language: "en",
    }),
  );
  await f.order(guest, await f.open());
  await scanNotifications(f.store, f.config);
  await runNotificationJobs(f.store, f.config);
  assert.equal(messages.length, 2);
  assert.ok(messages[1].text.includes("received"));
  await runNotificationJobs(f.store, f.config);
  assert.equal(messages.length, 2);
});

test("reservation reminders are emitted once and cancelled reservations suppress queued reminders", async (t) => {
  const mails = [],
    f = await fixture(t, { mailer: async (message) => mails.push(message) }),
    guest = f.browser();
  await f.account(guest);
  ok(await guest("/api/notifications/preferences"));
  const customer = (await f.store.customers.findOne({}))._id,
    now = new Date();
  await f.store.customers.updateOne(
    { _id: customer },
    { $set: { emailVerifiedAt: now } },
  );
  ok(
    await patch(guest, "/api/notifications/preferences", {
      inApp: true,
      email: true,
      sms: false,
      push: false,
      language: "en",
    }),
  );
  await f.store.reservations.insertOne({
    _id: new ObjectId(),
    code: "RS-REMINDER",
    customerId: customer,
    actorKey: "customer:" + customer,
    requestKey: key(),
    status: "confirmed",
    startsAt: new Date(now.getTime() + 30 * 60000),
    createdAt: new Date(now.getTime() + 10),
  });
  await scanNotifications(f.store, f.config, now);
  await scanNotifications(f.store, f.config, now);
  const rows = ok(await guest("/api/notifications")).notifications;
  assert.equal(rows.filter((row) => row.title.includes("reminder")).length, 1);
  await f.store.reservations.updateOne(
    { code: "RS-REMINDER" },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
  );
  await runNotificationJobs(f.store, f.config);
  assert.equal(
    mails.filter((message) => message.subject.includes("reminder")).length,
    0,
  );
  assert.equal(
    (await f.store.notificationJobs.findOne({ expectedStatus: "confirmed" }))
      .status,
    "skipped",
  );
});

test("push subscriptions reject private endpoints and valid encrypted push contracts carry no plaintext payload", async (t) => {
  const pair = webpush.generateVAPIDKeys(),
    delivered = [],
    f = await fixture(t, {
      push: { enabled: true, ...pair, subject: "mailto:test@example.test" },
      pushTransport: async (subscription, text) =>
        delivered.push(JSON.parse(text)),
    }),
    guest = f.browser();
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/controlled-test",
    expirationTime: null,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  error(
    await post(guest, "/api/notifications/push", {
      ...subscription,
      endpoint: "https://127.0.0.1/internal",
    }),
    400,
    "PUSH_ENDPOINT",
  );
  ok(await post(guest, "/api/notifications/push", subscription), 201);
  const request = webpush.generateRequestDetails(
    subscription,
    "controlled secret payload",
    {
      vapidDetails: { subject: "mailto:test@example.test", ...pair },
      TTL: 300,
    },
  );
  assert.equal(
    request.body.includes(Buffer.from("controlled secret payload")),
    false,
  );
  await f.order(guest, await f.open());
  await scanNotifications(f.store, f.config);
  await runNotificationJobs(f.store, f.config);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].url, "/orders");
});

test("phone code requests serialize cooldowns and Twilio submission uses the verified API contract", async (t) => {
  const sent = [],
    accountSid = "AC" + "a".repeat(32),
    from = "+15005550006";
  const f = await fixture(t, {
      sms: { mode: "twilio", accountSid, token: "test-only-token", from },
      notificationFetch: async (url, options) => {
        assert.equal(
          url,
          "https://api.twilio.com/2010-04-01/Accounts/" +
            accountSid +
            "/Messages.json",
        );
        assert.equal(
          options.headers.Authorization,
          "Basic " +
            Buffer.from(accountSid + ":test-only-token").toString("base64"),
        );
        const fields = new URLSearchParams(options.body);
        assert.equal(fields.get("From"), from);
        assert.equal(fields.get("To"), "+8801700000000");
        sent.push(fields.get("Body"));
        return new Response(
          JSON.stringify({ sid: "SM" + "b".repeat(32), status: "queued" }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    }),
    guest = f.browser();
  ok(await guest("/api/notifications/preferences"));
  const requests = await Promise.all([
    post(guest, "/api/notifications/phone-code", {
      phone: "01700000000",
      consent: true,
    }),
    post(guest, "/api/notifications/phone-code", {
      phone: "01700000000",
      consent: true,
    }),
  ]);
  assert.deepEqual(requests.map((row) => row.status).sort(), [200, 429]);
  await runNotificationJobs(f.store, f.config);
  assert.equal(sent.length, 1);
  const job = await f.store.notificationJobs.findOne({
    kind: "phone_verification",
  });
  assert.equal(job.status, "submitted");
  assert.equal(job.text, undefined);
  ok(
    await post(guest, "/api/notifications/phone-verify", {
      code: sent[0].match(/\b\d{6}\b/)[0],
    }),
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/notifications/" + job._id + "/retry",
      { confirmed: true, reason: "No code may be resent by staff" },
    ),
    409,
    "MESSAGE_STATE",
  );
});

test("uncertain sends wait for reviewed retry and opt-out suppresses queued deliveries", async (t) => {
  let fail = false,
    delivered = 0;
  const f = await fixture(t, {
      mailer: async () => {
        if (fail) throw Error("Controlled ambiguous transport failure");
        delivered++;
      },
    }),
    guest = f.browser(),
    member = await f.account(guest);
  await f.store.customers.updateOne(
    { _id: new ObjectId(member.id) },
    { $set: { emailVerifiedAt: new Date() } },
  );
  ok(
    await patch(guest, "/api/notifications/preferences", {
      inApp: true,
      email: true,
      sms: false,
      push: false,
      language: "en",
    }),
  );
  fail = true;
  await f.order(guest, await f.open());
  await scanNotifications(f.store, f.config);
  await runNotificationJobs(f.store, f.config);
  const job = await f.store.notificationJobs.findOne({ channel: "email" });
  assert.equal(job.status, "unknown");
  await runNotificationJobs(f.store, f.config);
  assert.equal(
    (await f.store.notificationJobs.findOne({ _id: job._id })).attempts,
    1,
  );
  fail = false;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/notifications/" + job._id + "/retry",
      {
        confirmed: true,
        reason: "Controlled provider confirmed first attempt was not sent",
      },
    ),
  );
  await runNotificationJobs(f.store, f.config);
  assert.equal(
    (await f.store.notificationJobs.findOne({ _id: job._id })).status,
    "submitted",
  );
  const before = delivered;
  await f.order(guest, await f.open("T02"));
  await scanNotifications(f.store, f.config);
  ok(
    await patch(guest, "/api/notifications/preferences", {
      inApp: true,
      email: false,
      sms: false,
      push: false,
      language: "en",
    }),
  );
  await runNotificationJobs(f.store, f.config);
  assert.equal(delivered, before);
});
