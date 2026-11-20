import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  Check,
  Clock3,
  Download,
  ReceiptText,
  RefreshCw,
  Search,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, localDate, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, EmptyState, ErrorMessage, Loading, Modal } from "./UI";

export function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export const stageLimits = { placed: 5, queued: 10, preparing: 20, ready: 5 };
export function orderStageTime(order) {
  return (
    [...order.history].reverse().find((entry, reverseIndex) => {
      const index = order.history.length - 1 - reverseIndex;
      return (
        entry.status === order.status &&
        (index === 0 || order.history[index - 1].status !== entry.status)
      );
    })?.at || order.createdAt
  );
}
const elapsed = (since, now) => {
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(since).getTime()) / 1000),
  );
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};
export function isDelayed(order, now) {
  return (
    stageLimits[order.status] &&
    now - new Date(orderStageTime(order)).getTime() >=
      stageLimits[order.status] * 60000
  );
}
export function OrderTimer({ order, now }) {
  if (!stageLimits[order.status]) return null;
  const labels = {
    placed: "Awaiting staff",
    queued: "Waiting for kitchen",
    preparing: "Cooking",
    ready: "Waiting to serve",
  };
  return (
    <div
      className={"order-live-timer" + (isDelayed(order, now) ? " delayed" : "")}
    >
      <Clock3 size={15} />
      <span>
        Total {elapsed(order.createdAt, now)} · {labels[order.status]}{" "}
        {elapsed(orderStageTime(order), now)}
      </span>
      {isDelayed(order, now) && <strong>Delayed</strong>}
    </div>
  );
}

