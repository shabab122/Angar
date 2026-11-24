import { rateLimit } from "express-rate-limit";
import { getGuest, hash, sessionToken } from "./security.js";
import { customerIds } from "./shared-customers.js";
const topics = {
  orders: "orders",
  fulfillments: "orders",
  reservations: "reservations",
  waitlist: "waitlist",
  bills: "billing",
  courierJobs: "orders",
};
export function registerCustomerLive(api, store, config) {
  const subscribers = new Set();
  let watch = null,
    closed = false,
    retry = null,
    watchReady = false;
  const limit = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  async function notify(event) {
    const row = event.fullDocument;
    if (!row) return;
    for (const subscriber of subscribers) {
      let owned = Boolean(
        (row.customerId &&
          subscriber.ids.some((id) => String(id) === String(row.customerId))) ||
        (!row.customerId && row.guestHash === subscriber.guest),
      );
      if (event.ns.coll === "bills") {
        const filter = {
          $or: [
            { customerId: { $in: subscriber.ids } },
            { guestHash: subscriber.guest, customerId: null },
          ],
        };
        owned = Boolean(
          row.fulfillmentId
            ? await store.fulfillments.findOne(
                { _id: row.fulfillmentId, ...filter },
                { projection: { _id: 1 } },
              )
            : row.orderIds?.length &&
                (await store.orders.findOne(
                  { _id: { $in: row.orderIds }, ...filter },
                  { projection: { _id: 1 } },
                )),
        );
      }
      if (event.ns.coll === "courierJobs")
        owned = Boolean(
          await store.fulfillments.findOne(
            {
              _id: row.orderId,
              $or: [
                { customerId: { $in: subscriber.ids } },
                { guestHash: subscriber.guest, customerId: null },
              ],
            },
            { projection: { _id: 1 } },
          ),
        );
      if (owned) subscriber.invalidate(topics[event.ns.coll]);
    }
  }
  const start = () => {
    if (closed || watch || !subscribers.size) return;
    watchReady = false;
    watch = store.db.watch(
      [
        {
          $match: {
            "ns.coll": { $in: Object.keys(topics) },
            operationType: { $in: ["insert", "update", "replace"] },
          },
        },
        {
          $project: {
            operationType: 1,
            ns: 1,
            documentKey: 1,
            "fullDocument._id": 1,
            "fullDocument.customerId": 1,
            "fullDocument.guestHash": 1,
            "fullDocument.orderIds": 1,
            "fullDocument.fulfillmentId": 1,
            "fullDocument.orderId": 1,
          },
        },
      ],
      { fullDocument: "updateLookup", maxAwaitTimeMS: 1000 },
    );
    let pending = Promise.resolve(),
      queued = 0;
    watch.on("change", (event) => {
      if (queued >= 200) {
        for (const subscriber of subscribers) subscriber.refresh();
        return;
      }
      queued++;
      pending = pending
        .then(() => notify(event))
        .catch(() => {
          for (const s of subscribers) s.state("fallback");
        })
        .finally(() => {
          queued--;
        });
    });
    watch.on("error", () => {
      const old = watch;
      watch = null;
      watchReady = false;
      void old?.close().catch(() => {});
      for (const s of subscribers) s.state("fallback");
      clearTimeout(retry);
      retry = setTimeout(start, 5000);
      retry.unref();
    });
    let ready = false;
    watch.on("resumeTokenChanged", () => {
      if (!ready) {
        ready = true;
        watchReady = true;
        for (const s of subscribers) {
          s.state("connected");
          s.refresh();
        }
      }
    });
  };
  api.get(
    "/customer/live",
    (req, res, next) => {
      // Navigation can close the socket while customer authentication is awaited.
      // Do not pass an already-closed connection to the IP-based limiter.
      if (req.socket.destroyed || res.destroyed) return res.end();
      return limit(req, res, next);
    },
    (req, res) => {
      if (req.socket.destroyed || res.destroyed) return res.end();
      if (subscribers.size >= 100)
        return res.status(503).json({
          error: {
            code: "LIVE_LIMIT",
            message:
              "Live updates are busy. Automatic refresh remains available.",
          },
        });
      const guest = getGuest(req, res, config),
        token = req.cookies.angar_customer || null,
        customer = req.customer,
        ids = customerIds(customer),
        version = customer?.authVersion || 0;
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      res.write("retry: 2000\n\n");
      let active = true,
        pending = null,
        checking = false;
      const dirty = new Set(),
        send = (event, data) => {
          if (active && !res.writableEnded) {
            if (res.writableLength > 32768) return res.end();
            res.write(
              "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n",
            );
          }
        };
      const subscriber = {
        guest,
        ids,
        invalidate: (topic) => {
          dirty.add(topic);
          if (!pending) {
            pending = setTimeout(() => {
              pending = null;
              send("refresh", { topics: [...dirty] });
              dirty.clear();
            }, 60);
            pending.unref();
          }
        },
        state: (status) => send("state", { state: status }),
        refresh: () =>
          send("ready", {
            resync: true,
            connected: watchReady,
            branchId: store.branchId || "main",
          }),
        end: () => res.end(),
      };
      const timer = setInterval(async () => {
        if (checking || !active) return;
        checking = true;
        try {
          if (customer) {
            const session = sessionToken(token)
                ? await store.customerSessions.findOne({
                    _id: hash(token),
                    customerId: customer._id,
                    expiresAt: { $gt: new Date() },
                  })
                : null,
              current = session
                ? await store.customers.findOne({
                    _id: customer._id,
                    active: true,
                  })
                : null;
            if (!current || (current.authVersion || 0) !== version) {
              send("access", { changed: true });
              res.end();
              return;
            }
          }
          res.write(": heartbeat\n\n");
        } catch {
          subscriber.state("fallback");
        } finally {
          checking = false;
        }
      }, 5000);
      timer.unref();
      res.on("close", () => {
        active = false;
        clearTimeout(pending);
        clearInterval(timer);
        subscribers.delete(subscriber);
        if (!subscribers.size) {
          clearTimeout(retry);
          retry = null;
          const old = watch;
          watch = null;
          watchReady = false;
          void old?.close().catch(() => {});
        }
      });
      subscribers.add(subscriber);
      start();
      if (watchReady) subscriber.state("connected");
      subscriber.refresh();
    },
  );
  return async () => {
    closed = true;
    clearTimeout(retry);
    for (const s of subscribers) s.end();
    await watch?.close().catch(() => {});
    watch = null;
  };
}
