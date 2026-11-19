import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  BellRing,
  CalendarDays,
  ChefHat,
  CircleDollarSign,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  MenuSquare,
  MessageSquareText,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Table2,
  UtensilsCrossed,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Eyebrow, Loading, Logo } from "../components/UI";
import { AvailabilityPanel, SalesReportsPanel } from "../components/Operations";
import { ReservationDesk, CouponsPanel, GatewayPanel } from "./CommerceStaff";
import {
  BillingPanel,
  EventsPanel,
  ManualOrderPanel,
  MenuPanel,
  OrdersPanel,
  OverviewPanel,
  RequestsPanel,
  ReviewsPanel,
  SettingsPanel,
  TablesPanel,
} from "./StaffPanels";

const navigation = [
  ["overview", LayoutDashboard, "Overview", ["admin", "cashier"]],
  ["orders", ClipboardList, "Order desk", ["admin", "kitchen", "waiter"]],
  ["tables", Table2, "Table visits", ["admin", "waiter"]],
  ["billing", CircleDollarSign, "Counter & bills", ["admin", "cashier"]],
  ["events", CalendarDays, "Private events", ["admin"]],
  ["reviews", MessageSquareText, "Guest feedback", ["admin"]],
  ["requests", BellRing, "Floor requests", ["admin", "waiter"]],
  ["manual", UtensilsCrossed, "Take an order", ["admin", "waiter"]],
  ["menu", MenuSquare, "Menu studio", ["admin"]],
  ["availability", MenuSquare, "Food availability", ["admin", "kitchen"]],
  ["reports", CircleDollarSign, "Sales reports", ["admin", "cashier"]],
  ["reservations", CalendarDays, "Reservations & queue", ["admin", "waiter"]],
  ["coupons", MenuSquare, "Coupons & loyalty", ["admin"]],
  ["gateway", CircleDollarSign, "Online payments", ["admin", "cashier"]],
  ["settings", Settings2, "Restaurant settings", ["admin"]],
];

