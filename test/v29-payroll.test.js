import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, key, patch } from "./support.js";
import { branch, limits } from "./v28-support.js";
async function profile(f, staffId, extra = {}) {
  return f.staff.admin("/api/staff/payroll/profiles/" + staffId, {
    method: "PUT",
    data: {
      mode: "hourly",
      monthlyMinor: 0,
      hourlyMinor: 10025,
      overtimeHourlyMinor: 20050,
      enabled: true,
      expectedRevision: 0,
      reason: "Agreed rates checked by manager",
      ...extra,
    },
  });
}
async function roster(
  f,
  staffId,
  startAt = "2026-10-20T09:00:00+06:00",
  endAt = "2026-10-20T17:00:00+06:00",
) {
  return ok(
    await post(f.staff.admin, "/api/staff/attendance/rosters", {
      staffId: String(staffId),
      startAt,
      endAt,
      breakMinutes: 30,
      notes: "October duty",
      requestKey: key(),
    }),
    201,
  ).roster;
}
async function attendance(f, roster, outAt = "2026-10-20T18:30:00+06:00") {
  return ok(
    await post(f.staff.admin, "/api/staff/attendance/manual", {
      rosterId: roster.id,
      inAt: "2026-10-20T09:00:00+06:00",
      outAt,
      breakMinutes: 30,
      reason: "Manager verified actual clock records",
    }),
    201,
  ).attendance;
}
test("duty roster rejects overlap across branches and self attendance cannot expose or modify another staff member", async (t) => {
  const f = await fixture(t);
  await branch(t, f);
  const employee = await f.store.staff.findOne({ username: "kitchen" });
  await f.store.staff.updateOne(
    { _id: employee._id },
    { $set: { branchIds: ["main", "uttara"] } },
  );
  const first = await roster(f, employee._id);
  ok(await post(f.staff.admin, "/api/branches/select", { branchId: "uttara" }));
  error(
    await post(f.staff.admin, "/api/staff/attendance/rosters", {
      staffId: String(employee._id),
      startAt: "2026-10-20T10:00:00+06:00",
      endAt: "2026-10-20T15:00:00+06:00",
      breakMinutes: 0,
      notes: "Conflicting duty",
      requestKey: key(),
    }),
    409,
    "ROSTER_OVERLAP",
  );
  assert.deepEqual(
    ok(await f.staff.waiter("/api/staff/attendance/me")).rosters,
    [],
  );
  error(await f.staff.kitchen("/api/staff/payroll"), 403);
  error(
    await post(f.staff.waiter, "/api/staff/attendance/clock-in", {
      rosterId: first.id,
    }),
    409,
    "ROSTER_WINDOW",
  );
});
test("server clock-in locks one active attendance and clock-out records unpaid breaks before manager review", async (t) => {
  const f = await fixture(t),
    employee = await f.store.staff.findOne({ username: "kitchen" }),
    now = Date.now(),
    duty = await roster(
      f,
      employee._id,
      new Date(now - 3600000).toISOString(),
      new Date(now + 7 * 3600000).toISOString(),
    );
  const results = await Promise.all([
    post(f.staff.kitchen, "/api/staff/attendance/clock-in", {
      rosterId: duty.id,
    }),
    post(f.staff.kitchen, "/api/staff/attendance/clock-in", {
      rosterId: duty.id,
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const record = results.find((r) => r.status === 201).data.attendance;
  await f.store.attendance.updateOne(
    { _id: new ObjectId(record.id) },
    { $set: { inAt: new Date(Date.now() - 3600000) } },
  );
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/attendance/" + record.id + "/clock-out",
      { breakMinutes: 15, expectedRevision: 0 },
    ),
  );
  const saved = await f.store.attendance.findOne({
    _id: new ObjectId(record.id),
  });
  assert.equal(saved.status, "submitted");
  assert.equal(saved.netMinutes, 45);
  error(
    await post(
      f.staff.kitchen,
      "/api/staff/attendance/" + record.id + "/review",
      {
        expectedRevision: 1,
        overtimeMinutes: 0,
        reason: "Unauthorized self approval",
      },
    ),
    403,
  );
  assert.equal(saved.open, false);
});
test("approved hourly and overtime minutes produce exact payroll and one salary expense without spending cash", async (t) => {
  const f = await fixture(t),
    employee = await f.store.staff.findOne({ username: "kitchen" });
  ok(await profile(f, employee._id));
  const duty = await roster(f, employee._id),
    record = await attendance(f, duty);
  error(
    await post(
      f.staff.admin,
      "/api/staff/attendance/" + record.id + "/review",
      { expectedRevision: 0, overtimeMinutes: 91, reason: "Too much overtime" },
    ),
    400,
    "OVERTIME_LIMIT",
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/attendance/" + record.id + "/review",
      {
        expectedRevision: 0,
        overtimeMinutes: 90,
        reason: "Actual overtime approved",
      },
    ),
  );
  const run = ok(
    await post(f.staff.admin, "/api/staff/payroll/runs", {
      period: "2026-10",
      reason: "Monthly attendance and rates reviewed",
    }),
    201,
  ).run;
  assert.equal(run.lines[0].regularMinutes, 450);
  assert.equal(run.lines[0].baseMinor, 75188);
  assert.equal(run.lines[0].overtimeMinor, 30075);
  assert.equal(run.totalMinor, 105263);
  assert.equal(await f.store.expenses.countDocuments({}), 0);
  const input = {
      expectedRevision: 0,
      reason: "Final payroll independently checked",
      verified: true,
    },
    results = await Promise.all([
      post(
        f.staff.admin,
        "/api/staff/payroll/runs/" + run.id + "/approve",
        input,
      ),
      post(
        f.staff.admin,
        "/api/staff/payroll/runs/" + run.id + "/approve",
        input,
      ),
    ]);
  results.forEach((r) => ok(r));
  assert.equal(await f.store.expenses.countDocuments({}), 1);
  const expense = await f.store.expenses.findOne({
    payrollRunId: new ObjectId(run.id),
  });
  assert.equal(expense.status, "approved");
  assert.equal(expense.paidMinor, 0);
  assert.equal(expense.incurredOn, "2026-10-31");
  assert.equal(await f.store.cashMovements.countDocuments({}), 0);
  assert.equal(
    ok(await f.staff.kitchen("/api/staff/attendance/me")).payslips[0].line
      .totalMinor,
    105263,
  );
  assert.equal(
    ok(await f.staff.waiter("/api/staff/attendance/me")).payslips.length,
    0,
  );
  error(
    await patch(
      f.staff.admin,
      "/api/staff/attendance/" + record.id + "/correct",
      {
        expectedRevision: 1,
        inAt: "2026-10-20T09:00:00+06:00",
        outAt: "2026-10-20T17:00:00+06:00",
        breakMinutes: 30,
        reason: "Attempt correction after payroll",
      },
    ),
    409,
    "PAYROLL_LOCKED",
  );
});
test("payroll rejects pending attendance and stale rate snapshots, then requires rebuild and the existing expense approval limit", async (t) => {
  const f = await fixture(t),
    employee = await f.store.staff.findOne({ username: "kitchen" });
  ok(
    await profile(f, employee._id, { mode: "monthly", monthlyMinor: 2000000 }),
  );
  const record = await attendance(f, await roster(f, employee._id));
  error(
    await post(f.staff.admin, "/api/staff/payroll/runs", {
      period: "2026-10",
      reason: "Missing attendance review",
    }),
    409,
    "PAYROLL_ATTENDANCE",
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/attendance/" + record.id + "/review",
      {
        expectedRevision: 0,
        overtimeMinutes: 90,
        reason: "Review completed hours",
      },
    ),
  );
  let run = ok(
    await post(f.staff.admin, "/api/staff/payroll/runs", {
      period: "2026-10",
      reason: "October salary draft",
    }),
    201,
  ).run;
  assert.equal(run.totalMinor, 2030075);
  ok(
    await profile(f, employee._id, {
      mode: "monthly",
      monthlyMinor: 2100000,
      expectedRevision: 1,
    }),
  );
  error(
    await post(
      f.staff.admin,
      "/api/staff/payroll/runs/" + run.id + "/approve",
      { expectedRevision: 0, reason: "Old rates are stale", verified: true },
    ),
    409,
    "PAYROLL_STALE",
  );
  ok(
    await post(
      f.staff.admin,
      "/api/staff/payroll/runs/" + run.id + "/rebuild",
      { expectedRevision: 0, reason: "Rebuild with current agreed salary" },
    ),
  );
  run = ok(await f.staff.admin("/api/staff/payroll")).runs[0];
  assert.equal(run.totalMinor, 2130075);
  assert.equal(run.revision, 1);
  const original = await f.store.staff.findOne({ username: "admin" });
  await f.store.staff.insertOne({
    username: "payroll-limited",
    role: "admin",
    active: true,
    passwordHash: original.passwordHash,
    branchIds: ["main"],
    authVersion: 0,
    access: { denied: [], limitsMinor: { ...limits, expenseApproval: 1000 } },
  });
  const limited = f.browser();
  ok(
    await post(limited, "/api/staff/login", {
      username: "payroll-limited",
      password: "Commerce-test-only-123!",
    }),
  );
  error(
    await post(limited, "/api/staff/payroll/runs/" + run.id + "/approve", {
      expectedRevision: 1,
      reason: "Over the administrator approval limit",
      verified: true,
    }),
    403,
    "APPROVAL_LIMIT",
  );
  assert.equal(await f.store.expenses.countDocuments({}), 0);
});
test("unapproved time corrections return attendance to review and cross-month shifts belong to their duty start day", async (t) => {
  const f = await fixture(t),
    employee = await f.store.staff.findOne({ username: "kitchen" });
  ok(await profile(f, employee._id));
  const duty = await roster(
      f,
      employee._id,
      "2026-10-31T23:00:00+06:00",
      "2026-11-01T07:00:00+06:00",
    ),
    record = ok(
      await post(f.staff.admin, "/api/staff/attendance/manual", {
        rosterId: duty.id,
        inAt: "2026-10-31T23:00:00+06:00",
        outAt: "2026-11-01T08:00:00+06:00",
        breakMinutes: 30,
        reason: "Night duty actual time verified",
      }),
      201,
    ).attendance;
  ok(
    await post(
      f.staff.admin,
      "/api/staff/attendance/" + record.id + "/review",
      {
        expectedRevision: 0,
        overtimeMinutes: 60,
        reason: "Night duty overtime accepted",
      },
    ),
  );
  ok(
    await patch(
      f.staff.admin,
      "/api/staff/attendance/" + record.id + "/correct",
      {
        expectedRevision: 1,
        inAt: "2026-10-31T23:00:00+06:00",
        outAt: "2026-11-01T07:00:00+06:00",
        breakMinutes: 30,
        reason: "Corrected actual departure evidence",
      },
    ),
  );
  const corrected = await f.store.attendance.findOne({
    _id: new ObjectId(record.id),
  });
  assert.equal(corrected.workDay, "2026-10-31");
  assert.equal(corrected.status, "submitted");
  assert.equal(corrected.overtimeMinutes, undefined);
});