export function GuestServiceControls() {
  const { table, t, notify } = useApp();
  const resource = useResource("/service-requests", { interval: 3000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requests = resource.data?.requests || [];
  async function send(type) {
    setBusy(true);
    setError("");
    try {
      await api("/service-requests", {
        method: "POST",
        data: { type, note: "" },
      });
      notify(
        t(
          "Your request is with the floor team.",
          "আপনার অনুরোধ স্টাফের কাছে পৌঁছেছে।",
        ),
      );
      await resource.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="table-service service-controls" aria-live="polite">
      <div className="service-buttons">
        {["waiter", "bill"].map((type) => {
          const open = requests.find(
            (row) =>
              row.type === type &&
              ["open", "acknowledged"].includes(row.status),
          );
          const Icon = type === "bill" ? ReceiptText : BellRing;
          return (
            <button
              key={type}
              type="button"
              disabled={busy || Boolean(open)}
              onClick={() => send(type)}
            >
              <Icon size={15} />
              {open
                ? type === "bill"
                  ? t("Bill requested", "বিল চাওয়া হয়েছে")
                  : t("Waiter requested", "স্টাফকে ডাকা হয়েছে")
                : type === "bill"
                  ? t("Request bill", "বিল চাই")
                  : t("Call waiter", "স্টাফ ডাকুন")}
            </button>
          );
        })}
      </div>
      {requests
        .filter((row) => ["open", "acknowledged"].includes(row.status))
        .map((row) => (
          <small key={row.id} className="service-request-state">
            {row.type === "bill"
              ? t("Bill", "বিল")
              : row.type === "issue"
                ? t("Help", "সহায়তা")
                : t("Waiter", "স্টাফ")}
            :{" "}
            {row.status === "acknowledged"
              ? t(
                  "Staff acknowledged; on the way",
                  "স্টাফ অনুরোধ দেখেছেন; আসছেন",
                )
              : t("Waiting for staff", "স্টাফের অপেক্ষায়")}
          </small>
        ))}
      {!requests.some((row) => ["open", "acknowledged"].includes(row.status)) &&
        requests[0]?.status === "resolved" && (
          <small className="service-request-state">
            <Check size={12} />
            {t("Last request completed", "সর্বশেষ অনুরোধ সম্পন্ন")}
          </small>
        )}
      {(error || resource.error) && (
        <small role="alert">{error || resource.error.message}</small>
      )}
      <span className="sr-only">{table.number}</span>
    </div>
  );
}

export function AvailabilityPanel({ notify }) {
  const { reloadMenu } = useApp();
  const resource = useResource("/menu", { interval: 5000 });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  async function toggle(dish) {
    setBusy(dish._id);
    setError("");
    try {
      await api("/staff/menu/" + dish._id + "/availability", {
        method: "PATCH",
        data: { available: !dish.available, expectedAvailable: dish.available },
      });
      notify(
        dish.name +
          (dish.available ? " marked sold out." : " is available again."),
      );
      await resource.reload();
      await reloadMenu();
    } catch (failure) {
      setError(failure.message);
      await resource.reload();
    } finally {
      setBusy(null);
    }
  }
  if (resource.loading && !resource.data) return <Loading />;
  const dishes = resource.data?.dishes || [];
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>What’s available today?</h2>
          <p>
            {dishes.filter((dish) => dish.available).length} available ·{" "}
            {dishes.filter((dish) => !dish.available).length} sold out. Existing
            accepted orders stay in the queue.
          </p>
        </div>
      </div>
      <label className="search-field">
        <Search size={17} />
        <input
          aria-label="Search availability"
          placeholder="Search dishes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {(error || resource.error) && (
        <ErrorMessage onRetry={resource.reload}>
          {error || resource.error.message}
        </ErrorMessage>
      )}
      <div className="availability-grid">
        {dishes
          .filter((dish) =>
            [dish.name, dish.nameBn, dish.category].some((value) =>
              value?.toLowerCase().includes(query.toLowerCase()),
            ),
          )
          .map((dish) => (
            <article
              className={
                "availability-card" + (!dish.available ? " sold-out" : "")
              }
              key={dish._id}
            >
              <img src={dish.image} alt="" width="72" height="72" />
              <div>
                <h3>{dish.name}</h3>
                <span className="soft-badge">
                  {dish.available ? "Available" : "Sold out"}
                </span>
              </div>
              <Button
                secondary={!dish.available}
                className="button-small"
                disabled={busy !== null}
                aria-label={
                  (dish.available ? "Mark sold out " : "Make available ") +
                  dish.name
                }
                onClick={() => toggle(dish)}
              >
                {busy === dish._id
                  ? "Saving…"
                  : dish.available
                    ? "Mark sold out"
                    : "Make available"}
              </Button>
            </article>
          ))}
      </div>
    </section>
  );
}

