import { branchPath } from "./branches.js";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ECDH, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import * as webpush from "web-push";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { body, HttpError } from "./http.js";
import { getGuest, hash } from "./security.js";
import { mailReady, deliverMail } from "./account-mail.js";
import { transaction } from "./money.js";

export const notificationActor = (req, res, config) =>
  req.customer
    ? "customer:" + req.customer._id
    : "guest:" + getGuest(req, res, config);
const defaults = {
  inApp: true,
  email: false,
  sms: false,
  push: false,
  language: "en",
};
export const smsReady = (config) =>
  Boolean(
    config.smsTransport ||
    (config.sms?.mode === "outbox" && !config.production) ||
    (config.sms?.mode === "twilio" &&
      config.sms.accountSid &&
      config.sms.token &&
      config.sms.from),
  );
export const pushReady = (config) =>
  Boolean(
    config.pushTransport ||
    (config.push?.enabled &&
      config.push.publicKey &&
      config.push.privateKey &&
      config.push.subject),
  );
const statuses = {
  placed: ["received", "গ্রহণ করা হয়েছে"],
  queued: ["accepted by staff", "স্টাফ অনুমোদন করেছেন"],
  accepted: ["accepted by staff", "স্টাফ অনুমোদন করেছেন"],
  preparing: ["being prepared", "প্রস্তুত হচ্ছে"],
  ready: ["ready", "প্রস্তুত"],
  served: ["served", "পরিবেশন করা হয়েছে"],
  collected: ["collected", "বুঝে নেওয়া হয়েছে"],
  dispatched: ["out for delivery", "ডেলিভারির পথে"],
  delivered: ["delivered", "পৌঁছে দেওয়া হয়েছে"],
  cancelled: ["cancelled", "বাতিল হয়েছে"],
  confirmed: ["confirmed", "নিশ্চিত হয়েছে"],
  seated: ["seated", "টেবিলে বসানো হয়েছে"],
  notified: ["called by staff", "স্টাফ ডেকেছেন"],
};
const metadata = (config) => ({
  email: mailReady(config),
  sms: smsReady(config),
  push: pushReady(config),
  publicKey: config.push?.publicKey || "",
  smsMode: config.sms?.mode || "off",
});
const phoneNumber = (input) => {
  let number = String(input).replace(/[\s()-]/g, "");
  if (/^01[3-9]\d{8}$/.test(number)) number = "+880" + number.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(number))
    throw new HttpError(
      400,
      "INVALID_PHONE",
      "Use an international phone number, for example +88017XXXXXXXX.",
    );
  return number;
};
function pushEndpoint(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !(
      host === "fcm.googleapis.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host === "updates.push.services.mozilla.com" ||
      host.endsWith(".push.apple.com") ||
      host.endsWith(".notify.windows.com")
    )
  )
    throw new HttpError(
      400,
      "PUSH_ENDPOINT",
      "Use a subscription issued by a supported browser push service.",
    );
  return url.href;
}
async function sms(config, to, text) {
  if (config.smsTransport) return config.smsTransport({ to, text });
  if (config.sms.mode === "outbox" && !config.production) {
    await mkdir(config.sms.outboxDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(
        config.sms.outboxDir,
        Date.now() + "-" + randomBytes(8).toString("hex") + ".json",
      ),
      JSON.stringify(
        { channel: "sms", to, text, createdAt: new Date() },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    return { status: "local_outbox" };
  }
  const response = await (config.notificationFetch || fetch)(
    "https://api.twilio.com/2010-04-01/Accounts/" +
      config.sms.accountSid +
      "/Messages.json",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(config.sms.accountSid + ":" + config.sms.token).toString(
            "base64",
          ),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: config.sms.from,
        Body: text,
      }).toString(),
    },
  );
  if (!response.ok)
    throw new HttpError(
      503,
      "SMS_PROVIDER",
      "SMS provider did not confirm acceptance. Review the message before retrying.",
    );
  const result = await response.json();
  if (!/^SM[a-fA-F0-9]{32}$/.test(result.sid))
    throw new HttpError(
      503,
      "SMS_PROVIDER",
      "SMS provider did not return a message identifier.",
    );
  return { reference: result.sid, status: result.status };
}

