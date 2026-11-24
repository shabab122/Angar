import { randomUUID } from "node:crypto";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash, passwordMatches } from "./security.js";
import { transaction } from "./money.js";
import { deliverMail, mailReady } from "./account-mail.js";
import { getBranchRuntime } from "./branches.js";
import { requirePlatformCapability } from "./organization.js";
const states = new WeakMap(),
  ttl = 30 * 86400000;
const rootOf = (store) => store.rootStore || store;
function stateFor(store) {
  const root = rootOf(store);
  if (!states.has(root))
    states.set(root, {
      id: randomUUID(),
      started: false,
      workers: new Map(),
      signals: new Map(),
      requests: 0,
      failures: 0,
      slow: 0,
      lastFlush: null,
    });
  return states.get(root);
}
const safeName = (value) =>
  String(value)
    .replace(/[^a-zA-Z0-9_/.:-]/g, "")
    .slice(0, 120);
export async function recordIncident(
  store,
  config,
  { key, kind, branch = "main", title, active = true },
) {
  const root = rootOf(store),
    id = hash(key),
    now = new Date();
  return transaction(root, async (session) => {
    const old = await root.monitoringIncidents.findOne(
      { _id: id },
      { session },
    );
    if (!active && (!old || old.status === "resolved")) return old;
    const reopened = active && (!old || old.status === "resolved"),
      generation = (old?.generation || 0) + (reopened ? 1 : 0),
      status = active ? "open" : "resolved";
    const changes = {
      signalKey: key,
      kind: safeName(kind),
      branchId: safeName(branch),
      title: String(title).slice(0, 180),
      status,
      generation,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ttl),
      ...(active ? {} : { resolvedAt: now }),
      ...(reopened
        ? { openedAt: now, acknowledgedAt: null, acknowledgedBy: null }
        : {}),
    };
    await root.monitoringIncidents.updateOne(
      { _id: id },
      {
        $set: changes,
        $inc: { occurrences: active ? 1 : 0 },
        $setOnInsert: { createdAt: now },
      },
      { session, upsert: true },
    );
    const policy = await root.identitySettings.findOne(
        { _id: "monitoring-policy" },
        { session },
      ),
      enabled =
        policy?.emailEnabled ?? config.monitoring?.emailEnabled ?? false;
    if (enabled && config.monitoring?.emails?.length)
      await root.monitoringDeliveries.updateOne(
        { _id: id + ":" + generation + ":" + status },
        {
          $setOnInsert: {
            incidentId: id,
            generation,
            event: status,
            title: changes.title,
            branchId: changes.branchId,
            status: "queued",
            createdAt: now,
            expiresAt: new Date(now.getTime() + ttl),
          },
        },
        { session, upsert: true },
      );
    return { ...old, ...changes, _id: id };
  });
}
export function monitoringMiddleware(store, config) {
  return (req, res, next) => {
    if (!req.path.startsWith("/api/") || req.path.startsWith("/api/monitoring"))
      return next();
    const at = performance.now();
    res.once("finish", () => {
      const state = stateFor(store),
        slow = performance.now() - at > (config.monitoring?.slowMs || 3000);
      state.requests++;
      if (slow) state.slow++;
      if (res.statusCode >= 500) {
        state.failures++;
        const route =
            typeof req.route?.path === "string" ? req.route.path : "unmatched",
          group = safeName(req.method + ":" + route),
          branch = safeName(res.getHeader("X-Angar-Branch") || "main"),
          key = "api:" + branch + ":" + group;
        if (state.signals.size < 100 || state.signals.has(key))
          state.signals.set(key, {
            key,
            kind: "api",
            branch,
            title: "API failure: " + group,
            active: true,
          });
      }
    });
    next();
  };
}
export function workerHeartbeat(store, name, error = null) {
  const state = stateFor(store),
    branch = store.branchId || "main",
    key = branch + ":" + safeName(name),
    previous = state.workers.get(key);
  state.workers.set(key, {
    name: safeName(name),
    branchId: branch,
    at: new Date(),
    ok: !error,
  });
  if (error || previous?.ok === false) {
    const pending = state.signals.get("worker:" + key);
    state.signals.set(
      "worker:" + key,
      !error && pending?.active
        ? { ...pending, recovered: true }
        : {
            key: "worker:" + key,
            kind: "worker",
            branch,
            title: "Background task: " + key,
            active: Boolean(error),
          },
    );
  }
}
export function registerWorker(store, name) {
  const state = stateFor(store),
    key = (store.branchId || "main") + ":" + safeName(name);
  if (!state.workers.has(key)) workerHeartbeat(store, name);
}
const isStale = (worker, now) =>
  now - worker.at.getTime() >
  (["backups", "offsite-backups"].includes(worker.name) ? 900000 : 90000);