export function SalesReportsPanel() {
  const { money } = useApp();
  const today = localDate();
  const [form, setForm] = useState({
    start: today.slice(0, 7) + "-01",
    end: today,
    group: "day",
  });
  const [filters, setFilters] = useState(form);
  const params = new URLSearchParams(filters).toString();
  const resource = useResource("/staff/reports/sales?" + params, {
    interval: 30000,
  });
  const data = resource.data;
  function preset(kind) {
    const start =
      kind === "today"
        ? today
        : kind === "month"
          ? today.slice(0, 7) + "-01"
          : new Date(new Date(today + "T12:00:00Z").getTime() - 6 * 86400000)
              .toISOString()
              .slice(0, 10);
    const next = { start, end: today, group: "day" };
    setForm(next);
    setFilters(next);
  }
  return (
    <section className="sales-reports">
      <div className="panel-heading">
        <div>
          <h2>Sales reports</h2>
          <p>
            Paid dining, pickup and delivery bills · Bangladesh time (UTC+6) ·
            Amounts in BDT
          </p>
        </div>
        <Button secondary className="button-small" onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </div>
      <div className="report-presets">
        {[
          ["today", "Today"],
          ["week", "Last 7 days"],
          ["month", "This month"],
        ].map(([id, label]) => (
          <button type="button" key={id} onClick={() => preset(id)}>
            {label}
          </button>
        ))}
      </div>
      <form
        className="report-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...form });
        }}
      >
        <label>
          From
          <input
            required
            type="date"
            value={form.start}
            max={form.end}
            onChange={(event) =>
              setForm({ ...form, start: event.target.value })
            }
          />
        </label>
        <label>
          Through
          <input
            required
            type="date"
            value={form.end}
            min={form.start}
            onChange={(event) => setForm({ ...form, end: event.target.value })}
          />
        </label>
        <label>
          Group by
          <select
            value={form.group}
            onChange={(event) =>
              setForm({ ...form, group: event.target.value })
            }
          >
            <option value="day">Day</option>
            <option value="month">Month</option>
          </select>
        </label>
        <Button type="submit" className="button-small">
          Apply range
        </Button>
      </form>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading && <Loading />}
      {data && (
        <>
          <p className="report-window">
            {data.window.start} — {data.window.end}, inclusive. Unpaid bills,
            cancelled orders and event deposits are excluded.
          </p>
          <div className="report-metrics">
            {[
              ["Collected", data.summary.revenueMinor],
              ["Food sales", data.summary.subtotalMinor],
              ["Service charges", data.summary.serviceChargeMinor],
              ["Average paid bill", data.summary.averageBillMinor],
              ["Tax collected", data.accounting?.taxMinor || 0],
              [
                "Delivery fees (before tax)",
                data.accounting?.deliveryFeesMinor || 0,
              ],
              ["Refunds given", data.accounting?.refundsMinor || 0],
              [
                "Collected minus refunds",
                data.accounting?.afterRefundsMinor ?? data.summary.revenueMinor,
              ],
            ].map(([label, amount]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{money(amount / 100)}</strong>
              </article>
            ))}
            <article>
              <span>Paid bills</span>
              <strong>{data.summary.bills}</strong>
            </article>
          </div>
          <div className="report-downloads">
            <p className="commerce-note">
              Original paid sales remain on their settlement date. Refunds use
              the date money was returned, so collected minus refunds can be
              negative. Food/service figures exclude separately recorded tax.
              This is not a tax filing or profit report.
            </p>
            {[
              ["summary", "Summary"],
              ["periods", "Daily / monthly"],
              ["items", "Dishes"],
              ["payments", "Payments"],
            ].map(([id, label]) => (
              <a
                className="button button-secondary button-small"
                key={id}
                href={
                  "/api/staff/reports/sales.csv?" + params + "&section=" + id
                }
                download
              >
                <Download size={14} />
                {label} CSV
              </a>
            ))}
          </div>
          {!data.summary.bills && (
            <EmptyState
              icon={ReceiptText}
              title="No paid bills in this range."
              text="Sales appear after the cashier records a verified payment."
            />
          )}
          <div className="report-grid">
            <section className="staff-panel">
              <h3>
                {data.window.group === "day" ? "Daily" : "Monthly"} collections
              </h3>
              <div className="report-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Bills</th>
                      <th>Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.series.map((row) => (
                      <tr key={row.period}>
                        <td>{row.period}</td>
                        <td>{row.bills}</td>
                        <td>{money(row.revenueMinor / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="staff-panel">
              <h3>Payment breakdown</h3>
              <div className="report-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Bills</th>
                      <th>Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((row) => (
                      <tr key={row.method}>
                        <td>{row.method}</td>
                        <td>{row.bills}</td>
                        <td>{money(row.revenueMinor / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="report-dishes-heading">Popular dishes</h3>
              <p>
                Ranked by quantity · Gross dish values before discounts and
                service charges
              </p>
              <div className="report-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Dish</th>
                      <th>Quantity</th>
                      <th>Food sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.popular.slice(0, 20).map((row) => (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td>{row.quantity}</td>
                        <td>{money(row.foodMinor / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <small>Top 20 shown. The dishes CSV includes all results.</small>
            </section>
          </div>
        </>
      )}
    </section>
  );
}

export function StaffChangeReview({ order, notify, onRefresh }) {
  const { money } = useApp();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = order.changeRequest;
  if (change?.status !== "pending") return null;
  async function decide(decision) {
    if (reason.trim().length < 3) {
      setError("Give a decision reason of at least 3 characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        "/staff/orders/" + order.id + "/changes/" + change.id + "/decision",
        { method: "POST", data: { decision, reason } },
      );
      notify(
        "Guest request " + (decision === "approve" ? "approved." : "rejected."),
      );
      onRefresh();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="change-review">
      <strong>
        {change.type === "cancel"
          ? "Cancellation request"
          : "Order change request"}
      </strong>
      <p>{change.reason}</p>
      <small>{dhakaTime(change.requestedAt)}</small>
      {change.type === "edit" && (
        <>
          <ul>
            {change.items.map((item, index) => (
              <li key={index}>
                {item.quantity}× {item.name}
                {item.variant ? " · " + item.variant.name : ""}
                {item.addons?.length
                  ? " · " + item.addons.map((addon) => addon.name).join(", ")
                  : ""}
              </li>
            ))}
          </ul>
          <p>New note: {change.note || "None"}</p>
          <p>
            Total: {money(order.total)} → <strong>{money(change.total)}</strong>
          </p>
        </>
      )}
      <label>
        Decision reason
        <input
          aria-label={"Decision reason for " + order.code}
          value={reason}
          maxLength={160}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Explain your decision to the guest"
        />
      </label>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="change-actions">
        <Button
          className="button-small"
          disabled={busy}
          onClick={() => decide("approve")}
        >
          Approve {change.type === "cancel" ? "cancellation" : "changes"}
        </Button>
        <Button
          secondary
          className="button-small"
          disabled={busy}
          onClick={() => decide("reject")}
        >
          Reject request
        </Button>
      </div>
    </div>
  );
}

export function GuestOrderChanges({ order, onRefresh }) {
  const { t, money, name, language, notify } = useApp();
  const [editing, setEditing] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef(null);
  const change = order.changeRequest;
  function open(type) {
    setReason("");
    setError("");
    retry.current = null;
    setEditing({
      type,
      revision: order.revision,
      items: order.items.map((item) => ({ ...item })),
      note: order.note,
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = {
      type: editing.type,
      expectedRevision: editing.revision,
      reason,
      ...(editing.type === "edit"
        ? {
            note: editing.note,
            lines: editing.items.map((item, index) => ({
              index,
              quantity: item.quantity,
            })),
          }
        : {}),
    };
    const signature = JSON.stringify(data);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: requestKey() };
    try {
      await api("/orders/" + order.id + "/changes", {
        method: "POST",
        data,
        headers: { "Idempotency-Key": retry.current.key },
      });
      setEditing(null);
      notify(
        t(
          "Request sent for staff approval.",
          "স্টাফের অনুমোদনের জন্য অনুরোধ পাঠানো হয়েছে।",
        ),
      );
      await onRefresh();
    } catch (failure) {
      setError(failure.message);
      void onRefresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="guest-order-changes">
      {change && (
        <div
          className={"guest-change-state " + change.status}
          aria-live="polite"
        >
          <strong>
            {change.type === "cancel"
              ? t("Cancellation request", "বাতিলের অনুরোধ")
              : t("Change request", "পরিবর্তনের অনুরোধ")}
            :{" "}
            {change.status === "pending"
              ? t("Awaiting approval", "অনুমোদনের অপেক্ষায়")
              : change.status === "approved"
                ? t("Approved", "অনুমোদিত")
                : change.status === "rejected"
                  ? t("Rejected", "গ্রহণ করা হয়নি")
                  : t("Closed", "শেষ হয়েছে")}
          </strong>
          <p>{change.reason}</p>
          {change.type === "edit" && change.status === "pending" && (
            <p>
              {t("Proposed food total: ", "প্রস্তাবিত মোট দাম: ")}
              {money(change.total)}
            </p>
          )}
          {change.decisionReason && (
            <p>
              {t("Staff: ", "স্টাফ: ")}
              {change.decisionReason}
            </p>
          )}
          {change.decidedAt && (
            <small>{dhakaTime(change.decidedAt, false, language)}</small>
          )}
          {change.status === "pending" && (
            <small>
              {t(
                "Your original order stays unchanged until staff approves. Cooking is paused for review.",
                "স্টাফ অনুমোদন না দেওয়া পর্যন্ত মূল অর্ডার অপরিবর্তিত থাকবে। পর্যালোচনার সময় রান্না শুরু হবে না।",
              )}
            </small>
          )}
        </div>
      )}
      {["placed", "queued"].includes(order.status) &&
        change?.status !== "pending" && (
          <div className="change-actions">
            <Button
              secondary
              className="button-small"
              onClick={() => open("edit")}
            >
              {t("Request changes", "পরিবর্তনের অনুরোধ")}
            </Button>
            <Button
              secondary
              className="button-small"
              onClick={() => open("cancel")}
            >
              {t("Request cancellation", "বাতিলের অনুরোধ")}
            </Button>
          </div>
        )}
      {editing && (
        <Modal
          open
          onClose={() => {
            if (!busy) setEditing(null);
          }}
          title={
            editing.type === "cancel"
              ? t("Request cancellation", "বাতিলের অনুরোধ")
              : t("Change your order", "অর্ডার পরিবর্তন করুন")
          }
        >
          <form className="change-request-form" onSubmit={submit}>
            <p>
              {t(
                "Available before cooking starts. An administrator must approve your request.",
                "রান্না শুরুর আগে অনুরোধ করা যায়। অ্যাডমিনের অনুমোদন প্রয়োজন।",
              )}
            </p>
            {editing.type === "edit" && (
              <>
                <p>
                  {t(
                    "Adjust existing items; ordered unit prices stay the same. Set quantity to 0 to remove a line.",
                    "বিদ্যমান খাবারের পরিমাণ বদলান; অর্ডারের একক দাম একই থাকবে। কোনো খাবার বাদ দিতে পরিমাণ ০ করুন।",
                  )}
                </p>
                {editing.items.map((item, index) => (
                  <label className="change-line" key={index}>
                    <span>
                      {name(item)}
                      <small>
                        {[
                          item.variant?.name,
                          ...(item.addons || []).map((addon) => addon.name),
                        ]
                          .filter(Boolean)
                          .join(" · ")}{" "}
                        · {money(item.unitPrice)}
                      </small>
                    </span>
                    <input
                      aria-label={
                        t("Quantity for ", "পরিমাণ: ") +
                        name(item) +
                        " " +
                        (index + 1)
                      }
                      type="number"
                      required
                      min="0"
                      max="10"
                      value={item.quantity}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          items: editing.items.map((line, lineIndex) =>
                            lineIndex === index
                              ? {
                                  ...line,
                                  quantity:
                                    event.target.value === ""
                                      ? ""
                                      : Number(event.target.value),
                                }
                              : line,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
                <p>
                  <strong>
                    {t("Proposed food total: ", "প্রস্তাবিত মোট দাম: ")}
                    {money(
                      editing.items.reduce(
                        (sum, item) => sum + item.quantity * item.unitPrice,
                        0,
                      ),
                    )}
                  </strong>
                </p>
                <label>
                  {t("Kitchen note", "কিচেনের জন্য নোট")}
                  <textarea
                    value={editing.note}
                    maxLength={200}
                    onChange={(event) =>
                      setEditing({ ...editing, note: event.target.value })
                    }
                  />
                </label>
              </>
            )}
            <label>
              {t("Reason", "কারণ")}
              <textarea
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t(
                  "Tell staff why you need this change",
                  "পরিবর্তনের কারণ লিখুন",
                )}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy
                ? t("Sending…", "পাঠানো হচ্ছে…")
                : t("Send request", "অনুরোধ পাঠান")}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
