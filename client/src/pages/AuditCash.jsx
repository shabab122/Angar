import { branchUrl } from "../lib/branch";
import { useState } from "react";
import { Download, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, localDate, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
import { minorAmount } from "../components/Financial";

export function AuditDashboard() {
  const { money } = useApp();
  const [form, setForm] = useState({
    start: localDate(new Date(Date.now() - 6 * 86400000)),
    end: localDate(),
    type: "",
    actor: "",
    q: "",
  });
  const [filters, setFilters] = useState(form),
    [cursors, setCursors] = useState([""]);
  const query = new URLSearchParams({ ...filters, cursor: cursors.at(-1) }),
    resource = useResource("/staff/audit?" + query);
  const edit = (field) => (event) =>
    setForm({ ...form, [field]: event.target.value });
  return (
    <section className="audit-dashboard">
      <div className="panel-heading">
        <div>
          <h2>Staff activity</h2>
          <p>
            Search recorded actions, decisions and financial references. Date
            filters use Bangladesh time.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh activity
        </Button>
      </div>
      <form
        className="commerce-form commerce-card"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...form });
          setCursors([""]);
        }}
      >
        <div className="v25-form-grid">
          <label>
            From date
            <input
              aria-label="Activity from date"
              type="date"
              required
              value={form.start}
              onChange={edit("start")}
            />
          </label>
          <label>
            Through date
            <input
              aria-label="Activity through date"
              type="date"
              required
              min={form.start}
              value={form.end}
              onChange={edit("end")}
            />
          </label>
          <label>
            Action
            <select
              aria-label="Activity action"
              value={form.type}
              onChange={edit("type")}
            >
              <option value="">All actions</option>
              {resource.data?.types.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Staff username
            <input
              aria-label="Activity staff username"
              maxLength={40}
              value={form.actor}
              onChange={edit("actor")}
              placeholder="All staff"
            />
          </label>
        </div>
        <label>
          Search action, username or reason
          <input
            aria-label="Activity search"
            maxLength={80}
            value={form.q}
            onChange={edit("q")}
          />
        </label>
        <div className="commerce-inline-actions">
          <Button type="submit">Apply activity filters</Button>
          <a
            className="button button-secondary"
            href={branchUrl(
              "/api/staff/audit/export.csv?" + new URLSearchParams(filters),
            )}
          >
            <Download size={15} />
            Export filtered CSV
          </a>
        </div>
      </form>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          <div className="commerce-table-scroll">
            <table className="v25-table audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action / actor</th>
                  <th>Reason</th>
                  <th>References</th>
                </tr>
              </thead>
              <tbody>
                {resource.data?.records.map((row) => (
                  <tr key={row.id}>
                    <td>{row.at ? dhakaTime(row.at) : "—"}</td>
                    <td>
                      <strong>{row.type}</strong>
                      <small>{row.by}</small>
                      {row.amountMinor !== null && (
                        <small>{money(row.amountMinor / 100)}</small>
                      )}
                    </td>
                    <td>{row.reason || "—"}</td>
                    <td>
                      {Object.entries(row.references).map(([key, value]) => (
                        <small key={key}>
                          <b>{key}</b>: {value}
                        </small>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!resource.data?.records.length && (
            <p className="commerce-note">
              No recorded activity matches these filters.
            </p>
          )}
          <div className="commerce-inline-actions">
            <Button
              secondary
              disabled={cursors.length === 1}
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              Previous activity page
            </Button>
            <span className="commerce-note">
              Page {cursors.length} · up to 50 records
            </span>
            <Button
              secondary
              disabled={!resource.data?.nextCursor}
              onClick={() => setCursors([...cursors, resource.data.nextCursor])}
            >
              Next activity page
            </Button>
          </div>
          <p className="commerce-note">
            Activity records are read-only. Passwords, authentication codes and
            private keys are excluded from this view and its export.
          </p>
        </>
      )}
    </section>
  );
}

function CashShiftDetails({ id, onClose }) {
  const { money } = useApp(),
    resource = useResource("/staff/cash-drawer/" + id, { interval: 4000 }),
    shift = resource.data?.shift;
  return (
    <Modal
      open
      title="Cash shift statement"
      className="management-dialog cash-statement"
      onClose={onClose}
    >
      {resource.error ? (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      ) : !shift ? (
        <Loading />
      ) : (
        <>
          <h2>{shift.code}</h2>
          <p className="commerce-note">
            Opened by {shift.openedBy} · {dhakaTime(shift.openedAt)}
            {shift.closedAt && (
              <>
                <br />
                Closed by {shift.closedBy} · {dhakaTime(shift.closedAt)}
              </>
            )}
          </p>
          <div className="v25-metrics">
            {[
              ["Opening cash", shift.openingMinor],
              ["Cash received", shift.cashInMinor],
              ["Cash paid out", shift.cashOutMinor],
              ["Expected cash", shift.expectedMinor],
              ["Counted cash", shift.countedMinor],
              ["Difference", shift.varianceMinor],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{value === null ? "—" : money(value / 100)}</strong>
              </div>
            ))}
          </div>
          <div className="commerce-table-scroll">
            <table className="v25-table">
              <thead>
                <tr>
                  <th>Time / type</th>
                  <th>Reference / staff</th>
                  <th>Cash change</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.movements.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {dhakaTime(row.at)}
                      <small>{row.kind.replaceAll("_", " ")}</small>
                    </td>
                    <td>
                      {row.reference || row.sourceId || "—"}
                      <small>{row.by}</small>
                      <small>{row.reason}</small>
                    </td>
                    <td>{money(row.deltaMinor / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {resource.data.more && (
            <p className="commerce-note">
              Showing the first 500 movements. Use the statement export for this
              shift.
            </p>
          )}
          <p>{shift.closingReason || shift.reason}</p>
          {shift.review && (
            <p className="commerce-note">
              Reviewed by {shift.review.by}: {shift.review.reason}
            </p>
          )}
          <a
            className="button button-secondary"
            href={branchUrl("/api/staff/cash-drawer/" + id + "/export.csv")}
          >
            <Download size={15} />
            Download shift CSV
          </a>
        </>
      )}
    </Modal>
  );
}

export function CashDrawerPanel({ user }) {
  const { money, notify } = useApp(),
    resource = useResource("/staff/cash-drawer", { interval: 5000 });
  const [action, setAction] = useState(null),
    [details, setDetails] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function open(type, shift) {
    setAction({ type, shift, key: requestKey() });
    setValues({
      amount: "",
      direction: "in",
      reason: "",
      reference: "",
      verified: false,
    });
    setError("");
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const amount = minorAmount(values.amount),
        type = action.type;
      const path =
        type === "open"
          ? "/staff/cash-drawer/open"
          : type === "movement"
            ? "/staff/cash-drawer/movements"
            : "/staff/cash-drawer/" +
              action.shift.id +
              (type === "close" ? "/close" : "/review");
      const data =
        type === "review"
          ? { reason: values.reason }
          : {
              reason: values.reason,
              verified: values.verified,
              requestKey: action.key,
              ...(type === "open"
                ? { openingMinor: amount }
                : type === "close"
                  ? {
                      countedMinor: amount,
                      expectedRevision: action.shift.revision,
                    }
                  : {
                      amountMinor: amount,
                      direction: values.direction,
                      reference: values.reference,
                    }),
            };
      if (type !== "review" && amount === null)
        throw new Error(
          "Enter an exact amount with at most two decimal places.",
        );
      await api(path, { method: "POST", data });
      setAction(null);
      await resource.reload();
      notify("Cash drawer updated.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const active = resource.data?.active;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Cash drawer & shifts</h2>
          <p>
            One shared restaurant drawer. Opening cash, verified cash receipts
            and returns determine the expected closing count.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh drawer
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          <article className="commerce-card">
            <div className="commerce-section-heading">
              <h3>
                <Wallet size={18} />
                {active ? active.code + " · Open" : "No open cash shift"}
              </h3>
            </div>
            {active ? (
              <>
                <p className="commerce-note">
                  Opened by {active.openedBy} · {dhakaTime(active.openedAt)}
                </p>
                <div className="v25-metrics">
                  {[
                    ["Opening cash", active.openingMinor],
                    ["Cash received", active.cashInMinor],
                    ["Cash paid out", active.cashOutMinor],
                    ["Expected in drawer", active.expectedMinor],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <small>{label}</small>
                      <strong>{money(value / 100)}</strong>
                    </div>
                  ))}
                </div>
                {active.expectedMinor < 0 && (
                  <ErrorMessage>
                    The recorded cash balance is negative. Review receipts,
                    returns and cash top-ups before closing.
                  </ErrorMessage>
                )}
                <div className="commerce-inline-actions">
                  <Button secondary onClick={() => open("movement", active)}>
                    Record cash in / out
                  </Button>
                  <Button secondary onClick={() => setDetails(active.id)}>
                    View active statement
                  </Button>
                  <Button onClick={() => open("close", active)}>
                    Count & close shift
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="commerce-note">
                  Count the cash physically present before opening. Payments
                  received without an open shift remain in the separate list
                  below.
                </p>
                <Button onClick={() => open("open")}>Open cash shift</Button>
              </>
            )}
          </article>
          <h3>Recent shifts</h3>
          <div className="commerce-staff-grid">
            {resource.data?.shifts.map((shift) => (
              <article className="commerce-card" key={shift.id}>
                <div className="commerce-section-heading">
                  <h3>{shift.code}</h3>
                  <span className="management-status">{shift.status}</span>
                </div>
                <p className="commerce-note">
                  {dhakaTime(shift.openedAt)} · {shift.openedBy}
                </p>
                <p>
                  Expected {money(shift.expectedMinor / 100)}
                  {shift.countedMinor !== null && (
                    <>
                      {" "}
                      · Counted {money(shift.countedMinor / 100)}
                      <br />
                      Difference{" "}
                      <strong>{money(shift.varianceMinor / 100)}</strong>
                    </>
                  )}
                </p>
                {shift.review && (
                  <p className="commerce-note">
                    <ShieldCheck size={14} />
                    Reviewed by {shift.review.by}
                  </p>
                )}
                <div className="commerce-inline-actions">
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => setDetails(shift.id)}
                  >
                    View shift statement
                  </Button>
                  {user.role === "admin" &&
                    shift.status === "closed" &&
                    !shift.review && (
                      <Button
                        secondary
                        className="button-small"
                        onClick={() => open("review", shift)}
                      >
                        Review closing difference
                      </Button>
                    )}
                </div>
              </article>
            ))}
          </div>
          <details className="commerce-card v25-details">
            <summary>Cash activity without an open shift</summary>
            <p className="commerce-note">
              These verified transactions were recorded while the shared drawer
              was closed. They are retained for review and are not added to a
              later shift.
            </p>
            <div className="commerce-table-scroll">
              <table className="v25-table">
                <thead>
                  <tr>
                    <th>Time / type</th>
                    <th>Reference</th>
                    <th>Cash change</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data?.unassigned.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {dhakaTime(row.at)}
                        <small>
                          {row.kind.replaceAll("_", " ")} · {row.by}
                        </small>
                      </td>
                      <td>{row.reference || row.sourceId || "—"}</td>
                      <td>{money(row.deltaMinor / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!resource.data?.unassigned.length && (
              <p className="commerce-note">No unassigned cash activity.</p>
            )}
          </details>
        </>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "open"
              ? "Open cash shift"
              : action.type === "close"
                ? "Count & close shift"
                : action.type === "review"
                  ? "Review closing difference"
                  : "Record cash movement"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
          className="management-dialog"
        >
          <form className="commerce-form" onSubmit={submit}>
            {action.shift && (
              <p>
                {action.shift.code} · Expected{" "}
                {money(action.shift.expectedMinor / 100)}
              </p>
            )}
            {action.type === "movement" && (
              <label>
                Direction
                <select
                  aria-label="Cash movement direction"
                  value={values.direction}
                  onChange={(event) =>
                    setValues({ ...values, direction: event.target.value })
                  }
                >
                  <option value="in">Cash added / top-up</option>
                  <option value="out">Cash removed / withdrawal</option>
                </select>
              </label>
            )}
            {action.type !== "review" && (
              <label>
                {action.type === "open"
                  ? "Opening cash counted (BDT)"
                  : action.type === "close"
                    ? "Closing cash counted (BDT)"
                    : "Cash amount (BDT)"}
                <input
                  aria-label="Cash amount (BDT)"
                  inputMode="decimal"
                  required
                  value={values.amount}
                  onChange={(event) =>
                    setValues({ ...values, amount: event.target.value })
                  }
                />
              </label>
            )}
            {action.type === "movement" && (
              <label>
                Reference (optional)
                <input
                  maxLength={80}
                  value={values.reference}
                  onChange={(event) =>
                    setValues({ ...values, reference: event.target.value })
                  }
                />
              </label>
            )}
            <label>
              Reason
              <textarea
                aria-label="Cash action reason"
                required
                minLength={3}
                maxLength={160}
                value={values.reason}
                onChange={(event) =>
                  setValues({ ...values, reason: event.target.value })
                }
              />
            </label>
            {action.type !== "review" && (
              <label className="commerce-checkbox">
                <input
                  type="checkbox"
                  required
                  checked={values.verified}
                  onChange={(event) =>
                    setValues({ ...values, verified: event.target.checked })
                  }
                />
                <span>
                  I physically counted this cash or verified this cash movement.
                </span>
              </label>
            )}
            {action.type === "close" && (
              <>
                <p className="commerce-note">
                  Closed shifts keep their original count and expected balance.
                  If new cash activity arrives during counting, refresh the
                  balance and recount before submitting.
                </p>
                <Button
                  secondary
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const next = await api("/staff/cash-drawer");
                      if (!next.active || next.active.id !== action.shift.id)
                        throw new Error(
                          "This shift is already closed. Refresh the drawer.",
                        );
                      setAction({
                        ...action,
                        shift: next.active,
                        key: requestKey(),
                      });
                      setValues({ ...values, amount: "", verified: false });
                      setError("");
                    } catch (failure) {
                      setError(failure.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Refresh balance & recount
                </Button>
              </>
            )}
            {action.type === "review" && (
              <p className="commerce-note">
                This records the administrator's review. The original closing
                count and difference remain unchanged.
              </p>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={busy || (action.type !== "review" && !values.verified)}
            >
              {action.type === "open"
                ? "Confirm opening count"
                : action.type === "close"
                  ? "Confirm closing count"
                  : action.type === "review"
                    ? "Save closing review"
                    : "Record verified cash movement"}
            </Button>
          </form>
        </Modal>
      )}
      {details && (
        <CashShiftDetails id={details} onClose={() => setDetails(null)} />
      )}
    </section>
  );
}
