import { capabilities } from "./access.js";
import { hash, sessionToken, STAFF_COOKIE } from "./security.js";
// Only invalidation labels leave MongoDB; browsers fetch their authorized views.
const topics = {
  stockTransfers: "transfers",
  stockTransferEntries: "transfers",
  monitoringIncidents: "monitoring",
  courierJobs: "courier",
  orders: "orders",
  fulfillments: "fulfillment",
  bills: "billing",
  gatewayTransactions: "billing",
  refunds: "refunds",
  tables: "tables",
  serviceRequests: "requests",
  dishes: "menu",
  reviews: "reviews",
  events: "events",
  reservations: "reservations",
  waitlist: "reservations",
  ingredients: "inventory",
  ingredientBatches: "inventory",
  stocktakes: "inventory",
  stockMovements: "inventory",
  purchases: "purchasing",
  suppliers: "purchasing",
  supplierReturns: "purchasing",
  expenses: "finance",
  printJobs: "printing",
  staffAlerts: "alerts",
  auditLog: "audit",
  settings: "settings",
  cashShifts: "cash",
  cashMovements: "cash",
};
const access = {
  transfers: ["transfers.view"],
  monitoring: ["monitoring.view"],
  courier: ["courier.manage", "orders.view"],
  orders: ["orders.view"],
  fulfillment: ["orders.view"],
  billing: ["billing.view"],
  refunds: ["refund.request"],
  tables: ["tables.view"],
  requests: ["floor.manage"],
  menu: ["menu.manage", "availability.manage"],
  reviews: ["reviews.manage"],
  events: ["events.view"],
  reservations: ["reservations.manage"],
  inventory: ["inventory.view"],
  purchasing: ["purchase.view"],
  finance: ["finance.view"],
  printing: ["printing.kitchen", "printing.receipt"],
  alerts: ["alerts.view"],
  audit: ["audit.view"],
  settings: ["settings.manage", "events.configure"],
  cash: ["cash.manage"],
};
export function registerLive(api, store) {
  const subscribers = new Set();
  let watch = null,
    closed = false,
    retry = null;
  const start = () => {
    if (watch || closed || !subscribers.size) return;
    watch = store.db.watch(
      [
        {
          $match: {
            "ns.coll": { $in: Object.keys(topics) },
            operationType: { $in: ["insert", "update", "replace", "delete"] },
          },
        },
      ],
      { maxAwaitTimeMS: 1000 },
    );
    let announced = false;
    watch.on("resumeTokenChanged", () => {
      if (announced || !subscribers.size) return;
      announced = true;
      for (const subscriber of subscribers) {
        subscriber.state("connected");
        subscriber.resync();
      }
    });
    watch.on("change", (event) => {
      const topic = topics[event.ns?.coll];
      if (topic)
        for (const subscriber of subscribers) subscriber.invalidate(topic);
    });
    watch.on("error", () => {
      const old = watch;
      watch = null;
      void old?.close().catch(() => {});
      for (const subscriber of subscribers) subscriber.state("fallback");
      clearTimeout(retry);
      retry = setTimeout(() => {
        retry = null;
        start();
      }, 5000);
      retry.unref();
    });
  };
  api.get("/live", async (req, res) => {
    if (subscribers.size >= 100)
      return res.status(503).json({
        error: {
          code: "LIVE_LIMIT",
          message:
            "Live connections are busy. Queue polling remains available.",
        },
      });
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write("retry: 2000\n\n");
    let active = true,
      dirty = new Set(),
      pending = null,
      checking = false;
    const caps = capabilities(req.staff),
      initialVersion = req.staff.authVersion || 0;
    const send = (event, data) => {
      if (active && !res.writableEnded) {
        if (res.writableLength > 64 * 1024) {
          res.end();
          return;
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    const subscriber = {
      invalidate(topic) {
        if (!(access[topic] || []).some((key) => caps[key])) return;
        dirty.add(topic);
        if (!pending) {
          pending = setTimeout(() => {
            pending = null;
            send("refresh", { topics: [...dirty] });
            dirty.clear();
          }, 75);
          pending.unref();
        }
      },
      state: (state) => send("state", { state }),
      resync: () =>
        send("ready", { resync: true, branchId: store.branchId || "main" }),
    };
    const cleanup = () => {
      active = false;
      clearInterval(timer);
      clearTimeout(pending);
      subscribers.delete(subscriber);
      if (!subscribers.size) {
        clearTimeout(retry);
        retry = null;
        const old = watch;
        watch = null;
        void old?.close().catch(() => {});
      }
    };
    const timer = setInterval(async () => {
      if (checking || !active) return;
      checking = true;
      try {
        const token = req.cookies[STAFF_COOKIE],
          session = sessionToken(token)
            ? await store.sessions.findOne({
                _id: hash(token),
                expiresAt: { $gt: new Date() },
              })
            : null;
        const user = session
          ? await store.staff.findOne({ _id: session.staffId, active: true })
          : null;
        if (!user || (user.authVersion || 0) !== initialVersion) {
          send("access", { changed: true });
          res.end();
          return;
        }
        res.write(": heartbeat\n\n");
      } catch {
        send("state", { state: "fallback" });
      } finally {
        checking = false;
      }
    }, 5000);
    timer.unref();
    res.on("close", cleanup);
    subscribers.add(subscriber);
    start();
    send("ready", { resync: true, branchId: store.branchId || "main" });
    subscriber.end = () => res.end();
  });
  return () => {
    closed = true;
    clearTimeout(retry);
    for (const s of subscribers) s.end();
    const old = watch;
    watch = null;
    return old?.close().catch(() => {});
  };
}
