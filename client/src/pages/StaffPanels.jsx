import { useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BellRing,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  Flame,
  Heart,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Table2,
  Trash2,
  Users,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { useApp, lineKey } from "../lib/AppContext";
import { api, dhakaTime, localDate, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Loading,
  Modal,
  Status,
} from "../components/UI";
import { Receipt } from "./Receipt";
import { CounterBillDialog } from "../components/Financial";
import {
  isDelayed,
  OrderTimer,
  StaffChangeReview,
  useClock,
} from "../components/Operations";

function useAction(notify) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task, message, after) {
    if (busy) return { ok: false };
    setBusy(true);
    setError("");
    try {
      const value = await task();
      if (message) notify(message);
      if (after) await after();
      return { ok: true, value };
    } catch (failure) {
      setError(failure.message);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
function PanelState({ resource, children }) {
  if (resource.loading && !resource.data)
    return <Loading label="Bringing your station up to date…" />;
  return (
    <>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.data && children}
    </>
  );
}

export function OverviewPanel({ overview, queue, onSelect, user }) {
  const { money } = useApp();
  const data = overview.data;
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const date = localDate(new Date(Date.now() - (6 - index) * 86400000));
        return {
          date,
          amount: data?.days.find((day) => day.date === date)?.amount || 0,
        };
      }),
    [data],
  );
  const maximum = Math.max(...days.map((day) => day.amount), 1);
  return (
    <PanelState resource={overview}>
      <div className="dashboard-metrics">
        {[
          [
            CircleDollarSign,
            "Today’s settled sales",
            money(data?.sales),
            "Paid table receipts",
          ],
          [
            ClipboardList,
            "Live orders",
            data?.live || 0,
            "Across all service stages",
          ],
          [Table2, "Open tables", data?.tables || 0, "Guests currently seated"],
          [
            MessageIcon,
            "Feedback to review",
            data?.pendingReviews || 0,
            "Every guest voice matters",
          ],
        ].map(([Icon, label, value, description]) => (
          <article className="metric-card" key={label}>
            <div>
              <span>{label}</span>
              <span className="metric-symbol">
                <Icon size={20} />
              </span>
            </div>
            <strong>{value}</strong>
            <p>{description}</p>
          </article>
        ))}
      </div>
      <div className="dashboard-middle">
        <section className="staff-panel sales-panel">
          <div className="panel-heading">
            <div>
              <h2>A week at the counter</h2>
              <p>Actual settled sales · Bangladesh time</p>
            </div>
            <span className="soft-badge">Last 7 days</span>
          </div>
          <div
            className="sales-chart"
            aria-label="Settled sales for the last seven days"
          >
            {days.map((day) => (
              <div className="sales-chart-column" key={day.date}>
                <span>{money(day.amount)}</span>
                <div>
                  <i
                    style={{
                      height: Math.max(3, (day.amount / maximum) * 100) + "%",
                    }}
                  />
                </div>
                <small>
                  {new Date(day.date + "T12:00:00+06:00").toLocaleDateString(
                    "en-BD",
                    { weekday: "short" },
                  )}
                </small>
              </div>
            ))}
          </div>
        </section>
        <section className="staff-panel service-snapshot">
          <h2>Good service starts here.</h2>
          <p>Keep an eye on the requests that need your team.</p>
          {(user.role === "cashier"
            ? [
                [
                  "billing",
                  ReceiptText,
                  "Open counter & bills",
                  data?.tables || 0,
                ],
              ]
            : [
                [
                  "orders",
                  ClipboardList,
                  "Orders at the desk",
                  queue.data?.orders.filter(
                    (order) => order.status === "placed",
                  ).length || 0,
                ],
                ["requests", BellRing, "Floor requests", data?.requests || 0],
                [
                  "events",
                  CalendarDays,
                  "Gatherings to plan",
                  data?.events || 0,
                ],
              ]
          ).map(([id, Icon, label, value]) => (
            <button key={id} type="button" onClick={() => onSelect(id)}>
              <Icon size={18} />
              <span>{label}</span>
              <strong>{value}</strong>
              <ChevronRight size={17} />
            </button>
          ))}
        </section>
      </div>
      <section className="staff-panel">
        <div className="panel-heading">
          <div>
            <h2>The live service board</h2>
            <p>The latest open table orders</p>
          </div>
          <button
            type="button"
            className="text-link"
            onClick={() =>
              onSelect(user.role === "cashier" ? "billing" : "orders")
            }
          >
            {user.role === "cashier"
              ? "Open counter & bills"
              : "Open order desk"}{" "}
            <ArrowUpRight size={15} />
          </button>
        </div>
        {queue.data?.orders.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Table</th>
                  <th>Placed</th>
                  <th>Amount</th>
                  <th>Stage</th>
                </tr>
              </thead>
              <tbody>
                {queue.data.orders.slice(0, 6).map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.code}</strong>
                    </td>
                    <td>Table {order.tableNumber.slice(1)}</td>
                    <td>{dhakaTime(order.createdAt)}</td>
                    <td>{money(order.total)}</td>
                    <td>
                      <Status status={order.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={UtensilsCrossed}
            title="A clear service board."
            text="Table orders appear here as soon as guests submit them."
          />
        )}
      </section>
    </PanelState>
  );
}
function MessageIcon(props) {
  return <Heart {...props} />;
}

