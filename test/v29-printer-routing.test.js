import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { fixture, post, ok, error, password, key } from "./support.js";
import { queueKitchenTicket, runPrintJobs } from "../server/printing.js";
import { transaction } from "../server/money.js";
const printer = { host: "default.test", port: 9100, columns: 42, cut: false };
const extra = [
  {
    id: "grill",
    name: "Grill printer",
    host: "grill.test",
    port: 9100,
    columns: 42,
    cut: false,
  },
  {
    id: "drinks",
    name: "Drinks printer",
    host: "drinks.test",
    port: 9100,
    columns: 42,
    cut: false,
  },
];
const stations = [
  {
    id: "rice",
    name: "Rice station",
    printerId: "default",
    categories: ["mains"],
    dishIds: [],
  },
  {
    id: "grill",
    name: "Grill station",
    printerId: "grill",
    categories: ["grill"],
    dishIds: [],
  },
  {
    id: "drinks",
    name: "Drinks station",
    printerId: "drinks",
    categories: ["drinks"],
    dishIds: [],
  },
];
async function configure(f, rows = stations, version = 0) {
  return f.staff.admin("/api/staff/printing/routing", {
    method: "PUT",
    data: {
      enabled: true,
      stations: rows,
      expectedRevision: version,
      currentPassword: password,
      reason: "Reviewed station and printer routing",
    },
  });
}
async function sample(f) {
  const dishes = await f.store.dishes
      .find({ category: { $in: ["mains", "grill", "drinks"] } })
      .toArray(),
    items = ["mains", "grill", "drinks"].map((category) => {
      const dish = dishes.find((row) => row.category === category);
      return { dishId: dish._id, name: dish.name, quantity: 1 };
    });
  return {
    _id: new ObjectId(),
    code: "KOT-STATIONS",
    revision: 0,
    tableNumber: "T01",
    items,
    note: "",
  };
}
test("station routing creates item-specific kitchen tickets and sends each to its approved printer destination", async (t) => {
  const sent = [],
    f = await fixture(t, {
      kitchenPrinter: printer,
      kitchenPrinters: extra,
      printerTransport: async (bytes, context) =>
        sent.push({
          text: bytes.toString("ascii"),
          printerId: context?.printerId || "default",
        }),
    });
  ok(await configure(f));
  ok(
    await post(f.staff.admin, "/api/staff/printing/settings", {
      autoEnabled: true,
      currentPassword: password,
    }),
  );
  const order = await sample(f);
  await transaction(f.store, (session) =>
    queueKitchenTicket(f.store, order, "new", session, "admin"),
  );
  const jobs = await f.store.printJobs.find({}).toArray();
  assert.equal(jobs.length, 3);
  for (const job of jobs) {
    assert.equal(job.lines.filter((line) => /^1 x /.test(line)).length, 1);
    assert.ok(job.stationId);
    assert.equal(job.status, "queued");
  }
  for (let i = 0; i < 3; i++) await runPrintJobs(f.store, f.config);
  assert.deepEqual(sent.map((row) => row.printerId).sort(), [
    "default",
    "drinks",
    "grill",
  ]);
  assert.equal(await f.store.printJobs.countDocuments({ status: "sent" }), 3);
  await transaction(f.store, (session) =>
    queueKitchenTicket(f.store, order, "new", session, "admin"),
  );
  assert.equal(await f.store.printJobs.countDocuments({}), 3);
});
test("order amendments keep their routing snapshot and send an explicit stop ticket to a station losing every item", async (t) => {
  const f = await fixture(t, {
    kitchenPrinter: printer,
    kitchenPrinters: extra,
  });
  ok(await configure(f));
  const order = await sample(f);
  await transaction(f.store, (session) =>
    queueKitchenTicket(f.store, order, "new", session, "admin"),
  );
  ok(
    await configure(
      f,
      [
        {
          id: "other",
          name: "New general setup",
          printerId: "default",
          categories: ["mains", "grill", "drinks"],
          dishIds: [],
        },
      ],
      1,
    ),
  );
  const changed = {
    ...order,
    revision: 1,
    items: order.items.filter((_, index) => index !== 1),
  };
  await transaction(f.store, (session) =>
    queueKitchenTicket(f.store, changed, "changed", session, "admin"),
  );
  const current = await f.store.printJobs.find({ sourceRevision: 1 }).toArray();
  assert.equal(current.length, 3);
  const removed = current.find((row) => row.stationId === "grill");
  assert.equal(removed.printerId, "grill");
  assert.ok(removed.lines.some((line) => line.includes("NO ITEMS REMAIN")));
  assert.equal(
    await f.store.printJobs.countDocuments({ status: "superseded" }),
    3,
  );
  assert.equal(
    current.some((row) => row.stationId === "other"),
    false,
  );
});
test("destination changes cannot silently redirect queued station tickets and duplicate routing rules are rejected", async (t) => {
  const sent = [],
    f = await fixture(t, {
      kitchenPrinter: printer,
      kitchenPrinters: structuredClone(extra),
      printerTransport: async (bytes, context) =>
        sent.push(context?.printerId || "default"),
    });
  error(
    await configure(f, [
      ...stations,
      {
        id: "duplicate",
        name: "Duplicate mains",
        printerId: "default",
        categories: ["mains"],
        dishIds: [],
      },
    ]),
    400,
    "STATION_DUPLICATE",
  );
  ok(await configure(f));
  ok(
    await post(f.staff.admin, "/api/staff/printing/settings", {
      autoEnabled: true,
      currentPassword: password,
    }),
  );
  await transaction(f.store, (session) =>
    queueKitchenTicket(
      f.store,
      {
        _id: new ObjectId(),
        code: "GRILL-ONLY",
        revision: 0,
        items: [{ dishId: "test-grill", name: "Grill food", quantity: 1 }],
        note: "",
      },
      "new",
      session,
      "admin",
    ),
  );
  // Override the unknown sample dish so this test addresses an actual grill route.
  await f.store.printJobs.deleteMany({});
  const order = await sample(f);
  order.items = [order.items[1]];
  await transaction(f.store, (session) =>
    queueKitchenTicket(f.store, order, "new", session, "admin"),
  );
  f.config.kitchenPrinters[0].host = "replacement.test";
  await runPrintJobs(f.store, f.config);
  assert.equal(sent.length, 0);
  const job = await f.store.printJobs.findOne({ sourceId: order._id });
  assert.equal(job.status, "destination_changed");
  ok(
    await post(
      f.staff.kitchen,
      "/api/staff/printing/jobs/" + job._id + "/send",
      { reason: "Operator verified replacement grill printer" },
    ),
  );
  await runPrintJobs(f.store, f.config);
  assert.deepEqual(sent, ["grill"]);
  error(await f.staff.kitchen("/api/staff/printing/routing"), 403);
});
