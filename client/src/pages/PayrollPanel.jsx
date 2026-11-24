import { useState } from "react";
import {
  api,
  requestKey,
  localDate,
  dhakaTime,
  parseMinor,
  money,
} from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
import { useApp } from "../lib/AppContext";
const dateTime = (value) =>
  value
    ? new Date(new Date(value).getTime() + 6 * 3600000)
        .toISOString()
        .slice(0, 16)
    : "";
const iso = (value) => value + ":00+06:00";
const lastMonth = () => {
  const [y, m] = localDate().slice(0, 7).split("-").map(Number);
  return (
    String(m === 1 ? y - 1 : y) +
    "-" +
    String(m === 1 ? 12 : m - 1).padStart(2, "0")
  );
};
export function MyAttendance() {
  const resource = useResource("/staff/attendance/me", { interval: 15000 }),
    [rosterId, setRosterId] = useState(""),
    [breaks, setBreaks] = useState("0"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    open = resource.data?.records.find((row) => row.open);
  async function clock() {
    setBusy(true);
    setError("");
    try {
      await api(
        open
          ? "/staff/attendance/" + open.id + "/clock-out"
          : "/staff/attendance/clock-in",
        {
          method: "POST",
          data: open
            ? { breakMinutes: Number(breaks), expectedRevision: open.revision }
            : { rosterId },
        },
      );
      await resource.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  return (
    <section className="v29-panel">
      <div className="panel-heading">
        <div>
          <h2>My attendance & duty</h2>
          <p>
            Times are recorded by the server. Your manager reviews attendance
            and overtime before payroll.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh my duty
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <article className="commerce-card v29-self-clock">
        {open ? (
          <>
            <p>Clocked in: {dhakaTime(open.inAt)}</p>
            <label>
              Unpaid break minutes
              <input
                aria-label="My unpaid break minutes"
                type="number"
                min={0}
                max={720}
                step={1}
                value={breaks}
                onChange={(e) => setBreaks(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            Current duty
            <select
              aria-label="My current duty"
              value={rosterId}
              onChange={(e) => setRosterId(e.target.value)}
            >
              <option value="">Choose your duty</option>
              {resource.data?.rosters.map((row) => (
                <option key={row.id} value={row.id}>
                  {dhakaTime(row.startAt)} – {dhakaTime(row.endAt)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button disabled={busy || (!open && !rosterId)} onClick={clock}>
          {open ? "Clock out" : "Clock in"}
        </Button>
      </article>
      <h3>My attendance records</h3>
      <div className="v29-table-wrap">
        <table className="v29-table">
          <thead>
            <tr>
              <th>Duty day</th>
              <th>In / out</th>
              <th>Net / approved overtime</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {resource.data?.records.map((row) => (
              <tr key={row.id}>
                <td>{row.workDay}</td>
                <td>
                  {dhakaTime(row.inAt)}
                  <small>
                    {row.outAt ? dhakaTime(row.outAt) : "Still clocked in"}
                  </small>
                </td>
                <td>
                  {row.netMinutes ?? "—"} / {row.overtimeMinutes ?? "—"} minutes
                </td>
                <td>{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Approved payroll summaries</h3>
      {resource.data?.payslips.map((row) => (
        <article className="commerce-card" key={row.id}>
          <h4>{row.period}</h4>
          <p>
            {money(row.line.totalMinor / 100)} · {row.line.regularMinutes}{" "}
            regular minutes · {row.line.overtimeMinutes} overtime minutes
          </p>
          <p className="commerce-note">
            Payroll approved. Actual payment is recorded separately by the
            cashier.
          </p>
        </article>
      ))}
    </section>
  );
}
export default function PayrollPanel({ user }) {
  const canAttendance = user.capabilities?.["attendance.manage"] !== false,
    canPayroll = user.capabilities?.["payroll.manage"] !== false;
  const [month, setMonth] = useState(localDate().slice(0, 7)),
    attendance = useResource("/staff/attendance/manage?month=" + month, {
      enabled: canAttendance,
      interval: 15000,
    }),
    payroll = useResource("/staff/payroll", {
      enabled: canPayroll,
      interval: 15000,
    }),
    [action, setAction] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    { notify } = useApp();
  function open(type, row) {
    setAction({ type, row });
    setError("");
    setValues({
      staffId: row?.staffId || "",
      startAt: "",
      endAt: "",
      inAt: dateTime(row?.inAt),
      outAt: dateTime(row?.outAt),
      breakMinutes: row?.breakMinutes || 0,
      notes: "",
      reason: "",
      overtimeMinutes: Math.max(
        0,
        (row?.netMinutes || 0) - (row?.scheduledMinutes || 0),
      ),
      mode: row?.mode || "monthly",
      monthly: String((row?.monthlyMinor || 0) / 100),
      hourly: String((row?.hourlyMinor || 0) / 100),
      overtimeHourly: String((row?.overtimeHourlyMinor || 0) / 100),
      enabled: row?.enabled ?? true,
      period: lastMonth(),
      verified: false,
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { type, row } = action;
      let path,
        data,
        method = "POST";
      if (type === "roster") {
        path = "/attendance/rosters";
        data = {
          staffId: values.staffId,
          startAt: iso(values.startAt),
          endAt: iso(values.endAt),
          breakMinutes: Number(values.breakMinutes),
          notes: values.notes,
          requestKey: requestKey(),
        };
      } else if (type === "manual") {
        path = "/attendance/manual";
        data = {
          rosterId: row.id,
          inAt: iso(values.inAt),
          outAt: iso(values.outAt),
          breakMinutes: Number(values.breakMinutes),
          reason: values.reason,
        };
      } else if (type === "review") {
        path = "/attendance/" + row.id + "/review";
        data = {
          expectedRevision: row.revision,
          overtimeMinutes: Number(values.overtimeMinutes),
          reason: values.reason,
        };
      } else if (type === "correct") {
        path = "/attendance/" + row.id + "/correct";
        method = "PATCH";
        data = {
          expectedRevision: row.revision,
          inAt: iso(values.inAt),
          outAt: iso(values.outAt),
          breakMinutes: Number(values.breakMinutes),
          reason: values.reason,
        };
      } else if (type === "cancelRoster") {
        path = "/attendance/rosters/" + row.id + "/cancel";
        data = { expectedRevision: row.revision, reason: values.reason };
      } else if (type === "profile") {
        path = "/payroll/profiles/" + values.staffId;
        method = "PUT";
        data = {
          mode: values.mode,
          monthlyMinor: parseMinor(values.monthly),
          hourlyMinor: parseMinor(values.hourly),
          overtimeHourlyMinor: parseMinor(values.overtimeHourly),
          enabled: values.enabled,
          expectedRevision: row?.revision || 0,
          reason: values.reason,
        };
      } else if (type === "generate") {
        path = "/payroll/runs";
        data = { period: values.period, reason: values.reason };
      } else {
        path = "/payroll/runs/" + row.id + "/" + type;
        data = {
          expectedRevision: row.revision,
          reason: values.reason,
          ...(type === "approve" ? { verified: values.verified } : {}),
        };
      }
      await api("/staff" + path, { method, data });
      setAction(null);
      await Promise.all([attendance.reload(), payroll.reload()]);
      notify("Attendance or payroll record saved.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const field = (key, label, type = "text", props = {}) => (
    <label key={key}>
      {label}
      <input
        aria-label={label}
        required
        type={type}
        value={values[key] ?? ""}
        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
        {...props}
      />
    </label>
  );
  if ((canAttendance && attendance.loading) || (canPayroll && payroll.loading))
    return <Loading />;
  return (
    <section className="v29-panel">
      <div className="panel-heading">
        <div>
          <h2>Staff attendance & payroll</h2>
          <p>
            Plan duties, review actual hours and overtime, then approve a
            monthly salary expense.
          </p>
        </div>
        <Button
          secondary
          onClick={() => {
            void attendance.reload();
            void payroll.reload();
          }}
        >
          Refresh payroll desk
        </Button>
      </div>
      {(attendance.error || payroll.error) && (
        <ErrorMessage>
          {attendance.error?.message || payroll.error?.message}
        </ErrorMessage>
      )}
      <div className="v29-inline">
        <label>
          Duty month
          <input
            aria-label="Duty month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        {canAttendance && (
          <Button onClick={() => open("roster")}>Add duty roster</Button>
        )}
        {canPayroll && (
          <Button secondary onClick={() => open("profile")}>
            Configure salary profile
          </Button>
        )}
        {canPayroll && (
          <Button secondary onClick={() => open("generate")}>
            Generate payroll draft
          </Button>
        )}
      </div>
      {canAttendance && (
        <>
          <h3>Duty roster</h3>
          <div className="commerce-staff-grid">
            {attendance.data?.rosters.map((row) => (
              <article className="commerce-card" key={row.id}>
                <h4>{row.staffName}</h4>
                <p>
                  {dhakaTime(row.startAt)} – {dhakaTime(row.endAt)}
                </p>
                <p>
                  {row.breakMinutes} unpaid break minutes · {row.status}
                </p>
                {row.status === "scheduled" &&
                  !attendance.data.records.some(
                    (record) => record.rosterId === row.id,
                  ) && (
                    <div className="commerce-inline-actions">
                      <Button
                        secondary
                        onClick={() => {
                          open("manual", row);
                          setValues((v) => ({
                            ...v,
                            inAt: dateTime(row.startAt),
                            outAt: dateTime(row.endAt),
                          }));
                        }}
                      >
                        Record actual attendance
                      </Button>
                      <Button
                        secondary
                        onClick={() => open("cancelRoster", row)}
                      >
                        Cancel duty
                      </Button>
                    </div>
                  )}
              </article>
            ))}
          </div>
          <h3>Attendance review</h3>
          <div className="v29-table-wrap">
            <table className="v29-table">
              <thead>
                <tr>
                  <th>Staff / day</th>
                  <th>Actual attendance</th>
                  <th>Net / scheduled</th>
                  <th>Status</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {attendance.data?.records.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.staffName}
                      <small>{row.workDay}</small>
                    </th>
                    <td>
                      {dhakaTime(row.inAt)}
                      <small>
                        {row.outAt ? dhakaTime(row.outAt) : "Open shift"}
                      </small>
                    </td>
                    <td>
                      {row.netMinutes ?? "—"} / {row.scheduledMinutes} min
                    </td>
                    <td>{row.status}</td>
                    <td>
                      {row.status === "submitted" && (
                        <Button secondary onClick={() => open("review", row)}>
                          Review attendance
                        </Button>
                      )}
                      <Button secondary onClick={() => open("correct", row)}>
                        Correct recorded time
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {canPayroll && (
        <>
          <h3>Salary profiles</h3>
          <div className="commerce-staff-grid">
            {payroll.data?.profiles.map((row) => (
              <article className="commerce-card" key={row.staffId}>
                <h4>{row.staffName}</h4>
                <p>
                  {row.mode === "monthly"
                    ? money(row.monthlyMinor / 100) + " / month"
                    : money(row.hourlyMinor / 100) + " / hour"}{" "}
                  · Overtime {money(row.overtimeHourlyMinor / 100)} / hour
                </p>
                <p>{row.enabled ? "Included in payroll" : "Disabled"}</p>
                <Button secondary onClick={() => open("profile", row)}>
                  Edit salary profile
                </Button>
              </article>
            ))}
          </div>
          <h3>Monthly payroll</h3>
          {payroll.data?.runs.map((row) => (
            <article className="commerce-card" key={row.id}>
              <div className="v27-inline">
                <h4>{row.period}</h4>
                <strong>
                  {money(row.totalMinor / 100)} · {row.status}
                </strong>
              </div>
              <div className="v29-table-wrap">
                <table className="v29-table">
                  <thead>
                    <tr>
                      <th>Staff</th>
                      <th>Regular / overtime minutes</th>
                      <th>Base pay</th>
                      <th>Overtime pay</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.lines.map((line) => (
                      <tr key={line.staffId}>
                        <td>{line.staffName}</td>
                        <td>
                          {line.regularMinutes} / {line.overtimeMinutes}
                        </td>
                        <td>{money(line.baseMinor / 100)}</td>
                        <td>{money(line.overtimeMinor / 100)}</td>
                        <td>{money(line.totalMinor / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {row.status === "draft" ? (
                <div className="commerce-inline-actions">
                  <Button secondary onClick={() => open("rebuild", row)}>
                    Rebuild payroll draft
                  </Button>
                  <Button onClick={() => open("approve", row)}>
                    Review & approve payroll
                  </Button>
                </div>
              ) : (
                <p className="commerce-note">
                  Salary expense approved. Record actual bank or cash payment in
                  Expenses & operating result; this payroll approval did not
                  spend drawer cash.
                </p>
              )}
            </article>
          ))}
          <p className="commerce-note">{payroll.data?.policy}</p>
        </>
      )}
      {action && (
        <Modal
          open
          title={
            {
              roster: "Add duty roster",
              manual: "Record actual attendance",
              review: "Review attendance",
              correct: "Correct attendance",
              cancelRoster: "Cancel duty",
              profile: "Salary profile",
              generate: "Generate payroll draft",
              approve: "Approve payroll",
              rebuild: "Rebuild payroll draft",
            }[action.type]
          }
          className="management-dialog"
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            {["roster", "profile"].includes(action.type) && (
              <label>
                Staff member
                <select
                  aria-label="Payroll staff member"
                  required
                  value={values.staffId}
                  disabled={Boolean(action.row?.staffId)}
                  onChange={(e) =>
                    setValues({ ...values, staffId: e.target.value })
                  }
                >
                  <option value="">Choose staff</option>
                  {[
                    ...new Map(
                      [
                        ...(payroll.data?.staff || []),
                        ...(attendance.data?.staff || []),
                      ].map((row) => [row.id, row]),
                    ).values(),
                  ].map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action.type === "roster" && (
              <>
                {field("startAt", "Duty starts (Dhaka)", "datetime-local")}
                {field("endAt", "Duty ends (Dhaka)", "datetime-local")}
                {field("notes", "Duty notes", "text", {
                  required: false,
                  maxLength: 160,
                })}
              </>
            )}
            {["manual", "correct"].includes(action.type) && (
              <>
                {field("inAt", "Actual clock in (Dhaka)", "datetime-local")}
                {field("outAt", "Actual clock out (Dhaka)", "datetime-local")}
              </>
            )}
            {["roster", "manual", "correct"].includes(action.type) &&
              field("breakMinutes", "Unpaid break minutes", "number", {
                min: 0,
                max: 720,
                step: 1,
              })}
            {action.type === "review" && (
              <>
                <p>
                  Net attendance {action.row.netMinutes} minutes; scheduled{" "}
                  {action.row.scheduledMinutes} minutes. Only verified extra
                  time is paid as overtime.
                </p>
                {field(
                  "overtimeMinutes",
                  "Approved overtime minutes",
                  "number",
                  {
                    min: 0,
                    max: Math.max(
                      0,
                      action.row.netMinutes - action.row.scheduledMinutes,
                    ),
                    step: 1,
                  },
                )}
              </>
            )}
            {action.type === "profile" && (
              <>
                <label>
                  Pay mode
                  <select
                    aria-label="Salary pay mode"
                    value={values.mode}
                    onChange={(e) =>
                      setValues({ ...values, mode: e.target.value })
                    }
                  >
                    <option value="monthly">Fixed monthly salary</option>
                    <option value="hourly">Approved hourly work</option>
                  </select>
                </label>
                {field("monthly", "Monthly salary (৳)", "number", {
                  min: 0,
                  step: "0.01",
                })}
                {field("hourly", "Regular hourly rate (৳)", "number", {
                  min: 0,
                  step: "0.01",
                })}
                {field("overtimeHourly", "Overtime hourly rate (৳)", "number", {
                  min: 0,
                  step: "0.01",
                })}
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={values.enabled}
                    onChange={(e) =>
                      setValues({ ...values, enabled: e.target.checked })
                    }
                  />
                  Include this profile in payroll
                </label>
              </>
            )}
            {action.type === "generate" &&
              field("period", "Payroll month", "month")}
            {action.type !== "roster" &&
              field("reason", "Attendance or payroll reason", "text", {
                minLength: 3,
                maxLength: 160,
              })}
            {action.type === "approve" && (
              <label className="check-line">
                <input
                  aria-label="Payroll reviewed and verified"
                  required
                  type="checkbox"
                  checked={values.verified}
                  onChange={(e) =>
                    setValues({ ...values, verified: e.target.checked })
                  }
                />
                I reviewed attendance, rates and overtime. Create the salary
                expense without recording a payment.
              </label>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Save attendance or payroll action
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
