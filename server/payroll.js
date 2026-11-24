import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import {
  assertStaffAction,
  assertApprovalLimit,
  hasBranchAccess,
} from "./access.js";
import { stockDay } from "./ingredient-batches.js";
import { ratioMinor } from "./inventory-cost.js";
const id = z.string().regex(/^[a-f0-9]{24}$/),
  key = z.string().regex(/^[a-f0-9]{32}$/),
  revision = z.number().int().min(0),
  reason = z.string().trim().min(3).max(160),
  money = z.number().int().min(0).max(1000000000),
  time = z.iso.datetime({ offset: true }),
  month = z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/);
const current = (store) => store.branchId || "main";
const view = (row) =>
  row
    ? {
        ...row,
        id: String(row._id),
        staffId: row.staffId ? String(row.staffId) : undefined,
        _id: undefined,
        fingerprint: undefined,
        requestKey: undefined,
      }
    : null;
async function employeeLock(store, staffId, session, allowInactive = false) {
  const user = await store.staff.findOneAndUpdate(
    { _id: staffId, ...(allowInactive ? {} : { active: true }) },
    { $inc: { attendanceRevision: 1 } },
    { session, returnDocument: "after" },
  );
  if (
    !user ||
    !(
      hasBranchAccess(
        allowInactive ? { ...user, active: true } : user,
        current(store),
      ) ||
      (allowInactive &&
        ((await store.payProfiles.findOne({ _id: staffId }, { session })) ||
          (await store.rosters.findOne(
            { staffId, branchId: current(store) },
            { session },
          ))))
    )
  )
    throw new HttpError(
      403,
      "STAFF_BRANCH",
      "Choose an active staff member assigned to this branch.",
    );
  return user;
}
function span(start, end) {
  const a = new Date(start),
    b = new Date(end),
    minutes = Math.floor((b - a) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
    throw new HttpError(
      400,
      "ATTENDANCE_TIME",
      "Use an increasing interval of no more than 24 hours.",
    );
  return { start: a, end: b, minutes };
}
const rosterSummary = (row) => ({
  id: String(row._id),
  staffId: String(row.staffId),
  staffName: row.staffName,
  startAt: row.startAt,
  endAt: row.endAt,
  breakMinutes: row.breakMinutes,
  status: row.status,
  revision: row.revision,
  notes: row.notes || "",
  workDay: row.workDay,
});
async function createAttendance(
  store,
  roster,
  start,
  end,
  breakMinutes,
  by,
  session,
  manual = false,
) {
  const measured = end ? span(start, end) : null;
  if (measured && breakMinutes >= measured.minutes)
    throw new HttpError(
      400,
      "ATTENDANCE_BREAK",
      "Unpaid breaks must be shorter than the recorded attendance.",
    );
  if (end && new Date(end) > new Date())
    throw new HttpError(
      400,
      "ATTENDANCE_FUTURE",
      "Record actual past attendance only.",
    );
  if (
    await store.attendance.findOne(
      {
        staffId: roster.staffId,
        $or: [
          { rosterId: roster._id },
          { open: true },
          ...(end
            ? [
                {
                  inAt: { $lt: new Date(end) },
                  outAt: { $gt: new Date(start) },
                },
              ]
            : []),
        ],
      },
      { session },
    )
  )
    throw new HttpError(
      409,
      "ATTENDANCE_OVERLAP",
      "This staff member already has an open, overlapping or recorded attendance interval.",
    );
  const row = {
    _id: new ObjectId(),
    branchId: current(store),
    staffId: roster.staffId,
    staffName: roster.staffName,
    rosterId: roster._id,
    workDay: roster.workDay,
    inAt: new Date(start),
    outAt: end ? new Date(end) : null,
    breakMinutes,
    scheduledMinutes: Math.max(
      0,
      Math.floor((roster.endAt - roster.startAt) / 60000) - roster.breakMinutes,
    ),
    netMinutes: measured ? measured.minutes - breakMinutes : null,
    status: end ? "submitted" : "open",
    open: !end,
    revision: 0,
    manual,
    by,
    createdAt: new Date(),
  };
  await store.attendance.insertOne(row, { session });
  return row;
}
export async function calculatePayroll(store, period, session) {
  const profiles = await store.payProfiles
    .find({ enabled: true }, { session })
    .sort({ _id: 1 })
    .limit(101)
    .toArray();
  if (!profiles.length || profiles.length > 100)
    throw new HttpError(
      409,
      "PAYROLL_PROFILES",
      "Configure between one and 100 salary profiles before generating payroll.",
    );
  const records = await store.attendance
    .find(
      {
        branchId: current(store),
        workDay: { $gte: period + "-01", $lt: nextMonth(period) + "-01" },
        staffId: { $in: profiles.map((p) => p._id) },
      },
      { session },
    )
    .limit(5001)
    .toArray();
  if (records.length > 5000)
    throw new HttpError(
      409,
      "PAYROLL_LIMIT",
      "The payroll attendance set exceeds its supported limit.",
    );
  if (records.some((row) => row.status !== "approved"))
    throw new HttpError(
      409,
      "PAYROLL_ATTENDANCE",
      "Close and review every included attendance record before generating payroll.",
    );
  const lines = [];
  for (const profile of profiles) {
    if (session)
      await store.staff.updateOne(
        { _id: profile._id },
        { $inc: { payrollRevision: 1 } },
        { session },
      );
    const rows = records.filter((row) => row.staffId.equals(profile._id)),
      regularMinutes = rows.reduce((s, row) => s + row.regularMinutes, 0),
      overtimeMinutes = rows.reduce((s, row) => s + row.overtimeMinutes, 0),
      baseMinor =
        profile.mode === "monthly"
          ? profile.monthlyMinor
          : regularMinutes
            ? ratioMinor(profile.hourlyMinor, regularMinutes, 60)
            : 0,
      overtimeMinor = overtimeMinutes
        ? ratioMinor(profile.overtimeHourlyMinor, overtimeMinutes, 60)
        : 0;
    lines.push({
      staffId: String(profile._id),
      staffName: profile.staffName,
      mode: profile.mode,
      monthlyMinor: profile.monthlyMinor,
      hourlyMinor: profile.hourlyMinor,
      overtimeHourlyMinor: profile.overtimeHourlyMinor,
      regularMinutes,
      overtimeMinutes,
      attendanceCount: rows.length,
      baseMinor,
      overtimeMinor,
      totalMinor: baseMinor + overtimeMinor,
      profileRevision: profile.revision,
      records: rows
        .map((row) => ({ id: String(row._id), revision: row.revision }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  const totalMinor = lines.reduce((s, line) => s + line.totalMinor, 0);
  if (!Number.isSafeInteger(totalMinor) || totalMinor > 10000000000)
    throw new HttpError(
      409,
      "PAYROLL_AMOUNT",
      "Payroll exceeds the supported exact-money limit.",
    );
  return { lines, totalMinor, snapshotHash: hash(JSON.stringify(lines)) };
}
function nextMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return (
    String(m === 12 ? y + 1 : y) +
    "-" +
    String(m === 12 ? 1 : m + 1).padStart(2, "0")
  );
}
export function registerPayroll(api, store, config, requireId) {
  api.get("/attendance/me", async (req, res) => {
    const [rosters, records, payslips] = await Promise.all([
      store.rosters
        .find({
          branchId: current(store),
          staffId: req.staff._id,
          status: "scheduled",
        })
        .sort({ startAt: -1 })
        .limit(40)
        .toArray(),
      store.attendance
        .find({ branchId: current(store), staffId: req.staff._id })
        .sort({ inAt: -1 })
        .limit(60)
        .toArray(),
      store.payrollRuns
        .find({ status: "approved", "lines.staffId": String(req.staff._id) })
        .sort({ period: -1 })
        .limit(12)
        .toArray(),
    ]);
    res.json({
      rosters: rosters.map(rosterSummary),
      records: records.map(view),
      payslips: payslips.map((row) => ({
        id: String(row._id),
        period: row.period,
        expenseId: row.expenseId ? String(row.expenseId) : null,
        line: row.lines.find((l) => l.staffId === String(req.staff._id)),
        status: row.status,
      })),
    });
  });
  api.post("/attendance/clock-in", async (req, res) => {
    const input = body(z.strictObject({ rosterId: id }), req.body),
      row = await transaction(store, async (session) => {
        await assertStaffAction(store, req.staff, "attendance.self", session);
        await employeeLock(store, req.staff._id, session);
        const roster = await store.rosters.findOne(
          {
            _id: new ObjectId(input.rosterId),
            branchId: current(store),
            staffId: req.staff._id,
            status: "scheduled",
          },
          { session },
        );
        const now = new Date();
        if (
          !roster ||
          now < new Date(roster.startAt.getTime() - 7200000) ||
          now > new Date(roster.endAt.getTime() + 14400000)
        )
          throw new HttpError(
            409,
            "ROSTER_WINDOW",
            "Choose your current duty, within two hours before its start and four hours after its end.",
          );
        return createAttendance(
          store,
          roster,
          now,
          null,
          0,
          req.staff.username,
          session,
        );
      });
    res.status(201).json({ attendance: view(row) });
  });
  api.post("/attendance/:id/clock-out", async (req, res) => {
    const input = body(
      z.strictObject({
        breakMinutes: z.number().int().min(0).max(720),
        expectedRevision: revision,
      }),
      req.body,
    );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "attendance.self", session);
      await employeeLock(store, req.staff._id, session);
      const row = await store.attendance.findOne(
        {
          _id: requireId(req.params.id),
          branchId: current(store),
          staffId: req.staff._id,
          open: true,
          revision: input.expectedRevision,
        },
        { session },
      );
      if (!row)
        throw new HttpError(
          409,
          "ATTENDANCE_UPDATED",
          "Reload your open attendance before clocking out.",
        );
      const minutes = Math.floor((Date.now() - row.inAt.getTime()) / 60000);
      if (minutes < 0 || minutes > 1440)
        throw new HttpError(
          409,
          "ATTENDANCE_TIME",
          "Ask a manager to correct this attendance interval.",
        );
      if (input.breakMinutes > minutes)
        throw new HttpError(
          400,
          "ATTENDANCE_BREAK",
          "Breaks must be shorter than your attendance.",
        );
      await store.attendance.updateOne(
        { _id: row._id },
        {
          $set: {
            outAt: new Date(),
            breakMinutes: input.breakMinutes,
            netMinutes: minutes - input.breakMinutes,
            open: false,
            status: "submitted",
          },
          $inc: { revision: 1 },
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.get("/attendance/manage", async (req, res) => {
    const period =
        req.query.month === undefined ? null : body(month, req.query.month),
      [start, end] = period
        ? [period + "-01", nextMonth(period) + "-01"]
        : [
            stockDay(new Date(Date.now() - 45 * 86400000)),
            stockDay(new Date(Date.now() + 45 * 86400000)),
          ],
      staff = await store.staff
        .find({ active: true }, { projection: { passwordHash: 0, mfa: 0 } })
        .sort({ username: 1 })
        .limit(1000)
        .toArray();
    res.json({
      staff: staff
        .filter((user) => hasBranchAccess(user, current(store)))
        .map((user) => ({
          id: String(user._id),
          name: user.name || user.username,
          username: user.username,
        })),
      rosters: (
        await store.rosters
          .find({
            branchId: current(store),
            workDay: { $gte: start, $lte: end },
          })
          .sort({ startAt: -1 })
          .limit(250)
          .toArray()
      ).map(rosterSummary),
      records: (
        await store.attendance
          .find({
            branchId: current(store),
            workDay: { $gte: start, $lte: end },
          })
          .sort({ inAt: -1 })
          .limit(250)
          .toArray()
      ).map(view),
    });
  });
  api.post("/attendance/rosters", async (req, res) => {
    const input = body(
        z.strictObject({
          staffId: id,
          startAt: time,
          endAt: time,
          breakMinutes: z.number().int().min(0).max(720),
          notes: z.string().trim().max(160),
          requestKey: key,
        }),
        req.body,
      ),
      interval = span(input.startAt, input.endAt),
      fingerprint = hash(JSON.stringify(input));
    if (input.breakMinutes >= interval.minutes)
      throw new HttpError(
        400,
        "ATTENDANCE_BREAK",
        "Scheduled breaks must be shorter than duty.",
      );
    const row = await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "attendance.manage", session);
      const user = await employeeLock(
          store,
          new ObjectId(input.staffId),
          session,
        ),
        prior = await store.rosters.findOne(
          { branchId: current(store), requestKey: input.requestKey },
          { session },
        );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another duty.",
          );
        return prior;
      }
      if (
        await store.rosters.findOne(
          {
            staffId: user._id,
            status: "scheduled",
            startAt: { $lt: interval.end },
            endAt: { $gt: interval.start },
          },
          { session },
        )
      )
        throw new HttpError(
          409,
          "ROSTER_OVERLAP",
          "This employee already has overlapping duty in a branch.",
        );
      const row = {
        _id: new ObjectId(),
        branchId: current(store),
        staffId: user._id,
        staffName: user.name || user.username,
        startAt: interval.start,
        endAt: interval.end,
        workDay: stockDay(interval.start),
        breakMinutes: input.breakMinutes,
        notes: input.notes,
        status: "scheduled",
        revision: 0,
        createdAt: new Date(),
        by: req.staff.username,
        requestKey: input.requestKey,
        fingerprint,
      };
      await store.rosters.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "attendance.roster_created",
          rosterId: row._id,
          staffId: user._id,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ roster: rosterSummary(row) });
  });
  api.post("/attendance/rosters/:id/cancel", async (req, res) => {
    const input = body(
      z.strictObject({ expectedRevision: revision, reason }),
      req.body,
    );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "attendance.manage", session);
      const roster = await store.rosters.findOne(
        {
          _id: requireId(req.params.id),
          branchId: current(store),
          status: "scheduled",
          revision: input.expectedRevision,
        },
        { session },
      );
      if (
        !roster ||
        (await store.attendance.findOne({ rosterId: roster._id }, { session }))
      )
        throw new HttpError(
          409,
          "ROSTER_USED",
          "Only an unchanged duty without attendance can be cancelled.",
        );
      await employeeLock(store, roster.staffId, session, true);
      await store.rosters.updateOne(
        { _id: roster._id },
        {
          $set: { status: "cancelled", cancelReason: input.reason },
          $inc: { revision: 1 },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "attendance.roster_cancelled",
          rosterId: roster._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.post("/attendance/manual", async (req, res) => {
    const input = body(
        z.strictObject({
          rosterId: id,
          inAt: time,
          outAt: time,
          breakMinutes: z.number().int().min(0).max(720),
          reason,
        }),
        req.body,
      ),
      row = await transaction(store, async (session) => {
        await assertStaffAction(store, req.staff, "attendance.manage", session);
        const roster = await store.rosters.findOne(
          {
            _id: new ObjectId(input.rosterId),
            branchId: current(store),
            status: "scheduled",
          },
          { session },
        );
        if (!roster) throw new HttpError(404, "NOT_FOUND", "Duty not found.");
        await employeeLock(store, roster.staffId, session, true);
        if (Math.abs(new Date(input.inAt) - roster.startAt) > 12 * 3600000)
          throw new HttpError(
            400,
            "ATTENDANCE_TIME",
            "Actual attendance must belong to this duty day.",
          );
        const row = await createAttendance(
          store,
          roster,
          input.inAt,
          input.outAt,
          input.breakMinutes,
          req.staff.username,
          session,
          true,
        );
        await store.audit.insertOne(
          {
            type: "attendance.manual_recorded",
            attendanceId: row._id,
            by: req.staff.username,
            reason: input.reason,
            at: new Date(),
          },
          { session },
        );
        return row;
      });
    res.status(201).json({ attendance: view(row) });
  });
  api.post("/attendance/:id/review", async (req, res) => {
    const input = body(
      z.strictObject({
        expectedRevision: revision,
        overtimeMinutes: z.number().int().min(0).max(1440),
        reason,
      }),
      req.body,
    );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "attendance.manage", session);
      const row = await store.attendance.findOne(
        {
          _id: requireId(req.params.id),
          branchId: current(store),
          status: "submitted",
          revision: input.expectedRevision,
        },
        { session },
      );
      if (!row)
        throw new HttpError(
          409,
          "ATTENDANCE_UPDATED",
          "Review an unchanged submitted attendance record.",
        );
      await employeeLock(store, row.staffId, session, true);
      const regularMinutes = Math.min(row.netMinutes, row.scheduledMinutes),
        extra = Math.max(0, row.netMinutes - row.scheduledMinutes);
      if (input.overtimeMinutes > extra)
        throw new HttpError(
          400,
          "OVERTIME_LIMIT",
          "Approve only overtime actually recorded beyond scheduled net duty.",
        );
      await store.attendance.updateOne(
        { _id: row._id },
        {
          $set: {
            regularMinutes,
            overtimeMinutes: input.overtimeMinutes,
            status: "approved",
            approvedBy: req.staff.username,
            approvedAt: new Date(),
            reason: input.reason,
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "attendance.approved",
          attendanceId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.patch("/attendance/:id/correct", async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: revision,
          inAt: time,
          outAt: time,
          breakMinutes: z.number().int().min(0).max(720),
          reason,
        }),
        req.body,
      ),
      interval = span(input.inAt, input.outAt);
    if (input.breakMinutes >= interval.minutes || interval.end > new Date())
      throw new HttpError(
        400,
        "ATTENDANCE_TIME",
        "Use actual past attendance and shorter unpaid breaks.",
      );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "attendance.manage", session);
      const row = await store.attendance.findOne(
        {
          _id: requireId(req.params.id),
          branchId: current(store),
          revision: input.expectedRevision,
        },
        { session },
      );
      if (!row)
        throw new HttpError(
          409,
          "ATTENDANCE_UPDATED",
          "Reload the record before correcting it.",
        );
      await employeeLock(store, row.staffId, session, true);
      if (
        await store.payrollRuns.findOne(
          { period: row.workDay.slice(0, 7), status: "approved" },
          { session },
        )
      )
        throw new HttpError(
          409,
          "PAYROLL_LOCKED",
          "Approved payroll is immutable. Record any reviewed adjustment separately in expenses.",
        );
      const roster = await store.rosters.findOne(
        { _id: row.rosterId },
        { session },
      );
      if (!roster || Math.abs(interval.start - roster.startAt) > 12 * 3600000)
        throw new HttpError(
          400,
          "ATTENDANCE_TIME",
          "The corrected time must belong to the original duty.",
        );
      if (
        await store.attendance.findOne(
          {
            _id: { $ne: row._id },
            staffId: row.staffId,
            $or: [
              { open: true },
              { inAt: { $lt: interval.end }, outAt: { $gt: interval.start } },
            ],
          },
          { session },
        )
      )
        throw new HttpError(
          409,
          "ATTENDANCE_OVERLAP",
          "Another attendance interval overlaps this correction.",
        );
      await store.attendance.updateOne(
        { _id: row._id },
        {
          $set: {
            inAt: interval.start,
            outAt: interval.end,
            breakMinutes: input.breakMinutes,
            netMinutes: interval.minutes - input.breakMinutes,
            open: false,
            status: "submitted",
            correctedBy: req.staff.username,
            correctionReason: input.reason,
          },
          $unset: {
            regularMinutes: "",
            overtimeMinutes: "",
            approvedAt: "",
            approvedBy: "",
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "attendance.corrected",
          attendanceId: row._id,
          before: {
            inAt: row.inAt,
            outAt: row.outAt,
            breakMinutes: row.breakMinutes,
          },
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.get("/payroll", async (req, res) =>
    res.json({
      staff: (
        await store.staff
          .find(
            {},
            {
              projection: {
                name: 1,
                username: 1,
                active: 1,
                role: 1,
                branchIds: 1,
              },
            },
          )
          .limit(1000)
          .toArray()
      )
        .filter((user) =>
          hasBranchAccess({ ...user, active: true }, current(store)),
        )
        .map((user) => ({
          id: String(user._id),
          name:
            (user.name || user.username) +
            (user.active === false ? " (inactive)" : ""),
        })),
      profiles: (
        await store.payProfiles
          .find({})
          .sort({ staffName: 1 })
          .limit(100)
          .toArray()
      ).map((row) => ({ ...row, staffId: String(row._id), _id: undefined })),
      runs: (
        await store.payrollRuns
          .find({})
          .sort({ period: -1 })
          .limit(24)
          .toArray()
      ).map(view),
      policy:
        "Hourly pay uses approved regular minutes; overtime uses separately approved minutes. Fixed monthly salary is the full configured amount, without inferred absence deductions. Shifts belong to the Dhaka month of their roster start. Approved payroll creates an approved salary expense, not a cash payment.",
    }),
  );
  api.put("/payroll/profiles/:id", async (req, res) => {
    const input = body(
        z.strictObject({
          mode: z.enum(["monthly", "hourly"]),
          monthlyMinor: money,
          hourlyMinor: money,
          overtimeHourlyMinor: money,
          enabled: z.boolean(),
          expectedRevision: revision,
          reason,
        }),
        req.body,
      ),
      staffId = requireId(req.params.id);
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "payroll.manage", session);
      const user = await employeeLock(store, staffId, session, true),
        old = await store.payProfiles.findOne({ _id: staffId }, { session });
      if ((old?.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "PAYROLL_PROFILE_UPDATED",
          "Salary settings changed. Reload before saving.",
        );
      const { expectedRevision, reason, ...settings } = input;
      await store.payProfiles.updateOne(
        { _id: staffId },
        {
          $set: {
            ...settings,
            staffName: user.name || user.username,
            by: req.staff.username,
            updatedAt: new Date(),
          },
          $inc: { revision: 1 },
        },
        { upsert: true, session },
      );
      await store.audit.insertOne(
        {
          type: "payroll.profile_updated",
          staffId,
          by: req.staff.username,
          reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.post("/payroll/runs", async (req, res) => {
    const input = body(z.strictObject({ period: month, reason }), req.body);
    if (input.period >= stockDay().slice(0, 7))
      throw new HttpError(
        409,
        "PAYROLL_PERIOD",
        "Generate payroll after the selected calendar month has ended.",
      );
    const row = await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "payroll.manage", session);
      await store.settings.updateOne(
        { _id: "payroll-run-lock" },
        { $inc: { revision: 1 } },
        { upsert: true, session },
      );
      const prior = await store.payrollRuns.findOne(
        { period: input.period },
        { session },
      );
      if (prior) return prior;
      const calculated = await calculatePayroll(store, input.period, session),
        row = {
          _id: new ObjectId(),
          period: input.period,
          ...calculated,
          status: "draft",
          revision: 0,
          createdAt: new Date(),
          createdBy: req.staff.username,
          reason: input.reason,
        };
      await store.payrollRuns.insertOne(row, { session });
      return row;
    });
    res.status(201).json({ run: view(row) });
  });
  api.post("/payroll/runs/:id/rebuild", async (req, res) => {
    const input = body(
      z.strictObject({ expectedRevision: revision, reason }),
      req.body,
    );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "payroll.manage", session);
      const row = await store.payrollRuns.findOne(
        {
          _id: requireId(req.params.id),
          status: "draft",
          revision: input.expectedRevision,
        },
        { session },
      );
      if (!row)
        throw new HttpError(
          409,
          "PAYROLL_UPDATED",
          "Reload an unapproved payroll draft before rebuilding.",
        );
      const calculated = await calculatePayroll(store, row.period, session);
      await store.payrollRuns.updateOne(
        { _id: row._id },
        {
          $set: { ...calculated, reason: input.reason, updatedAt: new Date() },
          $inc: { revision: 1 },
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
  api.post("/payroll/runs/:id/approve", async (req, res) => {
    const input = body(
      z.strictObject({
        expectedRevision: revision,
        reason,
        verified: z.literal(true),
      }),
      req.body,
    );
    const expenseId = await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "payroll.manage", session);
      await store.settings.updateOne(
        { _id: "payroll-run-lock" },
        { $inc: { revision: 1 } },
        { upsert: true, session },
      );
      const row = await store.payrollRuns.findOne(
        { _id: requireId(req.params.id) },
        { session },
      );
      if (row?.status === "approved") return row.expenseId || null;
      if (!row || row.revision !== input.expectedRevision)
        throw new HttpError(
          409,
          "PAYROLL_UPDATED",
          "Reload this payroll draft before approval.",
        );
      const calculated = await calculatePayroll(store, row.period, session);
      if (calculated.snapshotHash !== row.snapshotHash)
        throw new HttpError(
          409,
          "PAYROLL_STALE",
          "Attendance or salary settings changed. Rebuild and review the payroll draft.",
        );
      await assertApprovalLimit(
        store,
        req.staff,
        "expenseApproval",
        row.totalMinor,
        session,
      );
      const expenseId = row.totalMinor ? new ObjectId() : null,
        lastDay = new Date(
          new Date(nextMonth(row.period) + "-01T00:00:00+06:00").getTime() -
            86400000,
        );
      if (expenseId)
        await store.expenses.insertOne(
          {
            _id: expenseId,
            code:
              "EX-PAY-" +
              row.period +
              "-" +
              String(row._id).slice(-6).toUpperCase(),
            category: "salary",
            payee: "Staff payroll " + row.period,
            amountMinor: row.totalMinor,
            incurredOn: stockDay(lastDay),
            dueOn: "",
            reference: "Payroll " + row.period,
            notes: input.reason,
            requestKey: hash("payroll:" + row._id).slice(0, 32),
            fingerprint: row.snapshotHash,
            status: "approved",
            paidMinor: 0,
            payments: [],
            revision: 0,
            createdBy: req.staff.username,
            createdAt: new Date(),
            approvedBy: req.staff.username,
            approvedAt: new Date(),
            payrollRunId: row._id,
          },
          { session },
        );
      await store.payrollRuns.updateOne(
        { _id: row._id },
        {
          $set: {
            status: "approved",
            approvedBy: req.staff.username,
            approvedAt: new Date(),
            expenseId,
            approvalReason: input.reason,
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "payroll.approved",
          payrollRunId: row._id,
          amountMinor: row.totalMinor,
          expenseId,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return expenseId;
    });
    res.json({
      approved: true,
      expenseId: expenseId ? String(expenseId) : null,
    });
  });
}
