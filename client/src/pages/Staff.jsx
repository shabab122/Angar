import { BranchSelector } from "../components/BranchSelector";
import { useLiveUpdates } from "../lib/useLiveUpdates";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
  PackageCheck,
  RefreshCw,
  Settings2,
  ShoppingBag,
  ShieldCheck,
  Table2,
  Truck,
  UtensilsCrossed,
  Volume2,
  VolumeX,
  Wallet,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Eyebrow, Loading, Logo } from "../components/UI";
import { AvailabilityPanel, SalesReportsPanel } from "../components/Operations";
import { ReservationDesk, CouponsPanel, GatewayPanel } from "./CommerceStaff";
import { RefundsPanel } from "./RefundsPanel";
import { StaffAccounts, StaffPassword } from "./StaffAccounts";
import { InventoryPanel } from "./InventoryPanel";
import { InvoiceSettings } from "./InvoiceSettings";
import { BackupsPanel } from "./BackupsPanel";
import { NotificationLogs } from "./Notifications";
import { FulfillmentDesk } from "./Takeaway";
import { AuditDashboard, CashDrawerPanel } from "./AuditCash";
import { MfaPanel } from "./MfaPanel";
import { InventoryBatchesPanel } from "./InventoryBatchesPanel";
import { PurchasingPanel } from "./PurchasingPanel";
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

const BranchManagement = lazy(() => import("./BranchManagement"));
const OrganizationDashboard = lazy(() => import("./OrganizationDashboard"));
const StockTransfersPanel = lazy(() => import("./StockTransfersPanel"));
const MonitoringPanel = lazy(() => import("./MonitoringPanel"));
const EventConfiguration = lazy(() => import("./EventConfiguration"));
const CourierPanel = lazy(() => import("./CourierPanel"));
const StocktakesPanel = lazy(() => import("./StocktakesPanel"));
const SupplierReturnsPanel = lazy(() => import("./SupplierReturnsPanel"));
const FinancePanel = lazy(() => import("./FinancePanel"));
const PrintingPanel = lazy(() => import("./PrintingPanel"));
const OperationsAlerts = lazy(() => import("./OperationsAlerts"));

const navigation = [
  ["organization", LayoutDashboard, "All-branch dashboard", ["admin"]],
  [
    "stockTransfers",
    Truck,
    "Inter-branch stock transfers",
    ["admin", "kitchen"],
  ],
  ["monitoring", BellRing, "Technical incidents", ["admin"]],
  ["branches", Truck, "Restaurant branches", ["admin"]],
  ["eventConfig", CalendarDays, "Event spaces & packages", ["admin"]],
  ["courier", Truck, "Couriers & delivery GPS", ["admin", "waiter"]],
  ["stocktakes", PackageCheck, "Physical stock counts", ["admin", "kitchen"]],
  [
    "supplierReturns",
    Truck,
    "Supplier returns & credits",
    ["admin", "cashier"],
  ],
  ["finance", Wallet, "Expenses & operating result", ["admin", "cashier"]],
  [
    "printing",
    ClipboardList,
    "Kitchen & receipt printing",
    ["admin", "kitchen", "cashier"],
  ],
  [
    "operationsAlerts",
    BellRing,
    "Operations alerts",
    ["admin", "kitchen", "cashier"],
  ],
  ["overview", LayoutDashboard, "Overview", ["admin", "cashier"]],
  ["orders", ClipboardList, "Order desk", ["admin", "kitchen", "waiter"]],
  [
    "fulfillment",
    ShoppingBag,
    "Pickup & delivery",
    ["admin", "kitchen", "waiter", "cashier"],
  ],
  ["tables", Table2, "Table visits", ["admin", "waiter"]],
  ["billing", CircleDollarSign, "Counter & bills", ["admin", "cashier"]],
  ["cash", Wallet, "Cash drawer & shifts", ["admin", "cashier"]],
  ["audit", ShieldCheck, "Staff activity", ["admin"]],
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
  ["refunds", CircleDollarSign, "Refunds & credit notes", ["admin", "cashier"]],
  ["team", ShieldCheck, "Staff accounts", ["admin"]],
  ["inventory", MenuSquare, "Ingredients & recipes", ["admin", "kitchen"]],
  ["batches", PackageCheck, "Batches & expiry", ["admin", "kitchen"]],
  ["purchasing", Truck, "Suppliers & purchases", ["admin", "cashier"]],
  ["invoices", Settings2, "Tax & invoices", ["admin"]],
  ["backups", ShieldCheck, "Backups & recovery", ["admin"]],
  ["notifications", BellRing, "Notification delivery", ["admin"]],
  [
    "access",
    ShieldCheck,
    "My access",
    ["admin", "cashier", "kitchen", "waiter"],
  ],
  ["settings", Settings2, "Restaurant settings", ["admin"]],
];