export function OrdersPanel({ queue, user, notify, onRefresh }) {
  const now = useClock();
  const { money } = useApp();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState(null);
  const action = useAction(notify);
  const all = [...(queue.data?.orders || []), ...(queue.data?.recent || [])];
  const filters =
    user.role === "admin"
      ? [
          ["all", "All tickets"],
          ["placed", "New"],
          ["changes", "Change requests"],
          ["in-service", "In service"],
          ["closed", "Closed"],
        ]
      : [
          ["all", "All tickets"],
          ...(user.role === "kitchen"
            ? [
                ["queued", "To start"],
                ["preparing", "Cooking"],
              ]
            : []),
        ];
  const tickets = all.filter(
    (order) =>
      (filter === "all" ||
        (filter === "changes" && order.changeRequest?.status === "pending") ||
        (filter === "in-service" &&
          ["queued", "preparing", "ready"].includes(order.status)) ||
        (filter === "closed" &&
          ["served", "cancelled"].includes(order.status)) ||
        order.status === filter) &&
      (!query ||
        [order.code, order.tableNumber].some((value) =>
          value.toLowerCase().includes(query.toLowerCase()),
        )),
  );
  async function move(order, step) {
    await action.run(
      () =>
        api("/staff/orders/" + order.id + "/action", {
          method: "POST",
          data: { action: step },
        }),
      "Ticket updated.",
      () => queue.reload(),
    );
    onRefresh();
  }
  return (
    <PanelState resource={queue}>
      <div className="queue-timing-summary" role="status">
        {all.filter((order) => isDelayed(order, now)).length} delayed tickets ·
        Review after 5 min awaiting staff, 10 min queued, 20 min cooking or 5
        min ready.
      </div>
      <div className="staff-filter-row">
        <div className="segmented-controls">
          {filters.map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
              {id === "placed" && (
                <span>
                  {all.filter((order) => order.status === "placed").length}
                </span>
              )}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Search tickets"
            placeholder="Search order or table…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      {queue.data?.more && (
        <ErrorMessage>
          Showing the first 120 active tickets. Process the oldest tickets to
          see the rest.
        </ErrorMessage>
      )}
      {tickets.length ? (
        <div className="ticket-grid">
          {tickets.map((order) => (
            <article
              className={
                "staff-ticket" +
                (isDelayed(order, now) ? " ticket-delayed" : "")
              }
              key={order.id}
            >
              <header>
                <span className="ticket-table">
                  <Table2 size={17} />
                  TABLE {order.tableNumber.slice(1)}
                </span>
                <Status status={order.status} />
              </header>
              <h2>{order.code}</h2>
              <p className="ticket-time">
                <Clock3 size={13} />
                {dhakaTime(order.createdAt)}
                {order.source === "staff" && <span>Waiter entry</span>}
              </p>
              <OrderTimer order={order} now={now} />
              <ul>
                {order.items.map((item, index) => (
                  <li key={index}>
                    <span>{item.quantity}×</span>
                    <div>
                      <strong>{item.name}</strong>
                      {(item.variant || item.addons?.length > 0) && (
                        <small>
                          {[
                            item.variant?.name,
                            ...(item.addons || []).map((addon) => addon.name),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {order.note && (
                <p className="ticket-kitchen-note">
                  <strong>Kitchen note</strong>
                  {order.note}
                </p>
              )}
              {order.status === "cancelled" && (
                <p className="ticket-decline-reason">
                  {order.history.at(-1)?.reason}
                </p>
              )}
              {order.changeRequest?.status === "pending" &&
                (user.role === "admin" ? (
                  <StaffChangeReview
                    key={order.changeRequest.id}
                    order={order}
                    notify={notify}
                    onRefresh={onRefresh}
                  />
                ) : (
                  <p className="pending-change-notice">
                    Guest change request awaiting admin review. Cooking is
                    paused.
                  </p>
                ))}
              <div className="ticket-amount">
                <span>Order total</span>
                <strong>{money(order.total)}</strong>
              </div>
              <footer>
                {user.role === "admin" && order.status === "placed" && (
                  <>
                    <Button
                      className="button-small"
                      disabled={
                        action.busy || order.changeRequest?.status === "pending"
                      }
                      onClick={() => move(order, "send")}
                      arrow
                    >
                      Send to kitchen
                    </Button>
                    <Button
                      secondary
                      className="button-small"
                      onClick={() =>
                        setReason({
                          path: "/staff/orders/" + order.id + "/action",
                          data: { action: "reject" },
                          title: "Decline this order",
                        })
                      }
                    >
                      Decline
                    </Button>
                  </>
                )}
                {user.role === "admin" && ["queued"].includes(order.status) && (
                  <button
                    type="button"
                    className="cancel-ticket"
                    onClick={() =>
                      setReason({
                        path: "/staff/orders/" + order.id + "/cancel",
                        data: {},
                        title: "Cancel before cooking",
                      })
                    }
                  >
                    Cancel with a reason
                  </button>
                )}
                {user.role === "kitchen" && order.status === "queued" && (
                  <Button
                    disabled={
                      action.busy || order.changeRequest?.status === "pending"
                    }
                    onClick={() => move(order, "start")}
                    className="button-small"
                  >
                    <Flame size={16} />
                    Start cooking
                  </Button>
                )}
                {user.role === "kitchen" && order.status === "preparing" && (
                  <Button
                    disabled={action.busy}
                    onClick={() => move(order, "ready")}
                    className="button-small"
                  >
                    <Check size={16} />
                    Mark ready
                  </Button>
                )}
                {user.role === "waiter" && order.status === "ready" && (
                  <Button
                    disabled={action.busy}
                    onClick={() => move(order, "serve")}
                    className="button-small"
                  >
                    <CheckCircle2 size={16} />
                    Mark served
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={ClipboardList}
          title="Nothing in this queue."
          text="Tickets for this station appear automatically when they reach the next stage."
        />
      )}
      {reason && (
        <ReasonModal
          request={reason}
          onClose={() => setReason(null)}
          onDone={() => {
            notify("Order updated.");
            void queue.reload();
            onRefresh();
          }}
        />
      )}
    </PanelState>
  );
}
function ReasonModal({ request, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(request.path, {
        method: "POST",
        data: { ...request.data, reason },
      });
      onDone();
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={request.title}
      className="small-dialog"
    >
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          The guest can see this reason in their order or event history.
        </p>
        <label>
          Reason
          <textarea
            required
            minLength={3}
            maxLength={160}
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button type="submit" className="button button-primary" disabled={busy}>
          Confirm change
          <ArrowRight size={16} />
        </button>
      </form>
    </Modal>
  );
}

export function TablesPanel({ user, notify, onRefresh }) {
  const resource = useResource("/staff/tables", { interval: 5000 });
  const action = useAction(notify);
  const [rotate, setRotate] = useState(null);
  async function visit(table, step) {
    await action.run(
      () =>
        api("/staff/tables/" + table.number + "/" + step, {
          method: "POST",
          data: {},
        }),
      step === "open"
        ? "Table is ready for a new party."
        : "Empty visit closed.",
      () => resource.reload(),
    );
    onRefresh();
  }
  return (
    <PanelState resource={resource}>
      <p className="panel-description">
        Open a visit before guests scan. Served orders close through the counter
        after payment.
      </p>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      <div className="table-card-grid">
        {resource.data?.tables.map((table) => (
          <article
            className={"floor-table-card" + (table.open ? " occupied" : "")}
            key={table.number}
          >
            <div className="floor-table-top">
              <span>
                <Table2 size={25} />
              </span>
              <b>
                {table.open
                  ? table.billingState === "finalized"
                    ? "At counter"
                    : "Seated"
                  : "Available"}
              </b>
            </div>
            <h2>Table {table.number.slice(1)}</h2>
            <p>
              {table.openedAt
                ? "Opened " + dhakaTime(table.openedAt)
                : "Ready for your next guests"}
            </p>
            <div className="floor-table-actions">
              {table.open ? (
                <Button
                  secondary
                  className="button-small"
                  disabled={action.busy}
                  onClick={() => visit(table, "close")}
                >
                  Close empty visit
                </Button>
              ) : (
                <Button
                  className="button-small"
                  disabled={action.busy}
                  onClick={() => visit(table, "open")}
                >
                  Open table
                  <Plus size={15} />
                </Button>
              )}
              {user.role === "admin" && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setRotate(table.number)}
                >
                  Replace QR
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {rotate && (
        <Modal
          open
          onClose={() => setRotate(null)}
          title="Replace this table’s QR"
          className="small-dialog"
        >
          <div className="form-stack">
            <p>
              This makes the old printed card for Table {rotate.slice(1)}{" "}
              invalid. Generate and print its new card with the table command
              after this change.
            </p>
            {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
            <Button
              disabled={action.busy}
              onClick={async () => {
                const result = await action.run(
                  () =>
                    api("/staff/tables/" + rotate + "/rotate-qr", {
                      method: "POST",
                      data: {},
                    }),
                  "QR replaced. Print the new table card.",
                );
                if (result.ok) setRotate(null);
              }}
            >
              Replace QR
            </Button>
          </div>
        </Modal>
      )}
    </PanelState>
  );
}

export function BillingPanel({ notify, onRefresh }) {
  const { money } = useApp();
  const resource = useResource("/staff/billing", { interval: 6000 });
  const action = useAction(notify);
  const [payment, setPayment] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [clearing, setClearing] = useState(null);
  async function finalize(table) {
    const result = await action.run(
      () =>
        api("/staff/billing/" + table.number + "/finalize", {
          method: "POST",
          data: {},
        }),
      "Table bill finalized.",
      () => resource.reload(),
    );
    if (result.ok) {
      if (result.value.bill.status === "paid") setReceipt(result.value.bill);
      else setPayment(result.value.bill);
    }
    onRefresh();
  }
  return (
    <PanelState resource={resource}>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      <div className="panel-heading">
        <div>
          <h2>At the counter</h2>
          <p>One table visit. One final bill.</p>
        </div>
        <span className="soft-badge">
          {resource.data?.tables.length || 0} open visits
        </span>
      </div>
      {resource.data?.tables.length ? (
        <div className="billing-grid">
          {resource.data.tables.map((table) => {
            const total = table.orders.reduce(
              (sum, order) => sum + order.total,
              0,
            );
            const ready =
              table.orders.length > 0 &&
              table.orders.every((order) => order.status === "served");
            return (
              <article className="billing-card" key={table.number}>
                <header>
                  <span className="billing-icon">
                    <ReceiptText size={23} />
                  </span>
                  <div>
                    <h3>Table {table.number.slice(1)}</h3>
                    <p>
                      {table.orders.length} billable{" "}
                      {table.orders.length === 1 ? "order" : "orders"}
                    </p>
                  </div>
                  {table.bill && <Status status={table.bill.status} />}
                </header>
                <ul>
                  {table.orders.map((order) => (
                    <li key={order.id}>
                      <span>
                        {order.code}
                        <small>
                          {order.status === "served"
                            ? "Served"
                            : "Still in service"}
                        </small>
                      </span>
                      <strong>{money(order.total)}</strong>
                    </li>
                  ))}
                </ul>
                <div className="billing-card-total">
                  <span>{table.bill ? "Final total" : "Food subtotal"}</span>
                  <strong>{money(table.bill?.total ?? total)}</strong>
                </div>
                {table.bill ? (
                  <div className="card-actions">
                    <Button
                      className="button-small"
                      onClick={() => setPayment(table.bill)}
                    >
                      Record payment
                      <ArrowRight size={15} />
                    </Button>
                    <Button
                      secondary
                      className="button-small"
                      onClick={() => setReceipt(table.bill)}
                    >
                      View bill
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      disabled={!ready || action.busy}
                      onClick={() => finalize(table)}
                    >
                      Finalize table bill
                      <ArrowRight size={16} />
                    </Button>
                    {table.hasPromotion && (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => setClearing(table.number)}
                      >
                        Clear selected coupon / points with a reason
                      </button>
                    )}
                    <p className="form-help">
                      {ready
                        ? "Finalizing locks this visit against new orders."
                        : "Finish every order before finalizing this bill."}
                    </p>
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={ReceiptText}
          title="A clear counter."
          text="Open table visits appear here with their combined order totals."
        />
      )}
      <section className="staff-panel recent-receipts">
        <div className="panel-heading">
          <div>
            <h2>Settled receipts</h2>
            <p>Latest settled table bills</p>
          </div>
        </div>
        {resource.data?.recent.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Table</th>
                  <th>Paid</th>
                  <th>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {resource.data.recent.map((bill) => (
                  <tr key={bill.id}>
                    <td>
                      <strong>{bill.receiptNo}</strong>
                    </td>
                    <td>{bill.tableNumber.slice(1)}</td>
                    <td>{dhakaTime(bill.paidAt)}</td>
                    <td>{money(bill.total)}</td>
                    <td>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => setReceipt(bill)}
                      >
                        Receipt
                        <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            Receipts appear after a cashier records payment.
          </p>
        )}
      </section>
      {payment && (
        <CounterBillDialog
          bill={payment}
          onClose={() => setPayment(null)}
          onDone={(bill) => {
            if (bill.status === "paid") {
              setPayment(null);
              setReceipt(bill);
              notify("Payment recorded and table visit closed.");
            } else {
              setPayment(bill);
              notify(
                "Partial payment recorded. The remaining balance stays open.",
              );
            }
            void resource.reload();
            onRefresh();
          }}
        />
      )}
      {clearing && (
        <ReasonModal
          request={{
            path: "/staff/tables/" + clearing + "/clear-promotions",
            data: {},
            title: "Clear selected table benefits",
          }}
          onClose={() => setClearing(null)}
          onDone={() => {
            setClearing(null);
            void resource.reload();
          }}
        />
      )}
      {receipt && (
        <Modal
          open
          onClose={() => setReceipt(null)}
          title="Table receipt"
          className="receipt-dialog"
        >
          <Receipt staff bill={receipt} />
        </Modal>
      )}
    </PanelState>
  );
}
export function ReviewsPanel({ notify, onRefresh }) {
  const resource = useResource("/staff/reviews");
  const action = useAction(notify);
  const [drafts, setDrafts] = useState({});
  function draft(review) {
    return (
      drafts[review.id] || {
        reply: review.reply || "",
        reason: review.reason || "",
      }
    );
  }
  function change(review, key, value) {
    setDrafts((previous) => ({
      ...previous,
      [review.id]: { ...draft(review), [key]: value },
    }));
  }
  async function moderate(review, status) {
    await action.run(
      () =>
        api("/staff/reviews/" + review.id, {
          method: "PATCH",
          data: { status, ...draft(review) },
        }),
      status === "approved"
        ? review.visibility === "private"
          ? "Private feedback acknowledged."
          : "Review published."
        : "Review hidden.",
      () => resource.reload(),
    );
    onRefresh();
  }
  return (
    <PanelState resource={resource}>
      <div className="panel-heading">
        <div>
          <h2>A place for every guest voice</h2>
          <p>
            Apply the same moderation standard to positive and critical reviews.
          </p>
        </div>
        <Button secondary className="button-small" onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh feedback
        </Button>
      </div>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      {resource.data?.reviews.length ? (
        <div className="feedback-grid">
          {resource.data.reviews.map((review) => (
            <article className="feedback-card" key={review.id}>
              <header>
                <span className="review-stars">
                  <Star size={14} fill="currentColor" />
                  {review.rating}/5
                </span>
                <span className="soft-badge">
                  {review.visibility === "private"
                    ? "Private feedback"
                    : review.status}
                </span>
                <time>{dhakaTime(review.createdAt, true)}</time>
              </header>
              <h3>{review.dishName}</h3>
              <small className="muted">{review.orderCode}</small>
              {review.comment && <p>{review.comment}</p>}
              {review.liked && (
                <p>
                  <b>Enjoyed</b> {review.liked}
                </p>
              )}
              {review.improve && (
                <p>
                  <b>Could improve</b> {review.improve}
                </p>
              )}
              {review.photo && (
                <img
                  src={review.photo}
                  alt="Guest food photo for moderation"
                  className="moderation-photo"
                />
              )}
              <label>
                Restaurant reply
                <textarea
                  rows={2}
                  maxLength={400}
                  value={draft(review).reply}
                  onChange={(event) =>
                    change(review, "reply", event.target.value)
                  }
                />
              </label>
              <label>
                Moderation reason
                <input
                  maxLength={250}
                  value={draft(review).reason}
                  onChange={(event) =>
                    change(review, "reason", event.target.value)
                  }
                />
              </label>
              <div className="card-actions">
                <Button
                  className="button-small"
                  disabled={action.busy}
                  onClick={() => moderate(review, "approved")}
                >
                  {review.visibility === "private"
                    ? "Acknowledge"
                    : "Publish / save reply"}
                </Button>
                <Button
                  secondary
                  className="button-small"
                  disabled={action.busy}
                  onClick={() => moderate(review, "hidden")}
                >
                  Hide
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Heart}
          title="Guest voices arrive here."
          text="A guest can rate individual dishes after their order is served."
        />
      )}
    </PanelState>
  );
}

export function RequestsPanel({ resource, notify, onRefresh }) {
  const action = useAction(notify);
  const now = useClock();
  async function update(request, operation) {
    await action.run(
      () =>
        api("/staff/service-requests/" + request.id + "/" + operation, {
          method: "POST",
          data: {},
        }),
      operation === "resolve" ? "Request resolved." : "Request acknowledged.",
      async () => {
        await resource.reload();
        onRefresh();
      },
    );
  }
  return (
    <PanelState resource={resource}>
      <div className="panel-heading">
        <div>
          <h2>Floor requests</h2>
          <p>
            Acknowledge a call so the guest knows help is on the way. Resolve it
            after assisting.
          </p>
        </div>
      </div>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      {resource.data?.requests.length ? (
        <div className="requests-grid">
          {resource.data.requests.map((request) => (
            <article className="floor-request" key={request.id}>
              <span className="request-symbol">
                {request.type === "bill" ? (
                  <ReceiptText size={24} />
                ) : (
                  <BellRing size={24} />
                )}
              </span>
              <div>
                <h3>Table {request.tableNumber.slice(1)}</h3>
                <strong>
                  {request.type === "bill"
                    ? "Bill requested"
                    : request.type === "issue"
                      ? "Guest needs help"
                      : "Waiter requested"}
                </strong>
                {request.note && <p>{request.note}</p>}
                <small>
                  {dhakaTime(request.createdAt)} · Waiting{" "}
                  {Math.max(
                    0,
                    Math.floor(
                      (now - new Date(request.createdAt).getTime()) / 60000,
                    ),
                  )}{" "}
                  min
                </small>
                <small>
                  {request.status === "acknowledged"
                    ? "Acknowledged by " + request.acknowledgedBy
                    : "Not yet acknowledged"}
                </small>
              </div>
              <div className="request-actions">
                {request.status !== "acknowledged" && (
                  <Button
                    className="button-small"
                    disabled={action.busy}
                    onClick={() => update(request, "acknowledge")}
                  >
                    Acknowledge
                  </Button>
                )}
                <Button
                  secondary
                  className="button-small"
                  disabled={action.busy}
                  onClick={() => update(request, "resolve")}
                >
                  <Check size={16} />
                  Resolve request
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={BellRing}
          title="The floor is all caught up."
          text="Calls for a waiter or a bill appear here with their table number."
        />
      )}
    </PanelState>
  );
}

export function ManualOrderPanel({ notify, onRefresh }) {
  const { menu, money } = useApp();
  const tables = useResource("/staff/tables");
  const [tableNumber, setTableNumber] = useState("");
  const [selected, setSelected] = useState("");
  const [lines, setLines] = useState([]);
  const [note, setNote] = useState("");
  const [key, setKey] = useState(requestKey);
  const action = useAction(notify);
  const table = tables.data?.tables.find((item) => item.number === tableNumber);
  const total = lines.reduce(
    (sum, line) =>
      sum +
      (menu.find((dish) => dish._id === line.dishId)?.price || 0) *
        line.quantity,
    0,
  );
  function add() {
    const dish = menu.find((item) => item._id === selected);
    if (!dish) return;
    const existing = lines.find((item) => item.dishId === dish._id);
    if (
      (existing && existing.quantity >= 10) ||
      (!existing && lines.length >= 12)
    )
      return;
    setLines(
      existing
        ? lines.map((line) =>
            line.dishId === dish._id
              ? { ...line, quantity: line.quantity + 1 }
              : line,
          )
        : [...lines, { dishId: dish._id, quantity: 1 }],
    );
    setKey(requestKey());
  }
  async function submit(event) {
    event.preventDefault();
    if (!table?.visitKey || !lines.length) return;
    const result = await action.run(
      () =>
        api("/staff/manual-orders", {
          method: "POST",
          headers: { "Idempotency-Key": key },
          data: {
            tableNumber,
            order: {
              visitKey: table.visitKey,
              items: lines.map((line) => ({
                ...line,
                expectedPrice: menu.find((dish) => dish._id === line.dishId)
                  .price,
              })),
              note,
            },
          },
        }),
      "Order is on the shared order desk.",
    );
    if (result.ok) {
      setLines([]);
      setNote("");
      setKey(requestKey());
      onRefresh();
    }
  }
  return (
    <PanelState resource={tables}>
      <div className="staff-panel manual-order-panel">
        <div className="panel-heading">
          <div>
            <h2>A little help at the table</h2>
            <p>Take a guest’s order into the same queue as QR orders.</p>
          </div>
          <UtensilsCrossed size={27} />
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            Active table
            <select
              value={tableNumber}
              onChange={(event) => {
                setTableNumber(event.target.value);
                setKey(requestKey());
              }}
              required
            >
              <option value="">Choose a table</option>
              {tables.data?.tables
                .filter(
                  (item) => item.open && item.billingState !== "finalized",
                )
                .map((item) => (
                  <option key={item.number} value={item.number}>
                    Table {item.number.slice(1)}
                  </option>
                ))}
            </select>
          </label>
          <div className="manual-add-line">
            <label>
              Menu item
              <select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">Choose a dish</option>
                {menu
                  .filter((dish) => dish.available)
                  .map((dish) => (
                    <option key={dish._id} value={dish._id}>
                      {dish.name} · {money(dish.price)}
                    </option>
                  ))}
              </select>
            </label>
            <Button secondary onClick={add} disabled={!selected}>
              <Plus size={17} />
              Add
            </Button>
          </div>
          <ul className="manual-lines">
            {lines.map((line) => {
              const dish = menu.find((item) => item._id === line.dishId);
              return (
                <li key={line.dishId}>
                  <strong>{dish?.name}</strong>
                  <label className="sr-only" htmlFor={"manual-" + line.dishId}>
                    Quantity of {dish?.name}
                  </label>
                  <input
                    id={"manual-" + line.dishId}
                    type="number"
                    min="1"
                    max="10"
                    value={line.quantity}
                    onChange={(event) => {
                      setLines(
                        lines.map((item) =>
                          item === line
                            ? {
                                ...line,
                                quantity: Math.max(
                                  1,
                                  Math.min(10, Number(event.target.value)),
                                ),
                              }
                            : item,
                        ),
                      );
                      setKey(requestKey());
                    }}
                  />
                  <span>{money((dish?.price || 0) * line.quantity)}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={"Remove " + dish?.name}
                    onClick={() => {
                      setLines(lines.filter((item) => item !== line));
                      setKey(requestKey());
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
          <label>
            Kitchen note
            <textarea
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setKey(requestKey());
              }}
              maxLength={200}
              rows={2}
            />
          </label>
          <div className="manual-total">
            Food total<strong>{money(total)}</strong>
          </div>
          {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
          <button
            type="submit"
            className="button button-primary"
            disabled={action.busy || !tableNumber || !lines.length}
          >
            Place table order
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </PanelState>
  );
}

export function MenuPanel({ notify, onRefresh }) {
  const { money, reloadMenu } = useApp();
  const resource = useResource("/menu");
  const [editing, setEditing] = useState(null);
  return (
    <PanelState resource={resource}>
      <div className="panel-heading">
        <div>
          <h2>Your menu, your studio</h2>
          <p>Keep the details and availability in step with your kitchen.</p>
        </div>
        <Button className="button-small" onClick={() => setEditing({})}>
          <Plus size={16} />
          Add a dish
        </Button>
      </div>
      <div className="menu-studio-grid">
        {resource.data?.dishes.map((dish) => (
          <article className="studio-card" key={dish._id}>
            <img src={dish.image} alt={dish.name} width="160" height="160" />
            <div>
              <span
                className={
                  "soft-badge" + (!dish.available ? " unavailable" : "")
                }
              >
                {dish.available ? "Available" : "Sold out"}
              </span>
              <h3>{dish.name}</h3>
              <p>
                {dish.category} · Serves {dish.serves || 1}
              </p>
              <strong>{money(dish.price)}</strong>
            </div>
            <Button
              secondary
              className="button-small"
              onClick={() => setEditing(dish)}
            >
              Edit dish
            </Button>
          </article>
        ))}
      </div>
      {editing && (
        <DishEditor
          dish={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            notify("Menu updated.");
            void resource.reload();
            void reloadMenu();
            onRefresh();
          }}
        />
      )}
    </PanelState>
  );
}
const localPhotos = [
  "mutton-kacchi",
  "chicken-tikka",
  "beef-seekh",
  "beef-tehari",
  "mint-borhani",
  "pistachio-phirni",
];
function DishEditor({ dish, onClose, onDone }) {
  const isNew = !dish._id;
  const [values, setValues] = useState({
    id: dish._id || "",
    name: dish.name || "",
    nameBn: dish.nameBn || "",
    description: dish.description || "",
    descriptionBn: dish.descriptionBn || "",
    price: dish.price || 300,
    available: dish.available ?? true,
    category: dish.category || "mains",
    spice: dish.spice || "medium",
    serves: dish.serves || 1,
    image: dish.image || "/assets/mutton-kacchi.webp",
    variants: dish.variants || [],
    addons: dish.addons || [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function field(event) {
    const { name, value, type, checked } = event.target;
    setValues((old) => ({
      ...old,
      [name]:
        type === "checkbox"
          ? checked
          : type === "number"
            ? Number(value)
            : value,
    }));
  }
  function option(group, index, key, value) {
    setValues((old) => ({
      ...old,
      [group]: old[group].map((item, i) =>
        i === index
          ? { ...item, [key]: key === "price" ? Number(value) : value }
          : item,
      ),
    }));
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { id, ...data } = values;
      const options = (list) =>
        list.map((entry) => ({
          ...entry,
          id:
            entry.id ||
            entry.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, ""),
        }));
      data.variants = options(data.variants);
      data.addons = options(data.addons);
      await api(isNew ? "/staff/menu" : "/staff/menu/" + dish._id, {
        method: isNew ? "POST" : "PATCH",
        data: isNew ? { ...data, _id: id } : data,
      });
      onDone();
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? "Add a dish" : "Edit " + dish.name}
      className="menu-editor-dialog"
    >
      <form className="form-stack" onSubmit={submit}>
        {isNew && (
          <label>
            Dish ID (lowercase letters, numbers and hyphens)
            <input
              name="id"
              value={values.id}
              onChange={field}
              pattern="[a-z0-9-]{1,64}"
              required
              maxLength={64}
            />
          </label>
        )}
        <div className="form-grid">
          <label>
            English name
            <input
              name="name"
              required
              minLength={2}
              maxLength={80}
              value={values.name}
              onChange={field}
            />
          </label>
          <label>
            Bangla name
            <input
              name="nameBn"
              maxLength={100}
              value={values.nameBn}
              onChange={field}
            />
          </label>
        </div>
        <label>
          Description
          <textarea
            name="description"
            required
            minLength={3}
            maxLength={300}
            value={values.description}
            onChange={field}
            rows={2}
          />
        </label>
        <label>
          Bangla description
          <textarea
            name="descriptionBn"
            maxLength={400}
            value={values.descriptionBn}
            onChange={field}
            rows={2}
          />
        </label>
        <div className="form-grid three">
          <label>
            Base price (৳)
            <input
              name="price"
              type="number"
              min="1"
              max="100000"
              required
              value={values.price}
              onChange={field}
            />
          </label>
          <label>
            Category
            <select name="category" value={values.category} onChange={field}>
              <option value="mains">Rice & mains</option>
              <option value="grill">Grill</option>
              <option value="drinks">Drinks</option>
              <option value="dessert">Dessert</option>
            </select>
          </label>
          <label>
            Serves
            <input
              name="serves"
              type="number"
              min="1"
              max="10"
              required
              value={values.serves}
              onChange={field}
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Spice level
            <select name="spice" value={values.spice} onChange={field}>
              <option value="mild">Mild</option>
              <option value="medium">Medium</option>
              <option value="hot">Hot</option>
            </select>
          </label>
          <label>
            Illustrative photo
            <select name="image" value={values.image} onChange={field}>
              {localPhotos.map((id) => (
                <option key={id} value={"/assets/" + id + ".webp"}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
        {["variants", "addons"].map((group) => (
          <fieldset className="option-editor" key={group}>
            <legend>
              {group === "variants" ? "Size options" : "Optional add-ons"}
            </legend>
            {values[group].map((entry, index) => (
              <div className="option-editor-row" key={index}>
                <input
                  aria-label={group + " name " + (index + 1)}
                  placeholder="English name"
                  required
                  maxLength={50}
                  value={entry.name}
                  onChange={(event) =>
                    option(group, index, "name", event.target.value)
                  }
                />
                <input
                  aria-label={group + " Bangla name " + (index + 1)}
                  placeholder="Bangla name"
                  maxLength={70}
                  value={entry.nameBn || ""}
                  onChange={(event) =>
                    option(group, index, "nameBn", event.target.value)
                  }
                />
                <input
                  type="number"
                  aria-label={group + " extra price " + (index + 1)}
                  min="0"
                  max="10000"
                  required
                  value={entry.price}
                  onChange={(event) =>
                    option(group, index, "price", event.target.value)
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove option"
                  onClick={() =>
                    setValues({
                      ...values,
                      [group]: values[group].filter((_, i) => i !== index),
                    })
                  }
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-link"
              disabled={values[group].length >= (group === "variants" ? 5 : 6)}
              onClick={() =>
                setValues({
                  ...values,
                  [group]: [
                    ...values[group],
                    { id: "", name: "", nameBn: "", price: 0 },
                  ],
                })
              }
            >
              <Plus size={15} />
              Add {group === "variants" ? "size" : "add-on"}
            </button>
          </fieldset>
        ))}
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="available"
            checked={values.available}
            onChange={field}
          />
          <span>Available to order</span>
        </label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button type="submit" className="button button-primary" disabled={busy}>
          Save menu item
          <Check size={16} />
        </button>
      </form>
    </Modal>
  );
}

export function SettingsPanel({ notify, onRefresh }) {
  const resource = useResource("/staff/settings");
  return (
    <PanelState resource={resource}>
      {resource.data && (
        <SettingsForm
          key={JSON.stringify(resource.data)}
          restaurant={resource.data.restaurant}
          notify={notify}
          onSaved={() => {
            void resource.reload();
            onRefresh();
          }}
        />
      )}
    </PanelState>
  );
}
function SettingsForm({ restaurant, notify, onSaved }) {
  const { reloadRestaurant } = useApp();
  const [enabled, setEnabled] = useState(restaurant.orderingEnabled);
  const [percent, setPercent] = useState(restaurant.serviceChargeBps / 100);
  const action = useAction(notify);
  async function submit(event) {
    event.preventDefault();
    await action.run(
      () =>
        api("/staff/settings", {
          method: "PATCH",
          data: {
            orderingEnabled: enabled,
            serviceChargeBps: Math.round(percent * 100),
          },
        }),
      "Restaurant settings saved.",
      async () => {
        await reloadRestaurant();
        onSaved();
      },
    );
  }
  return (
    <form className="staff-panel settings-form form-stack" onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>Service, at your pace</h2>
          <p>These settings affect new orders and newly finalized bills.</p>
        </div>
        <ShieldCheck size={25} />
      </div>
      <label className="settings-toggle">
        <span>
          <strong>Accept table orders</strong>
          <small>Pause ordering while the kitchen catches up.</small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </label>
      <label>
        Service charge (%)
        <input
          type="number"
          step="0.01"
          min="0"
          max="20"
          required
          value={percent}
          onChange={(event) => setPercent(Number(event.target.value))}
        />
      </label>
      <p className="form-help">
        The default is 0%. Configure the amount agreed with your restaurant.
        Finalized bills retain their original charge.
      </p>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      <button
        type="submit"
        className="button button-primary"
        disabled={action.busy}
      >
        Save settings
        <Check size={16} />
      </button>
    </form>
  );
}

export function EventsPanel({ notify, onRefresh }) {
  const { money } = useApp();
  const resource = useResource("/staff/events");
  const [quote, setQuote] = useState(null);
  const [reason, setReason] = useState(null);
  const [deposit, setDeposit] = useState(null);
  const action = useAction(notify);
  async function change(event, step) {
    await action.run(
      () =>
        api("/staff/events/" + event.id + "/action", {
          method: "POST",
          data: { action: step },
        }),
      "Event updated.",
      () => resource.reload(),
    );
    onRefresh();
  }
  return (
    <PanelState resource={resource}>
      <div className="panel-heading">
        <div>
          <h2>Gatherings to make memorable</h2>
          <p>
            Review requests, hold a slot with a quote, and confirm verified
            deposits.
          </p>
        </div>
        <Button secondary className="button-small" onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh events
        </Button>
      </div>
      {action.error && <ErrorMessage>{action.error}</ErrorMessage>}
      {resource.data?.events.length ? (
        <div className="staff-events-grid">
          {resource.data.events.map((event) => (
            <article className="staff-event-card" key={event.id}>
              <header>
                <span className="event-card-icon">
                  <CalendarDays size={22} />
                </span>
                <div>
                  <small>{event.code}</small>
                  <h3>{event.name}</h3>
                </div>
                <Status status={event.status} />
              </header>
              <div className="event-card-details">
                <p>
                  <Clock3 size={15} />
                  {dhakaTime(event.startsAt)} · {event.guests} guests
                </p>
                <p>
                  <Table2 size={15} />
                  {event.space?.name ||
                    (event.spaceId === "dining-room"
                      ? "Full dining room"
                      : "Family corner")}{" "}
                  · {event.type}
                </p>
                <p>
                  <Users size={15} />
                  {event.phone}
                </p>
              </div>
              {event.note && <p className="event-staff-note">{event.note}</p>}
              {event.quote && (
                <div className="event-quote-summary">
                  <span>
                    Quote v{event.quote.version}
                    <strong>{money(event.quote.total)}</strong>
                  </span>
                  <small>
                    Deposit {money(event.quote.deposit)} · Hold until{" "}
                    {dhakaTime(event.quote.expiresAt)}
                  </small>
                  {event.depositRefundedMinor > 0 && (
                    <small>
                      Confirmed deposit refunds:{" "}
                      {money(event.depositRefundedMinor / 100)}
                    </small>
                  )}
                </div>
              )}
              <footer>
                {["requested", "reviewing", "quote_sent"].includes(
                  event.status,
                ) && (
                  <>
                    <Button
                      className="button-small"
                      onClick={() => setQuote(event)}
                    >
                      {event.quote ? "Revise quote" : "Prepare quote"}
                      <ArrowRight size={15} />
                    </Button>
                    {event.status === "requested" && (
                      <Button
                        secondary
                        className="button-small"
                        disabled={action.busy}
                        onClick={() => change(event, "review")}
                      >
                        Under review
                      </Button>
                    )}
                    <button
                      type="button"
                      className="text-link"
                      onClick={() =>
                        setReason({
                          path: "/staff/events/" + event.id + "/action",
                          data: { action: "decline" },
                          title: "Decline event request",
                        })
                      }
                    >
                      Decline
                    </button>
                  </>
                )}
                {event.status === "awaiting_deposit" && (
                  <Button
                    className="button-small"
                    onClick={() => setDeposit(event)}
                  >
                    Record verified deposit
                  </Button>
                )}
                {event.status === "confirmed" && (
                  <Button
                    secondary
                    className="button-small"
                    disabled={
                      new Date(event.endsAt) > new Date() || action.busy
                    }
                    onClick={() => change(event, "complete")}
                  >
                    Mark event complete
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={CalendarDays}
          title="A room full of possibilities."
          text="Private gathering requests appear here for your team to plan."
        />
      )}
      {quote && (
        <QuoteEditor
          event={quote}
          onClose={() => setQuote(null)}
          onDone={() => {
            notify("Quote sent. The space is held until the quote expires.");
            void resource.reload();
            onRefresh();
          }}
        />
      )}
      {reason && (
        <ReasonModal
          request={reason}
          onClose={() => setReason(null)}
          onDone={() => {
            notify("Event request updated.");
            void resource.reload();
            onRefresh();
          }}
        />
      )}
      {deposit && (
        <DepositModal
          event={deposit}
          onClose={() => setDeposit(null)}
          onDone={() => {
            notify("Verified deposit recorded. Event confirmed.");
            void resource.reload();
            onRefresh();
          }}
        />
      )}
    </PanelState>
  );
}
function QuoteEditor({ event, onClose, onDone }) {
  const { money } = useApp();
  const [values, setValues] = useState({
    hallFee: event.quote?.hallFee ?? event.package?.hallFee ?? 0,
    perGuest: event.quote?.perGuest ?? event.package?.perGuest ?? 550,
    extras: event.quote?.extras || 0,
    depositPercent:
      event.quote?.depositPercent ?? event.package?.depositPercent ?? 0,
    terms:
      event.quote?.terms ||
      "Please confirm the final guest count at least 48 hours before the event. Contact our team for any changes.",
    menu:
      event.quote?.menu ||
      event.package?.description ||
      "Kacchi, kebab, borhani and phirni.",
    validHours: 48,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const total = values.hallFee + values.perGuest * event.guests + values.extras;
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/staff/events/" + event.id + "/quote", {
        method: "POST",
        data: values,
      });
      onDone();
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function field(e) {
    setValues({
      ...values,
      [e.target.name]:
        e.target.type === "number" ? Number(e.target.value) : e.target.value,
    });
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={"Quote for " + event.name}
      className="quote-dialog"
    >
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          {event.guests} guests · {dhakaTime(event.startsAt)} · {event.spaceId}
        </p>
        <div className="form-grid three">
          {[
            ["hallFee", "Space fee (৳)", 500000],
            ["perGuest", "Food / guest (৳)", 10000],
            ["extras", "Extras (৳)", 500000],
          ].map(([key, label, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                name={key}
                required
                min="0"
                max={max}
                value={values[key]}
                onChange={field}
              />
            </label>
          ))}
        </div>
        <label>
          Confirmed menu
          <textarea
            name="menu"
            required
            minLength={3}
            maxLength={500}
            rows={2}
            value={values.menu}
            onChange={field}
          />
        </label>
        <div className="form-grid">
          <label>
            Deposit (%)
            <input
              type="number"
              name="depositPercent"
              required
              min="0"
              max="100"
              value={values.depositPercent}
              onChange={field}
            />
          </label>
          <label>
            Hold validity (hours)
            <input
              type="number"
              name="validHours"
              required
              min="1"
              max="168"
              value={values.validHours}
              onChange={field}
            />
          </label>
        </div>
        <label>
          Terms for the guest
          <textarea
            name="terms"
            required
            minLength={10}
            maxLength={1000}
            rows={3}
            value={values.terms}
            onChange={field}
          />
        </label>
        <div className="quote-calculation">
          <span>
            Quote total<strong>{money(total)}</strong>
          </span>
          <span>
            Deposit
            <strong>
              {money(Math.round((total * values.depositPercent) / 100))}
            </strong>
          </span>
        </div>
        <p className="form-help">
          The space is checked for overlapping held or confirmed events,
          including a 30-minute cleanup buffer.
        </p>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button type="submit" className="button button-primary" disabled={busy}>
          Send quote & hold space
          <ArrowRight size={17} />
        </button>
      </form>
    </Modal>
  );
}
function DepositModal({ event, onClose, onDone }) {
  const { money } = useApp();
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("unclassified");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/staff/events/" + event.id + "/action", {
        method: "POST",
        data: { action: "deposit", reference, verified, method },
      });
      onDone();
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Record event deposit"
      className="small-dialog"
    >
      <form className="form-stack" onSubmit={submit}>
        <div className="payment-amount">
          <small>Verified deposit for {event.code}</small>
          <strong>{money(event.quote.deposit)}</strong>
        </div>
        <label>
          Deposit payment channel
          <select
            aria-label="Deposit payment channel"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
          >
            {[
              ["unclassified", "Unclassified / historical channel"],
              ["cash", "Cash in restaurant drawer"],
              ["bank", "Bank transfer"],
              ["bkash", "bKash"],
              ["nagad", "Nagad"],
              ["card", "Card"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="commerce-note">
          Select cash when the deposit was physically received in the shared
          drawer. Only confirmed cash is included in a cash shift.
        </p>
        <label>
          Payment reference
          <input
            required
            maxLength={100}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label className="checkbox-label">
          <input
            required
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          <span>I verified this deposit was received at the restaurant.</span>
        </label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || !verified}
        >
          Confirm verified deposit
          <Check size={17} />
        </button>
      </form>
    </Modal>
  );
}