async function queueNotice(
  store,
  preference,
  source,
  id,
  status,
  stamp,
  details,
) {
  if (stamp < preference.sinceAt) return;
  const key = hash(preference._id + ":" + source + ":" + id + ":" + status),
    now = new Date();
  await transaction(store, async (session) => {
    const current = await store.notificationPreferences.findOneAndUpdate(
      { _id: preference._id, generation: preference.generation },
      { $inc: { scanRevision: 1 } },
      { session, returnDocument: "after" },
    );
    if (
      !current ||
      (await store.notificationsInbox.findOne({ _id: key }, { session }))
    )
      return;
    const entry = {
      _id: key,
      actorKey: current._id,
      ...details,
      createdAt: now,
      read: false,
      expiresAt: new Date(now.getTime() + 30 * 86400000),
    };
    await store.notificationsInbox.insertOne(entry, { session });
    const jobs = [];
    if (current.email && current.emailAddress)
      jobs.push({ channel: "email", to: current.emailAddress });
    if (current.sms && current.verifiedPhone)
      jobs.push({ channel: "sms", to: current.verifiedPhone });
    if (current.push)
      for (const subscription of await store.pushSubscriptions
        .find({ actorKey: current._id }, { session })
        .toArray())
        jobs.push({ channel: "push", to: subscription._id });
    for (const delivery of jobs)
      await store.notificationJobs.updateOne(
        { _id: hash(key + ":" + delivery.channel + ":" + delivery.to) },
        {
          $setOnInsert: {
            ...delivery,
            noticeId: key,
            actorKey: current._id,
            generation: current.generation,
            source,
            sourceId: id,
            expectedStatus: status === "reminder" ? "confirmed" : status,
            title: details.title,
            text: details.text,
            href: details.href,
            status: "queued",
            attempts: 0,
            dueAt: now,
            createdAt: now,
            expiresAt: details.expiresAt || new Date(now.getTime() + 86400000),
          },
        },
        { upsert: true, session },
      );
  });
}
const updated = (row) =>
  new Date(
    Math.max(
      ...[
        row.updatedAt,
        row.createdAt,
        row.cancelledAt,
        row.seatedAt,
        row.notifiedAt,
        row.completedAt,
        row.noShowAt,
      ]
        .filter(Boolean)
        .map((value) => new Date(value).getTime()),
    ),
  );
export async function scanNotifications(store, config, now = new Date()) {
  const preferences = await store.notificationPreferences
    .find({})
    .sort({ lastScannedAt: 1 })
    .limit(100)
    .toArray();
  for (const preference of preferences) {
    const filter = preference.customerId
      ? { customerId: preference.customerId }
      : { guestHash: preference.guestHash, customerId: null };
    const bn = preference.language === "bn";
    for (const [source, collection, href] of [
      ["order", store.orders, "/orders"],
      ["fulfillment", store.fulfillments, "/takeaway"],
      ["reservation", store.reservations, "/reservations"],
      ["waitlist", store.waitlist, "/reservations"],
    ]) {
      const records = await collection
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();
      for (const row of records) {
        if (statuses[row.status]) {
          const code = row.code || "Your waiting party",
            label = statuses[row.status][bn ? 1 : 0];
          await queueNotice(
            store,
            preference,
            source,
            row._id,
            row.status,
            updated(row),
            {
              title: bn ? "আঙার আপডেট" : "Angar update",
              text: bn
                ? code + " — " + label + "।"
                : code + " is " + label + ".",
              href,
            },
          );
        }
        if (
          source === "reservation" &&
          row.status === "confirmed" &&
          row.startsAt > now &&
          row.startsAt <= new Date(now.getTime() + 3600000)
        ) {
          const time = new Intl.DateTimeFormat(bn ? "bn-BD" : "en-BD", {
            timeZone: "Asia/Dhaka",
            hour: "numeric",
            minute: "2-digit",
          }).format(row.startsAt);
          await queueNotice(
            store,
            preference,
            source,
            row._id,
            "reminder",
            row.startsAt,
            {
              title: bn
                ? "টেবিল বুকিং মনে করিয়ে দিচ্ছি"
                : "Your table reservation reminder",
              text:
                row.code +
                (bn ? " — আপনার বুকিং " : " — your reservation is at ") +
                time +
                (bn ? " (বাংলাদেশ সময়)।" : " (Bangladesh time)."),
              href,
              expiresAt: row.startsAt,
            },
          );
        }
      }
    }
    await store.notificationPreferences.updateOne(
      { _id: preference._id },
      { $set: { lastScannedAt: now } },
    );
  }
}

