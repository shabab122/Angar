import { useEffect, useState } from "react";
import {
  CalendarDays,
  Check,
  CreditCard,
  Gift,
  Phone,
  Plus,
  RefreshCw,
  Users,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, localDate } from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Loading,
  Modal,
  Status,
} from "../components/UI";
import { minorAmount } from "../components/Financial";

export function ReservationDesk({ user, notify, onRefresh }) {
  const [date, setDate] = useState(localDate());
  const resource = useResource("/staff/reservations?date=" + date, {
    interval: 5000,
    enabled: date.length === 10,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reason, setReason] = useState(""),
    [decision, setDecision] = useState(null),
    [tables, setTables] = useState({});
  const [settings, setSettings] = useState(null),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (resource.data && !dirty) setSettings(resource.data.settings);
  }, [resource.data, dirty]);
  async function run(path, data, message) {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST", data });
      notify(message);
      setDecision(null);
      await resource.reload();
      onRefresh();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function requestDecision(path, action, title) {
    setDecision({ path, data: { action }, title });
    setReason("");
    setError("");
  }
  return (
    <section className="reservation-desk">
      <div className="panel-heading">
        <div>
          <h2>Reservations & waiting list</h2>
          <p>
            Bangladesh time · Seat reserved parties when their table is free.
          </p>
        </div>
        <label className="commerce-date-control">
          Booking date
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !decision && <ErrorMessage>{error}</ErrorMessage>}
      {resource.loading && !resource.data && <Loading />}
      <div className="commerce-staff-grid">
        {resource.data?.reservations.map((row) => (
          <article className="commerce-card" key={row.id}>
            <div className="commerce-section-heading">
              <h3>{row.code}</h3>
              <Status status={row.status} />
            </div>
            <h3>{row.name}</h3>
            <p>
              <CalendarDays size={14} />
              {dhakaTime(row.startsAt)} —{" "}
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Dhaka",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(row.endsAt))}
            </p>
            <p>
              <Users size={14} />
              {row.partySize} guests · Table {row.tableNumber.slice(1)}
            </p>
            <p>
              <a href={"tel:" + row.phone}>
                <Phone size={14} />
                {row.phone}
              </a>
            </p>
            {row.note && <p className="commerce-note">{row.note}</p>}
            {row.status === "confirmed" && (
              <div className="commerce-inline-actions">
                <Button
                  className="button-small"
                  disabled={
                    busy ||
                    new Date(row.startsAt).getTime() - Date.now() >
                      30 * 60000 ||
                    new Date(row.endsAt) <= new Date()
                  }
                  onClick={() =>
                    run(
                      "/staff/reservations/" + row.id + "/action",
                      { action: "seat" },
                      "Party seated. Ask guests to scan the table QR.",
                    )
                  }
                >
                  Seat party
                </Button>
                <Button
                  secondary
                  className="button-small"
                  disabled={busy}
                  onClick={() =>
                    requestDecision(
                      "/staff/reservations/" + row.id + "/action",
                      "cancel",
                      "Cancel reservation",
                    )
                  }
                >
                  Cancel
                </Button>
                <Button
                  secondary
                  className="button-small"
                  disabled={
                    busy ||
                    Date.now() < new Date(row.startsAt).getTime() + 15 * 60000
                  }
                  onClick={() =>
                    requestDecision(
                      "/staff/reservations/" + row.id + "/action",
                      "no_show",
                      "Mark reservation no-show",
                    )
                  }
                >
                  No-show
                </Button>
              </div>
            )}
            {row.status === "seated" && (
              <p className="commerce-note">
                The booking completes when the table visit closes through
                billing.
              </p>
            )}
          </article>
        ))}
      </div>
      {resource.data?.reservations.length === 0 && (
        <EmptyState
          icon={CalendarDays}
          title="No reservations for this date."
          text="Confirmed, seated and completed bookings appear here."
        />
      )}
      <section className="commerce-card">
        <h2>
          <Users size={21} />
          Today’s waiting list
        </h2>
        <p className="commerce-note">
          Contact the guest first, then mark the party called. No SMS or email
          is sent by this button.
        </p>
        <div className="commerce-staff-grid">
          {resource.data?.waitlist.map((row, index) => (
            <article className="waiting-party" key={row.id}>
              <span className="queue-position">#{index + 1}</span>
              <div>
                <h3>{row.name}</h3>
                <p>
                  {row.partySize} guests ·{" "}
                  <a href={"tel:" + row.phone}>{row.phone}</a>
                </p>
                <small>{dhakaTime(row.createdAt)}</small>
                <Status status={row.status} />
                {row.note && <p>{row.note}</p>}
              </div>
              <div className="commerce-form">
                {row.status === "waiting" && (
                  <Button
                    secondary
                    className="button-small"
                    disabled={busy}
                    onClick={() =>
                      run(
                        "/staff/waitlist/" + row.id + "/action",
                        { action: "call" },
                        "Party marked called.",
                      )
                    }
                  >
                    Mark party called
                  </Button>
                )}
                <label>
                  Table
                  <select
                    aria-label="Table"
                    value={tables[row.id] || ""}
                    onChange={(event) =>
                      setTables({ ...tables, [row.id]: event.target.value })
                    }
                  >
                    <option value="">Choose a suitable free table</option>
                    {resource.data.tables
                      .filter(
                        (table) =>
                          !table.open && table.capacity >= row.partySize,
                      )
                      .map((table) => (
                        <option key={table.number} value={table.number}>
                          {table.number} · {table.capacity} seats
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  className="button-small"
                  disabled={busy || !tables[row.id]}
                  onClick={() =>
                    run(
                      "/staff/waitlist/" + row.id + "/action",
                      { action: "seat", tableNumber: tables[row.id] },
                      "Party seated. Ask guests to scan their table QR.",
                    )
                  }
                >
                  Seat waiting party
                </Button>
                <button
                  className="text-link"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    requestDecision(
                      "/staff/waitlist/" + row.id + "/action",
                      "cancel",
                      "Remove waiting party",
                    )
                  }
                >
                  Remove with reason
                </button>
              </div>
            </article>
          ))}
        </div>
        {resource.data?.waitlist.length === 0 && (
          <p className="commerce-note">No parties are waiting.</p>
        )}
      </section>
      {user.role === "admin" && resource.data && (
        <section className="commerce-card">
          <h2>Reservation settings</h2>
          <div className="commerce-settings-grid">
            <form
              className="commerce-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  await api("/staff/reservation-settings", {
                    method: "PATCH",
                    data: settings,
                  });
                  setDirty(false);
                  await resource.reload();
                  notify(
                    "Reservation settings saved. Existing booking times are retained.",
                  );
                } catch (failure) {
                  setError(failure.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="commerce-two">
                {[
                  ["open", "Open"],
                  ["close", "Close"],
                ].map(([field, label]) => (
                  <label key={field}>
                    {label} (Bangladesh)
                    <input
                      type="time"
                      required
                      step="1800"
                      value={settings?.[field] || ""}
                      onChange={(event) => {
                        setDirty(true);
                        setSettings({
                          ...settings,
                          [field]: event.target.value,
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="commerce-two">
                <label>
                  Seating duration (minutes)
                  <input
                    required
                    type="number"
                    min="30"
                    max="240"
                    step="30"
                    value={settings?.durationMinutes || 90}
                    onChange={(event) => {
                      setDirty(true);
                      setSettings({
                        ...settings,
                        durationMinutes: Number(event.target.value),
                      });
                    }}
                  />
                </label>
                <label>
                  Days ahead
                  <input
                    required
                    type="number"
                    min="1"
                    max="180"
                    value={settings?.daysAhead || 90}
                    onChange={(event) => {
                      setDirty(true);
                      setSettings({
                        ...settings,
                        daysAhead: Number(event.target.value),
                      });
                    }}
                  />
                </label>
              </div>
              <label className="commerce-checkbox">
                <input
                  type="checkbox"
                  checked={settings?.enabled || false}
                  onChange={(event) => {
                    setDirty(true);
                    setSettings({ ...settings, enabled: event.target.checked });
                  }}
                />
                <span>Accept new reservations / waiting-list joins</span>
              </label>
              <Button
                type="submit"
                className="button-small"
                disabled={busy || !settings}
              >
                Save reservation settings
              </Button>
            </form>
            <div>
              <h3>Table capacities</h3>
              <p className="commerce-note">
                Existing tables default to four seats. Reducing capacity cannot
                invalidate an active reservation.
              </p>
              {resource.data.tables.map((table) => (
                <CapacityEditor
                  key={table.number}
                  table={table}
                  notify={notify}
                  reload={resource.reload}
                />
              ))}
            </div>
          </div>
        </section>
      )}
      {decision && (
        <Modal open onClose={() => setDecision(null)} title={decision.title}>
          <form
            className="commerce-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                decision.path,
                { ...decision.data, reason },
                "Booking queue updated.",
              );
            }}
          >
            <label>
              Reason
              <textarea
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Confirm change
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
function CapacityEditor({ table, notify, reload }) {
  const [capacity, setCapacity] = useState(table.capacity),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="capacity-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api("/staff/tables/" + table.number + "/capacity", {
            method: "PATCH",
            data: { capacity: Number(capacity) },
          });
          await reload();
          notify("Capacity updated.");
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {table.number} seats
        <input
          aria-label={table.number + " seats"}
          required
          type="number"
          min="1"
          max="30"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
        />
      </label>
      <Button secondary className="button-small" disabled={busy} type="submit">
        Save
      </Button>
      {error && <ErrorMessage>{error}</ErrorMessage>}
    </form>
  );
}

const localTimestamp = (date) =>
  new Date(new Date(date).getTime() + 6 * 3600000).toISOString().slice(0, 16);
const newCoupon = () => ({
  code: "",
  kind: "percent",
  value: "10",
  minSpend: "0",
  maxDiscount: "0",
  startsAt: localTimestamp(new Date()),
  endsAt: localTimestamp(new Date(Date.now() + 30 * 86400000)),
  usageLimit: 100,
  perCustomerLimit: 1,
  enabled: true,
  public: true,
  isExisting: false,
});
export function CouponsPanel({ notify }) {
  const { money } = useApp();
  const resource = useResource("/staff/coupons"),
    [form, setForm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function edit(row) {
    setError("");
    setForm({
      isExisting: true,
      code: row.code,
      kind: row.kind,
      value: (row.value / 100).toFixed(2),
      minSpend: (row.minSpendMinor / 100).toFixed(2),
      maxDiscount: (row.maxDiscountMinor / 100).toFixed(2),
      startsAt: localTimestamp(row.startsAt),
      endsAt: localTimestamp(row.endsAt),
      usageLimit: row.usageLimit,
      perCustomerLimit: row.perCustomerLimit,
      enabled: row.enabled,
      public: row.public,
    });
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/coupons", {
        method: "POST",
        data: {
          code: form.code,
          kind: form.kind,
          value: minorAmount(form.value),
          minSpendMinor: minorAmount(form.minSpend),
          maxDiscountMinor: minorAmount(form.maxDiscount),
          startsAt: new Date(form.startsAt + ":00+06:00").toISOString(),
          endsAt: new Date(form.endsAt + ":00+06:00").toISOString(),
          usageLimit: Number(form.usageLimit),
          perCustomerLimit: Number(form.perCustomerLimit),
          enabled: form.enabled,
          public: form.public,
        },
      });
      setForm(null);
      await resource.reload();
      notify("Coupon saved. Existing bill discounts remain unchanged.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Coupons & member offers</h2>
          <p>
            One coupon per table bill. Limits are reserved when the cashier
            finalizes a bill.
          </p>
        </div>
        <Button
          className="button-small"
          onClick={() => {
            setForm(newCoupon());
            setError("");
          }}
        >
          <Plus size={15} />
          Create coupon
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
        <div className="coupon-grid">
          {resource.data?.coupons.map((row) => (
            <article key={row.code}>
              <span>
                {row.kind === "percent"
                  ? row.value / 100 + "% off"
                  : money(row.value / 100) + " off"}
              </span>
              <h3>{row.code}</h3>
              <p>
                {row.enabled ? "Enabled" : "Disabled"} ·{" "}
                {row.public ? "Listed offer" : "Code only"}
              </p>
              <p>
                Used {row.usedCount} / {row.usageLimit} · {row.perCustomerLimit}{" "}
                per account
              </p>
              <small>
                {dhakaTime(row.startsAt)} — {dhakaTime(row.endsAt)}
              </small>
              <p>Minimum food spend {money(row.minSpendMinor / 100)}</p>
              <Button
                secondary
                className="button-small"
                onClick={() => edit(row)}
              >
                Edit coupon
              </Button>
            </article>
          ))}
        </div>
      )}
      {resource.data?.coupons.length === 0 && (
        <EmptyState
          icon={Gift}
          title="Your first member offer starts here."
          text="Create a fixed or percentage discount with dates and usage limits."
        />
      )}
      {form && (
        <Modal open onClose={() => setForm(null)} title="Coupon details">
          <form className="commerce-form" onSubmit={save}>
            <label>
              Coupon code
              <input
                required
                minLength={3}
                maxLength={30}
                pattern="[A-Z0-9_-]+"
                disabled={form.isExisting}
                value={form.code}
                onChange={(event) =>
                  setForm({ ...form, code: event.target.value.toUpperCase() })
                }
              />
            </label>
            <div className="commerce-two">
              <label>
                Discount type
                <select
                  aria-label="Discount type"
                  value={form.kind}
                  onChange={(event) =>
                    setForm({ ...form, kind: event.target.value })
                  }
                >
                  <option value="percent">Percentage</option>
                  <option value="fixed">Fixed BDT</option>
                </select>
              </label>
              <label>
                {form.kind === "percent" ? "Discount (%)" : "Discount (BDT)"}
                <input
                  inputMode="decimal"
                  required
                  value={form.value}
                  onChange={(event) =>
                    setForm({ ...form, value: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="commerce-two">
              <label>
                Minimum food spend (BDT)
                <input
                  inputMode="decimal"
                  required
                  value={form.minSpend}
                  onChange={(event) =>
                    setForm({ ...form, minSpend: event.target.value })
                  }
                />
              </label>
              <label>
                Maximum discount (BDT, 0 = no cap)
                <input
                  inputMode="decimal"
                  required
                  value={form.maxDiscount}
                  onChange={(event) =>
                    setForm({ ...form, maxDiscount: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="commerce-two">
              {[
                ["startsAt", "Starts"],
                ["endsAt", "Ends"],
              ].map(([field, label]) => (
                <label key={field}>
                  {label} (Bangladesh time)
                  <input
                    type="datetime-local"
                    required
                    value={form[field]}
                    onChange={(event) =>
                      setForm({ ...form, [field]: event.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <div className="commerce-two">
              <label>
                Total uses
                <input
                  required
                  type="number"
                  min="1"
                  max="1000000"
                  value={form.usageLimit}
                  onChange={(event) =>
                    setForm({ ...form, usageLimit: event.target.value })
                  }
                />
              </label>
              <label>
                Uses per account
                <input
                  required
                  type="number"
                  min="1"
                  max="100"
                  value={form.perCustomerLimit}
                  onChange={(event) =>
                    setForm({ ...form, perCustomerLimit: event.target.value })
                  }
                />
              </label>
            </div>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({ ...form, enabled: event.target.checked })
                }
              />
              <span>Coupon enabled</span>
            </label>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                checked={form.public}
                onChange={(event) =>
                  setForm({ ...form, public: event.target.checked })
                }
              />
              <span>List this offer on customer accounts</span>
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Save coupon
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function GatewayPanel({ user, notify, onRefresh }) {
  const { money } = useApp();
  const resource = useResource("/staff/online-payments", { interval: 10000 });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState(null),
    [reason, setReason] = useState("");
  async function reconcile(row) {
    setBusy(true);
    setError("");
    try {
      await api("/staff/online-payments/" + row.id + "/reconcile", {
        method: "POST",
        data: {},
      });
      await resource.reload();
      onRefresh();
      notify("Provider status checked.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Online payment reconciliation</h2>
          <p>
            Verify pending attempts with SSLCOMMERZ. Browser redirects alone do
            not mark bills paid.
          </p>
        </div>
        <Button secondary className="button-small" onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </div>
      {resource.data && (
        <div className="gateway-status-card">
          <CreditCard size={22} />
          <div>
            <strong>
              {resource.data.enabled
                ? "SSLCOMMERZ configured"
                : "Online checkout is not configured"}
            </strong>
            <p>
              {resource.data.mode === "live"
                ? "Live merchant mode"
                : "Sandbox mode · test transactions only"}
            </p>
            {!resource.data.enabled && (
              <small>
                See the v2.2 setup instructions for merchant credentials and
                public HTTPS callbacks. Counter payments remain available.
              </small>
            )}
          </div>
        </div>
      )}
      {(error || resource.error) && (
        <ErrorMessage>{error || resource.error.message}</ErrorMessage>
      )}
      {resource.loading && !resource.data && <Loading />}
      <div className="commerce-staff-grid">
        {resource.data?.transactions.map((row) => (
          <article className="commerce-card" key={row.id}>
            <div className="commerce-section-heading">
              <h3>{row.receiptNo || row.id}</h3>
              <span className="soft-badge">{row.status}</span>
            </div>
            <p>
              {row.tableNumber
                ? "Table " + row.tableNumber.slice(1) + " · "
                : ""}
              {money(row.amountMinor / 100)}
            </p>
            <small>
              {row.id} · {dhakaTime(row.createdAt)}
            </small>
            <p className="commerce-note">{row.message}</p>
            <div className="commerce-inline-actions">
              {!["paid", "overpayment_review"].includes(row.status) && (
                <Button
                  secondary
                  className="button-small"
                  disabled={busy}
                  onClick={() => reconcile(row)}
                >
                  Recheck provider
                </Button>
              )}
              {row.status === "review" && user.role === "admin" && (
                <Button
                  className="button-small"
                  onClick={() => {
                    setReview(row);
                    setReason("");
                    setError("");
                  }}
                >
                  Review verified risk
                </Button>
              )}
            </div>
            {row.status === "overpayment_review" && (
              <p className="commerce-note">
                Verified funds need manual manager reconciliation/refund. No
                extra amount was added to the bill.
              </p>
            )}
          </article>
        ))}
      </div>
      {resource.data?.transactions.length === 0 && (
        <EmptyState
          icon={CreditCard}
          title="No online attempts yet."
          text="Customer checkout attempts will appear here with their verification status."
        />
      )}
      {review && (
        <Modal
          open
          onClose={() => setReview(null)}
          title="Accept a provider-flagged payment"
        >
          <form
            className="commerce-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(
                  "/staff/online-payments/" + review.id + "/approve-risk",
                  { method: "POST", data: { reason } },
                );
                setReview(null);
                await resource.reload();
                onRefresh();
                notify("Verified payment accepted after manager review.");
              } catch (failure) {
                setError(failure.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              The provider verified the transaction but flagged it for risk.
              Complete your merchant checks before accepting these funds.
            </p>
            <label>
              Verification and decision reason
              <textarea
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Accept verified payment
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
