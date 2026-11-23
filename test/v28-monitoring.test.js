import test from "node:test";
import assert from "node:assert/strict";
import { fixture, post, patch, ok, error, password } from "./support.js";
import {
  recordIncident,
  flushMonitoring,
  workerHeartbeat,
  runMonitoringDeliveries,
  readiness,
  registerWorker,
} from "../server/monitoring.js";
import { watchdogCycle } from "../server/watchdog.js";
test("a task that recovers before the next monitor flush still retains its failure and recovery", async (t) => {
  const f = await fixture(t);
  workerHeartbeat(f.store, "brief-failure", true);
  workerHeartbeat(f.store, "brief-failure");
  await flushMonitoring(f.store, f.config);
  const row = await f.store.monitoringIncidents.findOne({ kind: "worker" });
  assert.equal(row.status, "resolved");
  assert.equal(row.occurrences, 1);
});
test("readiness detects a stalled first task while allowing longer backup operations", async (t) => {
  const f = await fixture(t);
  registerWorker(f.store, "printing");
  assert.equal((await readiness(f.store, Date.now() + 91000)).ready, false);
  workerHeartbeat(f.store, "printing");
  registerWorker(f.store, "backups");
  assert.equal((await readiness(f.store, Date.now() + 1000)).ready, true);
});
test("technical incidents deduplicate across writers, send one alert per generation and record recovery", async (t) => {
  const sent = [],
    f = await fixture(t, {
      monitoring: { emails: ["ops@example.test"], emailEnabled: true },
      mailer: async (message) => sent.push(message),
    }),
    signal = {
      key: "test:worker",
      kind: "worker",
      title: "Worker test failed",
    };
  await Promise.all([
    recordIncident(f.store, f.config, signal),
    recordIncident(f.store, f.config, signal),
  ]);
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(sent.length, 1);
  assert.equal(
    (await f.store.monitoringIncidents.findOne({ title: signal.title }))
      .occurrences,
    2,
  );
  await recordIncident(f.store, f.config, { ...signal, active: false });
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /resolved/);
  await recordIncident(f.store, f.config, signal);
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(sent.length, 3);
  assert.equal(
    (await f.store.monitoringIncidents.findOne({ title: signal.title }))
      .generation,
    2,
  );
});
test("API monitoring stores route groups and counters without request secrets or raw provider errors", async (t) => {
  const f = await fixture(t, {
    courier: {
      provider: "ecourier",
      ecourier: {
        mode: "sandbox",
        apiKey: "test",
        apiSecret: "test",
        userId: "test",
      },
    },
    ecourierTransport: async () => {
      throw new Error("private-provider-secret");
    },
  });
  error(
    await f.staff.admin(
      "/api/staff/courier/options?token=private-query-secret",
    ),
    503,
    "COURIER_CATALOGUE",
  );
  await flushMonitoring(f.store, f.config);
  const panel = ok(await f.staff.admin("/api/monitoring"));
  assert.ok(panel.incidents.some((row) => row.kind === "api"));
  assert.equal(JSON.stringify(panel).includes("private-query-secret"), false);
  assert.equal(
    JSON.stringify(panel).includes("private-provider-secret"),
    false,
  );
  assert.ok(panel.instances[0].failures >= 1);
  error(
    await f.staff.waiter("/api/monitoring"),
    403,
    "PLATFORM_ADMIN_REQUIRED",
  );
  const incident = panel.incidents.find((row) => row.kind === "api");
  ok(
    await post(
      f.staff.admin,
      "/api/monitoring/incidents/" + incident._id + "/acknowledge",
    ),
  );
  assert.equal(
    (await f.store.monitoringIncidents.findOne({ _id: incident._id }))
      .acknowledgedBy,
    "admin",
  );
});
test("background worker failures and latest failed jobs become incidents and successes resolve them", async (t) => {
  const f = await fixture(t);
  workerHeartbeat(f.store, "unit-worker", true);
  await f.store.backupJobs.insertOne({
    _id: "test-job",
    createdAt: new Date(),
    status: "failed",
  });
  await flushMonitoring(f.store, f.config);
  assert.equal(
    await f.store.monitoringIncidents.countDocuments({ status: "open" }),
    2,
  );
  workerHeartbeat(f.store, "unit-worker");
  await f.store.backupJobs.updateOne(
    { _id: "test-job" },
    { $set: { status: "completed" } },
  );
  await flushMonitoring(f.store, f.config);
  assert.equal(
    await f.store.monitoringIncidents.countDocuments({ status: "open" }),
    0,
  );
});
test("uncertain SMTP sends are never automatically retried, and manual retry requires password and duplicate review", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    monitoring: { emails: ["ops@example.test"], emailEnabled: true },
    mailer: async () => {
      attempts++;
      throw new Error("SMTP acceptance uncertain");
    },
  });
  await recordIncident(f.store, f.config, {
    key: "smtp-test",
    kind: "worker",
    title: "Test signal",
  });
  await runMonitoringDeliveries(f.store, f.config);
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(attempts, 1);
  const delivery = await f.store.monitoringDeliveries.findOne({
    status: "uncertain",
  });
  error(
    await post(
      f.staff.admin,
      "/api/monitoring/deliveries/" + delivery._id + "/retry",
      { currentPassword: "wrong", duplicateRiskAccepted: true },
    ),
    403,
    "PASSWORD_CHECK",
  );
  error(
    await post(
      f.staff.admin,
      "/api/monitoring/deliveries/" + delivery._id + "/retry",
      { currentPassword: password, duplicateRiskAccepted: false },
    ),
    400,
    "INVALID_INPUT",
  );
  ok(
    await post(
      f.staff.admin,
      "/api/monitoring/deliveries/" + delivery._id + "/retry",
      { currentPassword: password, duplicateRiskAccepted: true },
    ),
  );
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(attempts, 2);
});
test("technical email configuration remains opt-in and existing open incidents alert once after activation", async (t) => {
  const sent = [],
    f = await fixture(t, {
      monitoring: { emails: ["ops@example.test"], emailEnabled: false },
      mailer: async (m) => sent.push(m),
    }),
    signal = { key: "enabled-later", kind: "worker", title: "Existing issue" };
  await recordIncident(f.store, f.config, signal);
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(sent.length, 0);
  ok(
    await patch(f.staff.admin, "/api/monitoring/settings", {
      currentPassword: password,
      emailEnabled: true,
    }),
  );
  await recordIncident(f.store, f.config, signal);
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(sent.length, 1);
  ok(
    await patch(f.staff.admin, "/api/monitoring/settings", {
      currentPassword: password,
      emailEnabled: false,
    }),
  );
  await recordIncident(f.store, f.config, { ...signal, active: false });
  await runMonitoringDeliveries(f.store, f.config);
  assert.equal(sent.length, 1);
});
test("independent watchdog persists intent, requires repeated failures and sends a separate recovery once", async () => {
  let state = {},
    healthy = false;
  const sends = [],
    snapshots = [],
    options = {
      probe: async () => healthy,
      send: async (event) => sends.push(event),
      persist: async (value) => snapshots.push(structuredClone(value)),
    };
  state = await watchdogCycle(state, options);
  assert.equal(sends.length, 0);
  state = await watchdogCycle(state, options);
  assert.deepEqual(sends, ["down"]);
  assert.ok(snapshots.some((row) => row.alert?.status === "sending"));
  state = await watchdogCycle(state, options);
  assert.deepEqual(sends, ["down"]);
  healthy = true;
  state = await watchdogCycle(state, options);
  assert.deepEqual(sends, ["down", "recovered"]);
  await watchdogCycle(state, options);
  assert.deepEqual(sends, ["down", "recovered"]);
});
test("a watchdog restart after an uncertain SMTP write does not resend the same outage", async () => {
  let attempts = 0,
    state = { failures: 1 };
  const options = {
    probe: async () => false,
    persist: async () => {},
    send: async () => {
      attempts++;
      throw new Error("lost acknowledgement");
    },
  };
  state = await watchdogCycle(state, options);
  assert.equal(state.alert.status, "uncertain");
  state = await watchdogCycle(JSON.parse(JSON.stringify(state)), options);
  assert.equal(attempts, 1);
});