export function Staff() {
  const [user, setUser] = useState(undefined);
  const [bootError, setBootError] = useState("");
  useEffect(() => {
    let active = true;
    api("/staff/me")
      .then((data) => {
        if (active) setUser(data);
      })
      .catch((error) => {
        if (active) {
          setUser(null);
          if (error.status !== 401) setBootError(error.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  if (user === undefined)
    return (
      <div className="staff-boot">
        <Loading label="Opening your workspace…" />
      </div>
    );
  return user ? (
    <Dashboard user={user} onSignedOut={() => setUser(null)} />
  ) : (
    <Login onSignedIn={setUser} initialError={bootError} />
  );
}
function Login({ onSignedIn, initialError }) {
  const [values, setValues] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await api("/staff/login", { method: "POST", data: values });
      setValues({ username: "", password: "" });
      onSignedIn(user);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="staff-login-page">
      <div className="staff-login-visual">
        <Logo light />
        <div>
          <Eyebrow light>ANGAR OPERATIONS</Eyebrow>
          <h1>
            Behind every
            <br />
            good <em>table.</em>
          </h1>
          <p>
            One workspace for the kitchen, the floor and the team that brings it
            all together.
          </p>
          <div className="login-stations">
            <span>
              <ShieldCheck size={18} />
              Order desk
            </span>
            <span>
              <ChefHat size={18} />
              Kitchen
            </span>
            <span>
              <UtensilsCrossed size={18} />
              Floor
            </span>
          </div>
        </div>
        <img src="/assets/hero-platter.webp" alt="" width="600" height="600" />
      </div>
      <div className="staff-login-form-wrap">
        <Link to="/" className="staff-back-link">
          Restaurant website <ArrowUpRight size={16} />
        </Link>
        <form className="staff-login-form form-stack" onSubmit={submit}>
          <span className="login-lock">
            <ShieldCheck size={26} />
          </span>
          <Eyebrow>WELCOME TO YOUR STATION</Eyebrow>
          <h2>
            Let’s get
            <br />
            <em>service started.</em>
          </h2>
          <p>Sign in with the account assigned to your role.</p>
          <label>
            Username
            <input
              name="username"
              autoComplete="username"
              required
              maxLength={32}
              value={values.username}
              onChange={(e) =>
                setValues({ ...values, username: e.target.value })
              }
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={values.password}
              onChange={(e) =>
                setValues({ ...values, password: e.target.value })
              }
            />
          </label>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <button
            className="button button-primary button-wide"
            type="submit"
            disabled={busy}
          >
            {busy ? "Signing in…" : "Open my workspace"}
            <ArrowRight size={17} />
          </button>
          <small className="staff-login-help">
            Admin · Kitchen · Waiter · Cashier
          </small>
        </form>
      </div>
    </div>
  );
}
function ring(context) {
  if (!context || context.state !== "running") return;
  try {
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.frequency.value = 660;
    volume.gain.setValueAtTime(0.07, context.currentTime);
    volume.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.25);
    oscillator.onended = () => {
      oscillator.disconnect();
      volume.disconnect();
    };
  } catch {
    /* A muted or suspended device must not interrupt the queue. */
  }
}
export function Dashboard({ user, onSignedOut }) {
  const { notify } = useApp();
  const [tab, setTab] = useState(
    user.role === "admin"
      ? "overview"
      : user.role === "cashier"
        ? "billing"
        : "orders",
  );
  const [sidebar, setSidebar] = useState(false);
  const [sound, setSound] = useState(false);
  const audio = useRef(null);
  const seen = useRef(null);
  const seenRequests = useRef(null);
  const queue = useResource("/staff/orders", { interval: 3000 });
  const overview = useResource("/staff/overview", { interval: 10000 });
  const floorQueue = useResource("/staff/service-requests", {
    interval: 3000,
    enabled: ["admin", "waiter"].includes(user.role),
  });
  const activeNav = navigation.filter((item) => item[3].includes(user.role));
  const title = activeNav.find((item) => item[0] === tab)?.[2] || "Workspace";
  useEffect(() => {
    if (queue.error?.status === 401 || overview.error?.status === 401)
      onSignedOut();
  }, [queue.error, overview.error, onSignedOut]);
  useEffect(() => {
    if (!queue.data) return;
    const ids = new Set(
      queue.data.orders.flatMap((order) => [
        "ticket:" + order.id,
        ...(order.changeRequest?.status === "pending"
          ? ["change:" + order.id + ":" + order.changeRequest.id]
          : []),
      ]),
    );
    const fresh =
      seen.current && [...ids].filter((id) => !seen.current.has(id)).length;
    seen.current = ids;
    if (fresh) {
      notify(fresh + " new station " + (fresh === 1 ? "update." : "updates."));
      if (sound) ring(audio.current);
    }
  }, [queue.data, sound, notify]);
  useEffect(() => {
    if (!floorQueue.data) return;
    const ids = new Set(floorQueue.data.requests.map((request) => request.id));
    const fresh =
      seenRequests.current &&
      [...ids].filter((id) => !seenRequests.current.has(id)).length;
    seenRequests.current = ids;
    if (fresh) {
      notify(fresh + " new floor " + (fresh === 1 ? "request." : "requests."));
      if (sound) ring(audio.current);
    }
  }, [floorQueue.data, sound, notify]);
  async function toggleSound() {
    if (!sound) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) {
        notify("Sound alerts are unavailable in this browser.");
        return;
      }
      audio.current ||= new Audio();
      try {
        await audio.current.resume();
      } catch {
        notify("Tap Enable alerts again to allow sound.");
        return;
      }
    }
    setSound(!sound);
  }
  async function signout() {
    try {
      await api("/staff/logout", { method: "POST", data: {} });
      onSignedOut();
    } catch (error) {
      notify(error.message);
    }
  }
  const common = {
    user,
    notify,
    onRefresh: () => {
      void queue.reload();
      void overview.reload();
      void floorQueue.reload();
    },
  };
  function select(value) {
    if (!activeNav.some((item) => item[0] === value)) return;
    setTab(value);
    setSidebar(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  return (
    <div className="staff-app">
      <aside className={"staff-sidebar" + (sidebar ? " open" : "")}>
        <Logo light small />
        <div className="workspace-label">RESTAURANT WORKSPACE</div>
        <nav aria-label="Staff workspace">
          {activeNav.map(([id, Icon, label]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => select(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "orders" &&
                queue.data?.orders.filter(
                  (order) =>
                    order.status === "placed" ||
                    order.changeRequest?.status === "pending",
                ).length > 0 && (
                  <b>
                    {
                      queue.data.orders.filter(
                        (order) =>
                          order.status === "placed" ||
                          order.changeRequest?.status === "pending",
                      ).length
                    }
                  </b>
                )}
              {id === "requests" && floorQueue.data?.requests.length > 0 && (
                <b>{floorQueue.data.requests.length}</b>
              )}
              {id === "reviews" && overview.data?.pendingReviews > 0 && (
                <b>{overview.data.pendingReviews}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="staff-sidebar-bottom">
          <Link to="/">
            Restaurant website
            <ArrowUpRight size={16} />
          </Link>
          <button type="button" onClick={signout}>
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="staff-content-wrap">
        <header className="staff-topbar">
          <button
            type="button"
            className="icon-button staff-menu-toggle"
            aria-label="Open workspace navigation"
            onClick={() => setSidebar(!sidebar)}
          >
            <ClipboardList size={20} />
          </button>
          <div className="staff-breadcrumb">
            Workspace <span>/</span>
            <strong>{title}</strong>
          </div>
          <div className="staff-topbar-right">
            <button
              className={"sound-toggle" + (sound ? " enabled" : "")}
              type="button"
              onClick={toggleSound}
              aria-pressed={sound}
            >
              {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
              <span>{sound ? "Alerts on" : "Enable alerts"}</span>
            </button>
            <span className="staff-avatar">
              {user.username[0].toUpperCase()}
            </span>
            <span className="staff-user">
              <strong>{user.username}</strong>
              <small>{user.role}</small>
            </span>
          </div>
        </header>
        <main className="staff-main">
          <div className="staff-page-heading">
            <div>
              <Eyebrow>ANGAR KITCHEN · DHANMONDI</Eyebrow>
              <h1>
                {tab === "overview" ? "A good day for good food." : title}
              </h1>
              <p>
                {tab === "overview"
                  ? "Your restaurant, at a glance."
                  : tab === "orders"
                    ? "Every table, every ticket, one clear next step."
                    : "Make service feel effortless, one detail at a time."}
              </p>
            </div>
            <Button
              secondary
              className="button-small"
              onClick={() => {
                common.onRefresh();
              }}
            >
              <RefreshCw size={15} />
              Refresh queue
            </Button>
          </div>
          <div
            className={"live-status" + (queue.error ? " offline" : "")}
            role="status"
          >
            <span />
            {queue.error
              ? "Live updates paused. Reconnecting…"
              : "Connected · queue refreshes every 3 seconds"}
            <time>{dhakaTime(new Date(), true)}</time>
          </div>
          {tab === "overview" && (
            <OverviewPanel
              {...common}
              overview={overview}
              queue={queue}
              onSelect={select}
            />
          )}
          {tab === "orders" && <OrdersPanel {...common} queue={queue} />}
          {tab === "tables" && <TablesPanel {...common} />}
          {tab === "billing" && <BillingPanel {...common} />}
          {tab === "events" && <EventsPanel {...common} />}
          {tab === "reviews" && <ReviewsPanel {...common} />}
          {tab === "requests" && (
            <RequestsPanel {...common} resource={floorQueue} />
          )}
          {tab === "manual" && <ManualOrderPanel {...common} />}
          {tab === "menu" && <MenuPanel {...common} />}
          {tab === "availability" && <AvailabilityPanel {...common} />}
          {tab === "reports" && <SalesReportsPanel />}
          {tab === "reservations" && <ReservationDesk {...common} />}
          {tab === "coupons" && <CouponsPanel {...common} />}
          {tab === "gateway" && <GatewayPanel {...common} />}
          {tab === "settings" && <SettingsPanel {...common} />}
        </main>
      </div>
    </div>
  );
}
