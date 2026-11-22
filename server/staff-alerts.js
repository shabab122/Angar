import { z } from "zod";
import { body, HttpError } from "./http.js";
import { stockDay } from "./ingredient-batches.js";
import { hash, passwordMatches } from "./security.js";
import { mailReady, deliverMail } from "./account-mail.js";
import { supplierBalance } from "./supplier-returns.js";
const recipients = (config) =>
  (config.staffAlertEmails || []).filter((v) => z.email().safeParse(v).success);
export async function scanStaffAlerts(store, config) {
  const now = new Date(),
    lock = await store.settings.findOneAndUpdate(
      {
        _id: "staff-alert-scan",
        $or: [{ nextAt: { $lte: now } }, { nextAt: { $exists: false } }],
      },
      { $set: { nextAt: new Date(now.getTime() + 60000) } },
      { returnDocument: "after" },
    );
  if (!lock) return;
  const settings = await store.settings.findOne({ _id: "staff-alert-config" }),
    days = settings?.leadDays || 7,
    today = stockDay(),
    through = stockDay(new Date(Date.now() + days * 86400000)),
    found = [];
  const ingredients = await store.ingredients.find({}).toArray();
  const usable = await store.ingredientBatches
    .aggregate([
      {
        $match: {
          remaining: { $gt: 0 },
          blocked: { $ne: true },
          $or: [{ expiresOn: null }, { expiresOn: { $gte: today } }],
        },
      },
      { $group: { _id: "$ingredientId", quantity: { $sum: "$remaining" } } },
    ])
    .toArray();
  for (const i of ingredients) {
    const stock = i.batchTracked
      ? usable.find((b) => b._id.equals(i._id))?.quantity || 0
      : i.stock;
    if (stock <= i.reorderLevel)
      found.push({
        _id: "low:" + i._id,
        type: "low_stock",
        sourceId: String(i._id),
        title: "Low stock: " + i.name,
        detail:
          stock + " " + i.unit + " usable; reorder level " + i.reorderLevel,
        roles: ["admin", "kitchen"],
      });
  }
  const batches = await store.ingredientBatches
    .find({
      remaining: { $gt: 0 },
      expiresOn: { $type: "string", $lte: through },
    })
    .toArray();
  for (const b of batches)
    found.push({
      _id: "expiry:" + b._id,
      type: b.expiresOn < today ? "expired" : "expiry_soon",
      sourceId: String(b._id),
      title:
        (b.expiresOn < today ? "Expired: " : "Expiry approaching: ") +
        b.ingredientName +
        " / " +
        b.code,
      detail:
        b.remaining +
        " " +
        b.unit +
        "; expiry " +
        b.expiresOn +
        (b.blocked ? "; quarantined" : ""),
      roles: ["admin", "kitchen"],
    });
  const purchases = await store.purchases
    .find({ dueOn: { $ne: "", $lt: today } })
    .toArray();
  for (const p of purchases) {
    const balance = supplierBalance(p);
    if (balance > 0)
      found.push({
        _id: "overdue:" + p._id,
        type: "supplier_overdue",
        sourceId: String(p._id),
        title: "Supplier payment overdue: " + p.code,
        detail:
          p.supplierName +
          "; BDT " +
          (balance / 100).toFixed(2) +
          "; due " +
          p.dueOn,
        roles: ["admin", "cashier"],
      });
  }
  for (const condition of found) {
    const old = await store.staffAlerts.findOne({ _id: condition._id });
    const recurring = !old?.active || old.type !== condition.type;
    await store.staffAlerts.updateOne(
      { _id: condition._id },
      {
        $set: {
          ...condition,
          active: true,
          lastSeenAt: now,
          ...(recurring
            ? {
                openedAt: now,
                acknowledgedBy: [],
                generation: (old?.generation || 0) + 1,
              }
            : {}),
        },
      },
      { upsert: true },
    );
  }
  await store.staffAlerts.updateMany(
    { active: true, _id: { $nin: found.map((a) => a._id) } },
    { $set: { active: false, resolvedAt: now } },
  );
  if (
    settings?.emailEnabled &&
    mailReady(config) &&
    recipients(config).length &&
    found.length
  ) {
    const id = hash("staff-alert-digest:" + today);
    await store.staffAlertDeliveries.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          day: today,
          status: "queued",
          createdAt: now,
          nextAt: now,
          recipientsHash: hash(recipients(config).join(",")),
        },
      },
      { upsert: true },
    );
  }
}
export async function runStaffAlertDeliveries(store, config) {
  const settings = await store.settings.findOne({ _id: "staff-alert-config" });
  if (
    !settings?.emailEnabled ||
    !mailReady(config) ||
    !recipients(config).length
  )
    return;
  await store.staffAlertDeliveries.updateMany(
    { status: "sending", leaseUntil: { $lt: new Date() } },
    {
      $set: {
        status: "uncertain",
        message:
          "Delivery was interrupted. Check the mailbox before requesting another digest.",
      },
    },
  );
  await store.staffAlertDeliveries.updateMany(
    { status: "queued", day: { $lt: stockDay() } },
    {
      $set: {
        status: "skipped",
        message:
          "The digest date passed; current conditions belong to a new daily digest.",
      },
    },
  );
  const row = await store.staffAlertDeliveries.findOneAndUpdate(
    {
      status: "queued",
      day: stockDay(),
      recipientsHash: hash(recipients(config).join(",")),
    },
    { $set: { status: "sending", leaseUntil: new Date(Date.now() + 120000) } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!row) return;
  const alerts = await store.staffAlerts
    .find({ active: true })
    .sort({ type: 1 })
    .limit(500)
    .toArray();
  if (!alerts.length) {
    await store.staffAlertDeliveries.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "skipped",
          message: "The conditions were resolved before delivery.",
        },
      },
    );
    return;
  }
  try {
    await deliverMail(config, {
      to: recipients(config).join(","),
      subject: "Angar Kitchen staff stock / supplier alerts - " + row.day,
      text:
        alerts.map((a) => a.title + "\n" + a.detail).join("\n\n") +
        "\n\nReview current conditions in the staff workspace: " +
        config.origin +
        "/staff",
    });
    await store.staffAlertDeliveries.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          message: "Mail transport accepted the staff digest.",
        },
      },
    );
  } catch {
    await store.staffAlertDeliveries.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "uncertain",
          message:
            "The mail transport did not confirm delivery. Check the mailbox before requesting another digest.",
        },
      },
    );
  }
}
export function registerStaffAlerts(api, store, config, requireAdmin) {
  api.get("/operations-alerts", async (req, res) => {
    const roles = ["admin", "kitchen", "cashier"];
    if (!roles.includes(req.staff.role))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Operations alerts belong to the kitchen or counter.",
      );
    const rows = await store.staffAlerts
        .find({
          roles: req.staff.role,
          ...(req.query.history === "true" ? {} : { active: true }),
        })
        .sort({ active: -1, lastSeenAt: -1 })
        .limit(200)
        .toArray(),
      settings = await store.settings.findOne({ _id: "staff-alert-config" });
    const jobs =
      req.staff.role === "admin"
        ? await store.staffAlertDeliveries
            .find({})
            .sort({ createdAt: -1 })
            .limit(20)
            .toArray()
        : [];
    res.json({
      alerts: rows.map(({ _id, acknowledgedBy, ...row }) => ({
        ...row,
        id: _id,
        acknowledged: (acknowledgedBy || []).includes(String(req.staff._id)),
      })),
      settings: {
        leadDays: settings?.leadDays || 7,
        ...(req.staff.role === "admin"
          ? {
              emailEnabled: Boolean(settings?.emailEnabled),
              emailConfigured:
                mailReady(config) && recipients(config).length > 0,
              emailTargets: recipients(config),
            }
          : {}),
      },
      deliveries: jobs.map((row) => ({
        id: row._id,
        day: row.day,
        status: row.status,
        message: row.message || "",
        sentAt: row.sentAt,
      })),
    });
  });
  api.post("/operations-alerts/:id/acknowledge", async (req, res) => {
    const row = await store.staffAlerts.findOneAndUpdate(
      { _id: req.params.id, active: true, roles: req.staff.role },
      { $addToSet: { acknowledgedBy: String(req.staff._id) } },
    );
    if (!row) throw new HttpError(404, "NOT_FOUND", "Active alert not found.");
    res.json({ acknowledged: true });
  });
  api.post("/operations-alerts/settings", requireAdmin, async (req, res) => {
    const input = body(
        z.strictObject({
          leadDays: z.number().int().min(1).max(30),
          emailEnabled: z.boolean(),
          currentPassword: z.string().min(1).max(128),
        }),
        req.body,
      ),
      user = await store.staff.findOne({ _id: req.staff._id, active: true });
    if (!(await passwordMatches(input.currentPassword, user.passwordHash)))
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter the administrator password.",
      );
    if (
      input.emailEnabled &&
      (!mailReady(config) || !recipients(config).length)
    )
      throw new HttpError(
        503,
        "STAFF_ALERT_SETUP",
        "Configure staff alert recipients and mail transport first.",
      );
    await store.settings.updateOne(
      { _id: "staff-alert-config" },
      { $set: { leadDays: input.leadDays, emailEnabled: input.emailEnabled } },
      { upsert: true },
    );
    await store.settings.updateOne(
      { _id: "staff-alert-scan" },
      { $set: { nextAt: new Date(0) } },
      { upsert: true },
    );
    await store.audit.insertOne({
      type: "staff.alert_policy_updated",
      by: req.staff.username,
      reason: input.emailEnabled
        ? "Staff email digest enabled"
        : "Staff email digest disabled",
      at: new Date(),
    });
    res.json({ saved: true });
  });
  api.post(
    "/operations-alerts/deliveries/:id/retry",
    requireAdmin,
    async (req, res) => {
      const input = body(
        z.strictObject({
          reason: z.string().trim().min(3).max(160),
          confirmDuplicateRisk: z.literal(true),
        }),
        req.body,
      );
      const row = await store.staffAlertDeliveries.findOneAndUpdate(
        { _id: req.params.id, status: "uncertain", day: stockDay() },
        {
          $set: {
            status: "queued",
            message: "Reviewed retry: " + input.reason,
          },
        },
      );
      if (!row)
        throw new HttpError(
          409,
          "ALERT_DELIVERY_STATE",
          "Only today's uncertain digest can be retried after checking the mailbox.",
        );
      await store.audit.insertOne({
        type: "staff.alert_digest_retry",
        by: req.staff.username,
        reason: input.reason,
        at: new Date(),
      });
      res.json({ queued: true });
    },
  );
}