const navPermission = {
  organization: ["branches.dashboard"],
  stockTransfers: ["transfers.view"],
  monitoring: ["monitoring.view"],
  branches: ["branches.manage"],
  eventConfig: ["events.configure"],
  courier: ["courier.manage"],
  stocktakes: ["stocktake.count"],
  supplierReturns: ["purchase.view"],
  finance: ["finance.view"],
  printing: ["printing.kitchen", "printing.receipt", "printing.configure"],
  operationsAlerts: ["alerts.view"],
  orders: ["orders.view"],
  fulfillment: ["orders.view"],
  tables: ["tables.view"],
  billing: ["billing.view"],
  cash: ["cash.manage"],
  audit: ["audit.view"],
  events: ["events.view"],
  reviews: ["reviews.manage"],
  requests: ["floor.manage"],
  manual: ["orders.manual"],
  menu: ["menu.manage"],
  availability: ["availability.manage"],
  reports: ["reports.view"],
  reservations: ["reservations.manage"],
  coupons: ["settings.manage"],
  gateway: ["billing.manage"],
  refunds: ["refund.request"],
  team: ["staff.manage"],
  inventory: ["inventory.view"],
  batches: ["inventory.view"],
  purchasing: ["purchase.view"],
  invoices: ["settings.manage"],
  backups: ["backups.manage"],
  notifications: ["notifications.manage"],
  settings: ["settings.manage"],
};
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
  if (user?.mustChangePassword)
    return <StaffPassword required onSignedOut={() => setUser(null)} />;
  if (user?.mfaSetupRequired)
    return (
      <MfaPanel
        required
        onIdentityUpdated={setUser}
        onSignedOut={() => setUser(null)}
      />
    );
  return user ? (
    <Dashboard
      user={user}
      onSignedOut={() => setUser(null)}
      onIdentityUpdated={setUser}
    />
  ) : (
    <Login onSignedIn={setUser} initialError={bootError} />
  );
}
function Login({ onSignedIn, initialError }) {
  const [values, setValues] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [challenge, setChallenge] = useState(false),
    [code, setCode] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await api(
        challenge ? "/staff/login/verify" : "/staff/login",
        { method: "POST", data: challenge ? { code } : values },
      );
      setValues({ ...values, password: "" });
      if (user.needsMfa) {
        setChallenge(true);
        setCode("");
      } else {
        setValues({ username: "", password: "" });
        setCode("");
        onSignedIn(user);
      }
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
          <BranchSelector staff />
          <Eyebrow>WELCOME TO YOUR STATION</Eyebrow>
          <h2>
            Let’s get
            <br />
            <em>service started.</em>
          </h2>
          <p>
            {challenge
              ? "Enter a fresh authenticator code or one unused recovery code."
              : "Sign in with the account assigned to your role."}
          </p>
          {!challenge && (
            <>
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
            </>
          )}
          {challenge && (
            <label>
              Authenticator or recovery code
              <input
                aria-label="Staff sign-in verification code"
                autoComplete="one-time-code"
                required
                minLength={6}
                maxLength={80}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          )}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <button
            className="button button-primary button-wide"
            type="submit"
            disabled={busy}
          >
            {busy
              ? "Signing in…"
              : challenge
                ? "Verify & open workspace"
                : "Open my workspace"}
            <ArrowRight size={17} />
          </button>
          {challenge && (
            <Button
              secondary
              disabled={busy}
              onClick={async () => {
                try {
                  await api("/staff/logout", { method: "POST", data: {} });
                  setChallenge(false);
                  setCode("");
                  setError("");
                } catch (failure) {
                  setError(failure.message);
                }
              }}
            >
              Restart staff sign-in
            </Button>
          )}
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
export function Dashboard({ user, onSignedOut, onIdentityUpdated = () => {} }) {
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
  // Factor changes rotate this browser's session. Suspend background requests
  // here so an in-flight response for the old session cannot discard the codes.
  const queue = useResource("/staff/orders", {
    interval: 3000,
    enabled: tab !== "access" && user.capabilities?.["orders.view"] !== false,
  });
  const overview = useResource("/staff/overview", {
    interval: 10000,
    enabled: tab !== "access",
  });
  const operationsAlerts = useResource("/staff/operations-alerts", {
    enabled:
      ["admin", "kitchen", "cashier"].includes(user.role) &&
      user.capabilities?.["alerts.view"] !== false,
    interval: 60000,
  });
  const floorQueue = useResource("/staff/service-requests", {
    interval: 3000,
    enabled:
      ["admin", "waiter"].includes(user.role) &&
      user.capabilities?.["floor.manage"] !== false,
  });
  const live = useLiveUpdates({
    enabled: tab !== "access",
    onAccessChanged: onSignedOut,
  });
  const activeNav = navigation.filter(
    (item) =>
      (["organization", "monitoring", "branches"].includes(item[0])
        ? user.platformAdmin
        : item[3].includes(user.role)) &&
      (!navPermission[item[0]] ||
        navPermission[item[0]].some(
          (key) =>
            (["organization", "monitoring", "branches"].includes(item[0])
              ? user.platformCapabilities
              : user.capabilities)?.[key] !== false,
        )),
  );
  useEffect(() => {
    if (!activeNav.some((item) => item[0] === tab)) setTab("access");
  }, [user, tab]);
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
              aria-label={label}
              className={tab === id ? "active" : ""}
              onClick={() => select(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "operationsAlerts" &&
                operationsAlerts.data?.alerts.filter(
                  (a) => a.active && !a.acknowledged,
                ).length > 0 && (
                  <b>
                    {
                      operationsAlerts.data.alerts.filter(
                        (a) => a.active && !a.acknowledged,
                      ).length
                    }
                  </b>
                )}
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
            <BranchSelector staff />
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
              <Eyebrow>ANGAR KITCHEN · {user.branchId || "main"}</Eyebrow>
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
            className={"live-status" + (live !== "connected" ? " offline" : "")}
            role="status"
          >
            <span />
            {live === "connected"
              ? "Connected · instant updates with queue polling backup"
              : live === "paused"
                ? "Live connection paused while updating your access"
                : live === "offline"
                  ? "Offline · reconnect to continue"
                  : "Reconnecting live updates · queue polling remains available"}
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
          {tab === "fulfillment" && <FulfillmentDesk role={user.role} />}
          {tab === "tables" && <TablesPanel {...common} />}
          {tab === "billing" && <BillingPanel {...common} />}
          {tab === "cash" && <CashDrawerPanel user={user} />}
          {tab === "audit" && <AuditDashboard />}
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
          {tab === "refunds" && <RefundsPanel {...common} />}
          {tab === "team" && <StaffAccounts user={user} />}
          {tab === "inventory" && <InventoryPanel {...common} />}
          <Suspense fallback={<Loading />}>
            {tab === "organization" && <OrganizationDashboard />}
            {tab === "stockTransfers" && <StockTransfersPanel user={user} />}
            {tab === "monitoring" && <MonitoringPanel user={user} />}
            {tab === "branches" && <BranchManagement />}
            {tab === "eventConfig" && <EventConfiguration />}
            {tab === "courier" && <CourierPanel user={user} />}
            {tab === "stocktakes" && <StocktakesPanel user={user} />}
            {tab === "supplierReturns" && <SupplierReturnsPanel user={user} />}
            {tab === "finance" && <FinancePanel user={user} />}
            {tab === "printing" && <PrintingPanel user={user} />}
            {tab === "operationsAlerts" && <OperationsAlerts user={user} />}
          </Suspense>
          {tab === "batches" && <InventoryBatchesPanel user={user} />}
          {tab === "purchasing" && <PurchasingPanel user={user} />}
          {tab === "invoices" && <InvoiceSettings />}
          {tab === "backups" && <BackupsPanel />}
          {tab === "notifications" && <NotificationLogs />}
          {tab === "access" && (
            <>
              <StaffPassword onSignedOut={onSignedOut} />
              <MfaPanel onIdentityUpdated={onIdentityUpdated} />
            </>
          )}
          {tab === "settings" && <SettingsPanel {...common} />}
        </main>
      </div>
    </div>
  );
}