async function deliverJob(store, config, job) {
  if (job.expiresAt <= new Date())
    return { status: "skipped", message: "Message expired before delivery." };
  const preference = await store.notificationPreferences.findOne({
    _id: job.actorKey,
  });
  if (job.kind === "phone_verification") {
    const challenge = await store.phoneChallenges.findOne({
      _id: job.actorKey,
      nonce: job.nonce,
      expiresAt: { $gt: new Date() },
    });
    if (!challenge)
      return {
        status: "skipped",
        message: "Phone verification is no longer current.",
      };
    if (!smsReady(config))
      return { status: "failed", message: "SMS delivery is not configured." };
    const result = await sms(config, job.to, job.text);
    return {
      status: "submitted",
      providerReference: result.reference || "",
      message:
        result.status === "local_outbox"
          ? "Saved to the private local SMS outbox."
          : "Phone code submitted to SMS provider.",
    };
  }
  if (
    !preference ||
    preference.generation !== job.generation ||
    !preference[job.channel]
  )
    return { status: "skipped", message: "Recipient preferences changed." };
  const collection = {
    order: store.orders,
    fulfillment: store.fulfillments,
    reservation: store.reservations,
    waitlist: store.waitlist,
  }[job.source];
  const ownership = preference.customerId
    ? { customerId: preference.customerId }
    : { guestHash: preference.guestHash, customerId: null };
  const current =
    collection &&
    (await collection.findOne({ _id: job.sourceId, ...ownership }));
  if (!current || current.status !== job.expectedStatus)
    return {
      status: "skipped",
      message: "A newer order or reservation state replaced this message.",
    };
  if (
    preference.customerId &&
    !(await store.customers.findOne(
      { _id: preference.customerId, active: true },
      { projection: { _id: 1 } },
    ))
  )
    return {
      status: "skipped",
      message: "Customer account is no longer active.",
    };
  if (job.channel === "email") {
    const customer =
      preference.customerId &&
      (await store.customers.findOne({
        _id: preference.customerId,
        active: true,
        emailVerifiedAt: { $type: "date" },
      }));
    if (!customer || customer.email !== job.to || !mailReady(config))
      return {
        status: "failed",
        message: "Verified email delivery is unavailable.",
      };
    await deliverMail(config, {
      to: job.to,
      subject: job.title,
      text:
        job.text +
        "\n\n" +
        config.origin +
        branchPath(job.href, config.branchId),
    });
  } else if (job.channel === "sms") {
    if (preference.verifiedPhone !== job.to || !smsReady(config))
      return {
        status: "failed",
        message: "Verified SMS delivery is unavailable.",
      };
    const result = await sms(config, job.to, job.text);
    return {
      status: "submitted",
      providerReference: result.reference || "",
      message:
        result.status === "local_outbox"
          ? "Saved to the private local SMS outbox."
          : "Submitted to SMS provider; this is not a delivery receipt.",
    };
  } else {
    const subscription = await store.pushSubscriptions.findOne({
      _id: job.to,
      actorKey: job.actorKey,
    });
    if (!subscription || !pushReady(config))
      return {
        status: "failed",
        message: "This device no longer has an active push subscription.",
      };
    const payload = JSON.stringify({
      title: job.title,
      body: job.text,
      url: branchPath(job.href, config.branchId),
      tag: job.noticeId,
    });
    try {
      if (config.pushTransport)
        await config.pushTransport(subscription.subscription, payload);
      else
        await webpush.sendNotification(subscription.subscription, payload, {
          vapidDetails: {
            subject: config.push.subject,
            publicKey: config.push.publicKey,
            privateKey: config.push.privateKey,
          },
          TTL: 300,
          timeout: 10000,
        });
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await store.pushSubscriptions.deleteOne({ _id: subscription._id });
        return {
          status: "failed",
          message: "Push subscription expired; enable this device again.",
        };
      }
      throw error;
    }
  }
  return {
    status: "submitted",
    message:
      "Submitted to the configured provider; actual delivery/display is not guaranteed.",
  };
}
export async function runNotificationJobs(store, config, now = new Date()) {
  // A crashed send may already have reached a provider. It needs explicit review,
  // rather than automatically sending a second copy after a lease expires.
  await store.notificationJobs.updateMany(
    { status: "sending", leaseUntil: { $lt: now } },
    {
      $set: {
        status: "unknown",
        message:
          "Send outcome uncertain after interruption. Review before retrying.",
      },
    },
  );
  for (let index = 0; index < 8; index++) {
    const job = await store.notificationJobs.findOneAndUpdate(
      { status: "queued", dueAt: { $lte: now } },
      {
        $set: {
          status: "sending",
          leaseUntil: new Date(now.getTime() + 60000),
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    if (!job) break;
    let result;
    try {
      result = await deliverJob(store, config, job);
    } catch {
      result = {
        status: "unknown",
        message:
          "Provider did not confirm the outcome. Review before retrying to avoid duplicate alerts.",
      };
    }
    await store.notificationJobs.updateOne(
      { _id: job._id, status: "sending" },
      {
        $set: { ...result, completedAt: new Date() },
        ...(job.kind === "phone_verification" ? { $unset: { text: "" } } : {}),
      },
    );
  }
}

export function registerNotifications(api, store, config) {
  const limited = rateLimit({
    windowMs: 15 * 60000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMIT",
        message: "Too many phone verification attempts. Please wait.",
      },
    },
  });
  async function ensure(req, res) {
    const actorKey = notificationActor(req, res, config);
    return store.notificationPreferences.findOneAndUpdate(
      { _id: actorKey },
      {
        $setOnInsert: {
          ...defaults,
          sinceAt: new Date(),
          generation: 0,
          ...(req.customer
            ? { customerId: req.customer._id }
            : { guestHash: getGuest(req, res, config) }),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  }
  api.get("/notifications/preferences", async (req, res) => {
    const preference = await ensure(req, res);
    res.json({
      preferences: Object.fromEntries(
        [...Object.keys(defaults), "verifiedPhone"].map((key) => [
          key,
          preference[key] ?? (key === "verifiedPhone" ? "" : defaults[key]),
        ]),
      ),
      providers: metadata(config),
      emailVerified: Boolean(req.customer?.emailVerifiedAt),
      email: req.customer?.email || "",
    });
  });
  api.patch("/notifications/preferences", async (req, res) => {
    const input = body(
        z.strictObject({
          inApp: z.boolean(),
          email: z.boolean(),
          sms: z.boolean(),
          push: z.boolean(),
          language: z.enum(["en", "bn"]),
        }),
        req.body,
      ),
      preference = await ensure(req, res);
    if (input.email && (!req.customer?.emailVerifiedAt || !mailReady(config)))
      throw new HttpError(
        409,
        "EMAIL_VERIFY",
        "Verify your account email and configure email delivery first.",
      );
    if (input.sms && (!preference.verifiedPhone || !smsReady(config)))
      throw new HttpError(
        409,
        "PHONE_VERIFY",
        "Verify your phone and configure SMS delivery first.",
      );
    if (
      input.push &&
      (!pushReady(config) ||
        !(await store.pushSubscriptions.findOne({ actorKey: preference._id })))
    )
      throw new HttpError(
        409,
        "PUSH_SETUP",
        "Enable a push-capable device first.",
      );
    await store.notificationPreferences.updateOne(
      { _id: preference._id },
      {
        $set: {
          ...input,
          emailAddress: req.customer?.email || "",
          sinceAt: new Date(),
        },
        $inc: { generation: 1 },
      },
    );
    res.json({ saved: true });
  });
  api.get("/notifications", async (req, res) => {
    const actorKey = notificationActor(req, res, config),
      preference = await store.notificationPreferences.findOne({
        _id: actorKey,
      });
    const rows =
      preference?.inApp === false
        ? []
        : await store.notificationsInbox
            .find({ actorKey })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
    res.json({
      notifications: rows.map(
        ({ _id, title, text, href, read, createdAt }) => ({
          id: _id,
          title,
          text,
          href: branchPath(href, config.branchId),
          read,
          createdAt,
        }),
      ),
    });
  });
  api.post("/notifications/read", async (req, res) => {
    const input = body(
      z.strictObject({
        ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
      }),
      req.body,
    );
    await store.notificationsInbox.updateMany(
      {
        actorKey: notificationActor(req, res, config),
        _id: { $in: input.ids },
      },
      { $set: { read: true } },
    );
    res.status(204).end();
  });
  api.post("/notifications/phone-code", limited, async (req, res) => {
    if (!smsReady(config))
      throw new HttpError(503, "SMS_SETUP", "Configure SMS delivery first.");
    const input = body(
        z.strictObject({
          phone: z.string().min(7).max(25),
          consent: z.literal(true),
        }),
        req.body,
      ),
      phone = phoneNumber(input.phone),
      preference = await ensure(req, res),
      now = new Date();
    const date = now.toISOString().slice(0, 10),
      quotaKey = hash(phone) + ":" + date;
    const nonce = randomBytes(16).toString("hex"),
      code = String(randomInt(100000, 1000000)),
      expiresAt = new Date(now.getTime() + 5 * 60000);
    await transaction(store, async (session) => {
      const old = await store.phoneChallenges.findOneAndUpdate(
        { _id: preference._id },
        { $inc: { revision: 1 } },
        { upsert: true, session, returnDocument: "after" },
      );
      if (old.requestedAt > new Date(now.getTime() - 60000))
        throw new HttpError(
          429,
          "RATE_LIMIT",
          "Wait one minute before requesting another code.",
        );
      try {
        const quota = await store.phoneSendLimits.findOneAndUpdate(
          { _id: quotaKey, count: { $lt: 5 } },
          {
            $inc: { count: 1 },
            $setOnInsert: { expiresAt: new Date(now.getTime() + 2 * 86400000) },
          },
          { upsert: true, returnDocument: "after", session },
        );
        if (!quota) throw Error();
      } catch {
        throw new HttpError(
          429,
          "RATE_LIMIT",
          "This phone reached its daily code limit.",
        );
      }
      await store.phoneChallenges.replaceOne(
        { _id: preference._id },
        {
          _id: preference._id,
          phone,
          nonce,
          digest: hash(nonce + ":" + code),
          attempts: 0,
          requestedAt: now,
          expiresAt,
        },
        { session },
      );
      await store.notificationJobs.insertOne(
        {
          _id: hash("otp:" + nonce),
          kind: "phone_verification",
          actorKey: preference._id,
          channel: "sms",
          to: phone,
          nonce,
          text:
            "Your Angar Kitchen verification code is " +
            code +
            ". It expires in 5 minutes. Do not share it.",
          status: "queued",
          attempts: 0,
          dueAt: now,
          createdAt: now,
          expiresAt,
        },
        { session },
      );
    });
    res.json({ message: "Verification code queued. It expires in 5 minutes." });
  });
  api.post("/notifications/phone-verify", limited, async (req, res) => {
    const input = body(
        z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
        req.body,
      ),
      preference = await ensure(req, res);
    const challenge = await store.phoneChallenges.findOneAndUpdate(
      {
        _id: preference._id,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: 5 },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "before" },
    );
    if (
      !challenge ||
      !timingSafeEqual(
        Buffer.from(challenge.digest, "hex"),
        Buffer.from(hash(challenge.nonce + ":" + input.code), "hex"),
      )
    )
      throw new HttpError(
        400,
        "PHONE_CODE",
        "Code is incorrect, expired or has reached its attempt limit.",
      );
    await transaction(store, async (session) => {
      const consumed = await store.phoneChallenges.deleteOne(
        { _id: preference._id, nonce: challenge.nonce },
        { session },
      );
      if (!consumed.deletedCount)
        throw new HttpError(
          409,
          "PHONE_CODE",
          "Request a fresh phone verification code.",
        );
      await store.notificationPreferences.updateOne(
        { _id: preference._id },
        {
          $set: {
            verifiedPhone: challenge.phone,
            phoneVerifiedAt: new Date(),
            sms: false,
          },
          $inc: { generation: 1 },
        },
        { session },
      );
    });
    res.json({ phone: challenge.phone });
  });
  api.post("/notifications/push", limited, async (req, res) => {
    if (!pushReady(config))
      throw new HttpError(503, "PUSH_SETUP", "Configure Web Push first.");
    const subscription = body(
      z.strictObject({
        endpoint: z.string().url().max(2048),
        expirationTime: z.number().nullable().optional(),
        keys: z.strictObject({
          p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,90}$/),
          auth: z.string().regex(/^[A-Za-z0-9_-]{20,24}$/),
        }),
      }),
      req.body,
    );
    subscription.endpoint = pushEndpoint(subscription.endpoint);
    try {
      const point = Buffer.from(subscription.keys.p256dh, "base64url");
      if (
        point.length !== 65 ||
        point[0] !== 4 ||
        Buffer.from(subscription.keys.auth, "base64url").length !== 16
      )
        throw Error();
      ECDH.convertKey(point, "prime256v1");
    } catch {
      throw new HttpError(
        400,
        "PUSH_KEYS",
        "This browser subscription has invalid encryption keys.",
      );
    }
    const preference = await ensure(req, res),
      id = hash(subscription.endpoint),
      guestActor = "guest:" + getGuest(req, res, config);
    await transaction(store, async (session) => {
      const previous = await store.pushSubscriptions.findOne(
        { _id: id },
        { session },
      );
      if (previous && ![preference._id, guestActor].includes(previous.actorKey))
        throw new HttpError(
          409,
          "PUSH_OWNED",
          "This push subscription belongs to another account.",
        );
      await store.pushSubscriptions.updateOne(
        { _id: id },
        {
          $set: {
            actorKey: preference._id,
            subscription,
            createdAt: new Date(),
          },
        },
        { upsert: true, session },
      );
      await store.notificationPreferences.updateOne(
        { _id: preference._id },
        { $set: { push: true, sinceAt: new Date() }, $inc: { generation: 1 } },
        { session },
      );
    });
    res.status(201).json({ enabled: true });
  });
  api.post("/notifications/push/remove", async (req, res) => {
    const input = body(
      z.strictObject({ endpoint: z.string().url().max(2048) }),
      req.body,
    );
    await store.pushSubscriptions.deleteOne({
      _id: hash(input.endpoint),
      actorKey: notificationActor(req, res, config),
    });
    res.status(204).end();
  });
}

export function registerStaffNotifications(api, store, config, requireAdmin) {
  api.get("/notifications", requireAdmin, async (req, res) => {
    const rows = await store.notificationJobs
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const masked = (value) =>
      value.includes("@")
        ? value.slice(0, 2) + "…@" + value.split("@").at(-1)
        : "…" + value.slice(-4);
    res.json({
      providers: metadata(config),
      jobs: rows.map((row) => ({
        id: row._id,
        channel: row.channel,
        status: row.status,
        attempts: row.attempts,
        retryable:
          row.kind !== "phone_verification" && row.expiresAt > new Date(),
        recipient: masked(row.to),
        title:
          row.kind === "phone_verification"
            ? "Phone verification code"
            : row.title,
        createdAt: row.createdAt,
        message: row.message || "",
        providerReference: row.providerReference || "",
      })),
    });
  });
  api.post("/notifications/:id/retry", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        confirmed: z.literal(true),
        reason: z.string().trim().min(3).max(160),
      }),
      req.body,
    );
    const row = await store.notificationJobs.findOneAndUpdate(
      {
        _id: req.params.id,
        kind: { $ne: "phone_verification" },
        status: { $in: ["unknown", "failed"] },
        attempts: { $lt: 3 },
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          status: "queued",
          dueAt: new Date(),
          message: "Explicitly retried by an administrator.",
        },
      },
    );
    if (!row)
      throw new HttpError(
        409,
        "MESSAGE_STATE",
        "This message is expired, already queued or at its retry limit.",
      );
    await store.audit.insertOne({
      type: "notification.retry",
      notificationId: row._id,
      by: req.staff.username,
      reason: input.reason,
      at: new Date(),
    });
    res.json({ queued: true });
  });
}