export async function runMonitoringDeliveries(store, config) {
  const root = rootOf(store),
    now = new Date(),
    policy = await root.identitySettings.findOne({ _id: "monitoring-policy" });
  await root.monitoringDeliveries.updateMany(
    { status: "sending", leaseUntil: { $lt: now } },
    { $set: { status: "uncertain", updatedAt: now } },
  );
  if (
    !(policy?.emailEnabled ?? config.monitoring?.emailEnabled) ||
    !mailReady(config) ||
    !config.monitoring?.emails?.length
  )
    return;
  for (let i = 0; i < 10; i++) {
    const job = await root.monitoringDeliveries.findOneAndUpdate(
      { status: "queued" },
      {
        $set: {
          status: "sending",
          leaseUntil: new Date(Date.now() + 60000),
          updatedAt: new Date(),
        },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    if (!job) break;
    try {
      await deliverMail(config, {
        to: config.monitoring.emails,
        subject: "Angar Kitchen · " + job.event + " · " + job.title,
        text:
          job.title +
          "\nBranch: " +
          job.branchId +
          "\nState: " +
          job.event +
          "\nReview the technical incidents panel: " +
          config.origin +
          "/staff\nIncident: " +
          job.incidentId,
      });
      await root.monitoringDeliveries.updateOne(
        { _id: job._id, status: "sending" },
        { $set: { status: "sent", sentAt: new Date() } },
      );
    } catch {
      await root.monitoringDeliveries.updateOne(
        { _id: job._id, status: "sending" },
        { $set: { status: "uncertain", updatedAt: new Date() } },
      );
    }
  }
}
export async function flushMonitoring(store, config) {
  const root = rootOf(store),
    state = stateFor(root),
    now = new Date();
  for (const [key, signal] of [...state.signals]) {
    await recordIncident(root, config, signal);
    if (signal.recovered)
      await recordIncident(root, config, { ...signal, active: false });
    if (state.signals.get(key) === signal) state.signals.delete(key);
  }
  for (const worker of state.workers.values())
    if (isStale(worker, now.getTime()))
      await recordIncident(root, config, {
        key: "heartbeat:" + worker.branchId + ":" + worker.name,
        kind: "heartbeat",
        branch: worker.branchId,
        title: "Stale background heartbeat: " + worker.name,
      });
    else
      await recordIncident(root, config, {
        key: "heartbeat:" + worker.branchId + ":" + worker.name,
        kind: "heartbeat",
        branch: worker.branchId,
        title: "Background heartbeat recovered",
        active: false,
      });
  // Inspect the latest job per subsystem, rather than alerting on old failures
  // after a verified replacement already succeeded. Uncertain sends stay visible
  // in their original staff panels and are never automatically resent here.
  const runtime = getBranchRuntime(root, config);
  for (const branch of await runtime.all()) {
    try {
      const context = await runtime.get(branch._id);
      for (const name of [
        "backupJobs",
        "backupSyncJobs",
        "printJobs",
        "notificationJobs",
        "staffAlertDeliveries",
      ]) {
        const collection = context.store[name];
        if (!collection) continue;
        const latest = await collection.findOne(
          {},
          { sort: { createdAt: -1 } },
        );
        if (!latest) continue;
        await recordIncident(root, config, {
          key: "job:" + branch._id + ":" + name,
          kind: "job",
          branch: branch._id,
          title: "Latest " + name + " job needs review",
          active: [
            "failed",
            "uncertain",
            "unknown",
            "destination_changed",
          ].includes(latest.status),
        });
      }
      await recordIncident(root, config, {
        key: "monitor-branch:" + branch._id,
        kind: "branch",
        branch: branch._id,
        title: "Branch monitoring recovered",
        active: false,
      });
    } catch {
      await recordIncident(root, config, {
        key: "monitor-branch:" + branch._id,
        kind: "branch",
        branch: branch._id,
        title: "Branch monitoring could not read service status",
      });
    }
  }
  await root.monitoringInstances.updateOne(
    { _id: state.id },
    {
      $set: {
        started: state.started,
        at: now,
        expiresAt: new Date(now.getTime() + 180000),
        workers: [...state.workers.values()],
        requests: state.requests,
        failures: state.failures,
        slow: state.slow,
      },
    },
    { upsert: true },
  );
  state.lastFlush = now;
  // API incidents recover only after a quiet period, not after one good request.
  for (const row of await root.monitoringIncidents
    .find({
      kind: "api",
      status: "open",
      lastSeenAt: { $lt: new Date(Date.now() - 300000) },
    })
    .limit(100)
    .toArray())
    await recordIncident(root, config, {
      key: row.signalKey,
      kind: "api",
      branch: row.branchId,
      title: row.title,
      active: false,
    });
  await runMonitoringDeliveries(root, config);
}
export function startMonitoring(store, config) {
  const state = stateFor(store);
  state.started = true;
  let pending = Promise.resolve(),
    busy = false,
    stopped = false;
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    pending = flushMonitoring(store, config)
      .catch(() =>
        console.error("Technical monitoring could not persist its heartbeat."),
      )
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    state.started = false;
    clearInterval(timer);
    await pending;
    await rootOf(store).monitoringInstances.deleteOne({ _id: state.id });
  };
}
export async function readiness(store, now = Date.now()) {
  await store.db.command({ ping: 1 });
  const state = stateFor(store),
    stale = [...state.workers.values()].some((worker) => isStale(worker, now));
  return {
    ready: !stale,
    workers: state.started ? "monitored" : "not_started",
    checkedAt: new Date(),
  };
}
export function registerMonitoring(api, root, config) {
  const view = requirePlatformCapability(root, config, "monitoring.view"),
    manage = requirePlatformCapability(root, config, "monitoring.manage");
  const reauth = async (req, password) => {
    const current = await root.staff.findOne({
      _id: req.platformStaff._id,
      active: true,
    });
    if (
      !current ||
      !(await passwordMatches(password, current.passwordHash)) ||
      (current.authVersion || 0) !== (req.platformStaff.authVersion || 0)
    )
      throw new HttpError(
        403,
        "PASSWORD_CHECK",
        "Administrator password did not match.",
      );
  };
  api.get("/monitoring", view, async (req, res) => {
    const [incidents, deliveries, instances, policy] = await Promise.all([
      root.monitoringIncidents
        .find({})
        .sort({ lastSeenAt: -1 })
        .limit(100)
        .toArray(),
      root.monitoringDeliveries
        .find({})
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      root.monitoringInstances
        .find({ expiresAt: { $gt: new Date() } })
        .limit(30)
        .toArray(),
      root.identitySettings.findOne({ _id: "monitoring-policy" }),
    ]);
    res.json({
      incidents,
      deliveries,
      instances,
      settings: {
        emailEnabled:
          policy?.emailEnabled ?? config.monitoring?.emailEnabled ?? false,
        emailReady:
          mailReady(config) && Boolean(config.monitoring?.emails?.length),
        recipientCount: config.monitoring?.emails?.length || 0,
      },
      externalWatchdogRequired: true,
    });
  });
  api.patch("/monitoring/settings", manage, async (req, res) => {
    const input = body(
      z.strictObject({
        emailEnabled: z.boolean(),
        currentPassword: z.string().min(1).max(128),
      }),
      req.body,
    );
    await reauth(req, input.currentPassword);
    if (
      input.emailEnabled &&
      (!mailReady(config) || !config.monitoring?.emails?.length)
    )
      throw new HttpError(
        409,
        "MONITOR_SETUP",
        "Configure SMTP and MONITOR_EMAIL_TO before enabling alerts.",
      );
    await root.identitySettings.updateOne(
      { _id: "monitoring-policy" },
      { $set: { emailEnabled: input.emailEnabled, updatedAt: new Date() } },
      { upsert: true },
    );
    await root.audit.insertOne({
      type: "monitoring.settings",
      by: req.platformStaff.username,
      emailEnabled: input.emailEnabled,
      at: new Date(),
    });
    res.json({ saved: true });
  });
  api.post(
    "/monitoring/incidents/:id/acknowledge",
    manage,
    async (req, res) => {
      body(z.strictObject({}), req.body);
      if (!/^[a-f0-9]{64}$/.test(req.params.id))
        throw new HttpError(404, "NOT_FOUND", "Incident not found.");
      const result = await root.monitoringIncidents.updateOne(
        { _id: req.params.id, status: "open" },
        {
          $set: {
            acknowledgedAt: new Date(),
            acknowledgedBy: req.platformStaff.username,
          },
        },
      );
      if (!result.matchedCount)
        throw new HttpError(
          409,
          "INCIDENT_UPDATED",
          "This incident has ended. Refresh the panel.",
        );
      await root.audit.insertOne({
        type: "monitoring.acknowledged",
        incidentId: req.params.id,
        by: req.platformStaff.username,
        at: new Date(),
      });
      res.json({ saved: true });
    },
  );
  api.post("/monitoring/deliveries/:id/retry", manage, async (req, res) => {
    const input = body(
      z.strictObject({
        currentPassword: z.string().min(1).max(128),
        duplicateRiskAccepted: z.literal(true),
      }),
      req.body,
    );
    await reauth(req, input.currentPassword);
    if (!/^[a-f0-9]{64}:\d+:(open|resolved)$/.test(req.params.id))
      throw new HttpError(404, "NOT_FOUND", "Alert not found.");
    const changed = await root.monitoringDeliveries.updateOne(
      { _id: req.params.id, status: "uncertain" },
      {
        $set: {
          status: "queued",
          reviewedBy: req.platformStaff.username,
          reviewedAt: new Date(),
        },
      },
    );
    if (!changed.matchedCount)
      throw new HttpError(
        409,
        "ALERT_UPDATED",
        "Only an uncertain alert can be retried after checking the mail server.",
      );
    res.json({ saved: true });
  });
}
