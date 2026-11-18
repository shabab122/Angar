import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { ObjectId } from "mongodb";
import { createApp } from "../server/app.js";
import { connectDatabase } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import {
  passwordHash,
  randomToken,
  STAFF_ROLES,
  tableVisitKey,
} from "../server/security.js";
import { menu } from "../scripts/menu-data.js";

const key = () => randomBytes(16).toString("hex");
const origin = "http://angar.test";
const password = "Operations-test-only-123";
function browser(url) {
  const cookies = new Map();
  return async (path, { method = "GET", data, requestKey } = {}) => {
    const response = await fetch(url + path, {
      method,
      redirect: "manual",
      headers: {
        Cookie: [...cookies]
          .map(([name, value]) => name + "=" + value)
          .join("; "),
        ...(data === undefined
          ? {}
          : { "Content-Type": "application/json", Origin: origin }),
        ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0];
      const at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      data:
        response.headers.get("content-type")?.includes("json") && text
          ? JSON.parse(text)
          : null,
    };
  };
}
const post = (client, path, data = {}, requestKey) =>
  client(path, { method: "POST", data, requestKey });
const patch = (client, path, data) => client(path, { method: "PATCH", data });
const ok = (response, status = 200) => {
  assert.equal(response.status, status, response.text);
  return response.data;
};
const error = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.equal(response.data.error.code, code);
};

test("v2.1 floor service, availability, settled sales and approved pre-cooking changes", async (t) => {
  const config = {
    ...loadConfig(),
    origin,
    secureCookies: false,
    proxyHops: 0,
    mongoDatabase: "angar_operations_test_" + key(),
  };
  const store = await connectDatabase(config);
  const server = createApp(store, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    try {
      await new Promise((resolve) => server.close(resolve));
      await store.db.dropDatabase();
    } finally {
      await store.client.close();
    }
  });
  const url = "http://127.0.0.1:" + server.address().port;
  await store.dishes.insertMany(menu.map((dish) => ({ ...dish })));
  const hash = await passwordHash(password);
  await store.staff.insertMany(
    STAFF_ROLES.map((role) => ({
      username: role,
      role,
      passwordHash: hash,
      active: true,
    })),
  );
  const staff = {};
  for (const role of STAFF_ROLES) {
    staff[role] = browser(url);
    ok(
      await post(staff[role], "/api/staff/login", { username: role, password }),
    );
  }
  const guest = browser(url),
    second = browser(url),
    outsider = browser(url);
  const table = {
    _id: new ObjectId(),
    number: "T01",
    qrToken: randomToken(24),
    activeVisitId: new ObjectId(),
    openedAt: new Date(),
    revision: 0,
  };
  await store.tables.insertOne(table);
  await guest("/t/" + table.qrToken);
  await second("/t/" + table.qrToken);
  const dish = menu.find((row) => row._id === "mutton-kacchi");
  const place = async (client = guest) =>
    ok(
      await post(
        client,
        "/api/orders",
        {
          visitKey: tableVisitKey(table.activeVisitId),
          items: [{ dishId: dish._id, quantity: 2, expectedPrice: dish.price }],
          note: "Original note",
        },
        key(),
      ),
      201,
    ).order;

  await t.test(
    "floor calls deduplicate across phones, show acknowledgements, and respect visits and roles",
    async () => {
      error(await outsider("/api/service-requests"), 409, "TABLE_REQUIRED");
      const calls = await Promise.all([
        post(guest, "/api/service-requests", { type: "waiter" }),
        post(second, "/api/service-requests", { type: "waiter" }),
      ]);
      calls.forEach((response) => ok(response, 201));
      const id = calls[0].data.request.id;
      assert.equal(calls[1].data.request.id, id);
      assert.equal(
        await store.serviceRequests.countDocuments({ status: "open" }),
        1,
      );
      error(
        await staff.kitchen("/api/staff/service-requests"),
        403,
        "FORBIDDEN",
      );
      error(
        await post(
          staff.cashier,
          "/api/staff/service-requests/" + id + "/acknowledge",
        ),
        403,
        "FORBIDDEN",
      );
      ok(
        await post(
          staff.waiter,
          "/api/staff/service-requests/" + id + "/acknowledge",
        ),
        204,
      );
      ok(
        await post(
          staff.admin,
          "/api/staff/service-requests/" + id + "/acknowledge",
        ),
        204,
      );
      const status = ok(await second("/api/service-requests")).requests[0];
      assert.equal(status.status, "acknowledged");
      assert.equal(status.acknowledgedBy, undefined);
      const duplicate = ok(
        await post(guest, "/api/service-requests", { type: "waiter" }),
        201,
      );
      assert.equal(duplicate.request.id, id);
      ok(
        await post(
          staff.waiter,
          "/api/staff/service-requests/" + id + "/resolve",
        ),
        204,
      );
      assert.equal(
        ok(await guest("/api/service-requests")).requests[0].status,
        "resolved",
      );
      ok(
        await post(
          staff.waiter,
          "/api/staff/service-requests/" + id + "/resolve",
        ),
        204,
      );
      assert.notEqual(
        ok(await post(guest, "/api/service-requests", { type: "waiter" }), 201)
          .request.id,
        id,
      );
      await store.tables.updateOne(
        { _id: table._id },
        { $set: { activeVisitId: new ObjectId() } },
      );
      error(await guest("/api/service-requests"), 409, "TABLE_CLOSED");
      await store.tables.updateOne(
        { _id: table._id },
        { $set: { activeVisitId: table.activeVisitId } },
      );
    },
  );

  await t.test(
    "kitchen can toggle availability, stale updates fail, and checkout cannot use a sold-out dish",
    async () => {
      const endpoint = "/api/staff/menu/" + dish._id + "/availability";
      error(
        await patch(staff.waiter, endpoint, {
          available: false,
          expectedAvailable: true,
        }),
        403,
        "FORBIDDEN",
      );
      error(
        await patch(staff.kitchen, "/api/staff/menu/" + dish._id, {
          available: false,
          price: 1,
        }),
        403,
        "FORBIDDEN",
      );
      ok(
        await patch(staff.kitchen, endpoint, {
          available: false,
          expectedAvailable: true,
        }),
      );
      assert.equal(
        ok(await guest("/api/menu")).dishes.find((row) => row._id === dish._id)
          .available,
        false,
      );
      error(
        await patch(staff.admin, endpoint, {
          available: false,
          expectedAvailable: true,
        }),
        409,
        "MENU_UPDATED",
      );
      error(
        await post(
          guest,
          "/api/orders",
          {
            visitKey: tableVisitKey(table.activeVisitId),
            items: [
              { dishId: dish._id, quantity: 1, expectedPrice: dish.price },
            ],
            note: "",
          },
          key(),
        ),
        409,
        "ITEM_UNAVAILABLE",
      );
      assert.equal(await store.orders.countDocuments({}), 0);
      ok(
        await patch(staff.kitchen, endpoint, {
          available: true,
          expectedAvailable: false,
        }),
      );
      assert.equal(
        await store.audit.countDocuments({ type: "dish.availability" }),
        2,
      );
    },
  );

  await t.test(
    "guest changes are owned, versioned, deduplicated, reviewed and applied exactly once",
    async () => {
      let order = await place();
      const endpoint = "/api/orders/" + order.id + "/changes";
      const change = {
        type: "edit",
        expectedRevision: order.revision,
        reason: "Please add one more portion",
        note: "Less chilli",
        lines: [{ index: 0, quantity: 3 }],
      };
      error(await post(second, endpoint, change, key()), 404, "NOT_FOUND");
      error(
        await post(guest, endpoint, { ...change, expectedRevision: 99 }, key()),
        409,
        "ORDER_UPDATED",
      );
      const requestId = key();
      order = ok(await post(guest, endpoint, change, requestId), 201).order;
      assert.equal(order.total, dish.price * 2);
      assert.equal(order.items[0].quantity, 2);
      assert.equal(order.changeRequest.fingerprint, undefined);
      assert.equal(
        ok(await post(guest, endpoint, change, requestId)).order.revision,
        order.revision,
      );
      error(
        await post(
          guest,
          endpoint,
          { ...change, reason: "Different content" },
          requestId,
        ),
        409,
        "REQUEST_REUSED",
      );
      error(
        await post(staff.admin, "/api/staff/orders/" + order.id + "/action", {
          action: "send",
        }),
        409,
        "CHANGE_PENDING",
      );
      const decision =
        "/api/staff/orders/" + order.id + "/changes/" + requestId + "/decision";
      error(
        await post(staff.kitchen, decision, {
          decision: "approve",
          reason: "Approved by kitchen",
        }),
        403,
        "FORBIDDEN",
      );
      order = ok(
        await post(staff.admin, decision, {
          decision: "reject",
          reason: "Please confirm the quantity again",
        }),
      ).order;
      assert.equal(order.changeRequest.status, "rejected");
      assert.equal(order.total, dish.price * 2);
      order = ok(
        await post(staff.admin, "/api/staff/orders/" + order.id + "/action", {
          action: "send",
        }),
      ).order;
      const retryId = key();
      order = ok(
        await post(
          guest,
          endpoint,
          { ...change, expectedRevision: order.revision },
          retryId,
        ),
        201,
      ).order;
      error(
        await post(staff.kitchen, "/api/staff/orders/" + order.id + "/action", {
          action: "start",
        }),
        409,
        "CHANGE_PENDING",
      );
      ok(
        await patch(
          staff.kitchen,
          "/api/staff/menu/" + dish._id + "/availability",
          { available: false, expectedAvailable: true },
        ),
      );
      const retryDecision =
        "/api/staff/orders/" + order.id + "/changes/" + retryId + "/decision";
      error(
        await post(staff.admin, retryDecision, {
          decision: "approve",
          reason: "Quantity confirmed",
        }),
        409,
        "ITEM_UNAVAILABLE",
      );
      assert.equal(
        (await store.orders.findOne({ _id: new ObjectId(order.id) })).total,
        dish.price * 2,
      );
      ok(
        await patch(
          staff.kitchen,
          "/api/staff/menu/" + dish._id + "/availability",
          { available: true, expectedAvailable: false },
        ),
      );
      // A later menu price does not silently reprice the guest's original order.
      ok(
        await patch(staff.admin, "/api/staff/menu/" + dish._id, {
          price: dish.price + 20,
          available: true,
        }),
      );
      const results = await Promise.all([
        post(staff.admin, retryDecision, {
          decision: "approve",
          reason: "Quantity confirmed",
        }),
        post(staff.admin, retryDecision, {
          decision: "approve",
          reason: "Quantity confirmed",
        }),
      ]);
      results.forEach((response) => ok(response));
      order = results[0].data.order;
      assert.equal(order.total, dish.price * 3);
      assert.equal(order.items[0].quantity, 3);
      assert.equal(order.note, "Less chilli");
      assert.equal(
        await store.audit.countDocuments({
          type: "order.change_approved",
          requestId: retryId,
        }),
        1,
      );
      const audit = await store.audit.findOne({
        type: "order.change_approved",
        requestId: retryId,
      });
      assert.equal(audit.before.total, dish.price * 2);
      assert.equal(audit.after.total, dish.price * 3);
      await patch(staff.admin, "/api/staff/menu/" + dish._id, {
        price: dish.price,
        available: true,
      });
      order = ok(
        await post(staff.kitchen, "/api/staff/orders/" + order.id + "/action", {
          action: "start",
        }),
      ).order;
      error(
        await post(
          guest,
          endpoint,
          {
            type: "cancel",
            expectedRevision: order.revision,
            reason: "Too late to cancel",
          },
          key(),
        ),
        409,
        "ORDER_LOCKED",
      );
      error(
        await post(staff.admin, "/api/staff/orders/" + order.id + "/cancel", {
          reason: "Late cancellation",
        }),
        409,
        "ORDER_LOCKED",
      );
    },
  );

  await t.test(
    "cancellation requires approval and a start/change race cannot both succeed",
    async () => {
      let order = await place();
      const requestId = key();
      order = ok(
        await post(
          guest,
          "/api/orders/" + order.id + "/changes",
          {
            type: "cancel",
            expectedRevision: order.revision,
            reason: "Ordered by mistake",
          },
          requestId,
        ),
        201,
      ).order;
      assert.equal(order.status, "placed");
      order = ok(
        await post(
          staff.admin,
          "/api/staff/orders/" +
            order.id +
            "/changes/" +
            requestId +
            "/decision",
          { decision: "approve", reason: "Guest confirmed the cancellation" },
        ),
      ).order;
      assert.equal(order.status, "cancelled");
      assert.equal(
        (await store.orders.findOne({ _id: new ObjectId(order.id) }))
          .changeHistory[0].status,
        "approved",
      );
      let race = await place();
      race = ok(
        await post(staff.admin, "/api/staff/orders/" + race.id + "/action", {
          action: "send",
        }),
      ).order;
      const [request, start] = await Promise.all([
        post(
          guest,
          "/api/orders/" + race.id + "/changes",
          {
            type: "cancel",
            expectedRevision: race.revision,
            reason: "Please cancel this ticket",
          },
          key(),
        ),
        post(staff.kitchen, "/api/staff/orders/" + race.id + "/action", {
          action: "start",
        }),
      ]);
      assert.equal(
        [request, start].filter((response) => response.status < 300).length,
        1,
      );
      assert.equal(
        [request, start].find((response) => response.status >= 300).status,
        409,
      );
    },
  );

  await t.test(
    "reports use paid-at Dhaka boundaries, exact totals, zero-filled periods and protected CSV exports",
    async () => {
      const bill = (
        paidAt,
        totalMinor,
        subtotalMinor,
        chargeMinor,
        method,
        quantity,
        status = "paid",
      ) => ({
        visitId: new ObjectId(),
        receiptNo: "TEST-" + key(),
        status,
        paidAt: new Date(paidAt),
        totalMinor,
        subtotalMinor,
        chargeMinor,
        payment: { method },
        items: [
          {
            name: '=HYPERLINK("example")',
            quantity,
            subtotal: subtotalMinor / 100,
          },
        ],
      });
      await store.bills.insertMany([
        bill("2026-11-17T17:59:59Z", 90000, 90000, 0, "cash", 9),
        bill("2026-11-17T18:00:00Z", 11400, 10000, 1400, "cash", 1),
        bill("2026-11-18T17:59:59Z", 21000, 20000, 1000, "bkash", 2),
        bill("2026-11-18T18:00:00Z", 80000, 80000, 0, "card", 8),
        bill("2026-11-18T10:00:00Z", 50000, 50000, 0, "cash", 5, "finalized"),
      ]);
      const path = "/api/staff/reports/sales?start=2026-11-18&end=2026-11-18";
      error(await outsider(path), 401, "STAFF_REQUIRED");
      error(await staff.kitchen(path), 403, "FORBIDDEN");
      error(await staff.waiter(path), 403, "FORBIDDEN");
      const report = ok(await staff.cashier(path));
      assert.deepEqual(report.summary, {
        revenueMinor: 32400,
        subtotalMinor: 30000,
        serviceChargeMinor: 2400,
        bills: 2,
        averageBillMinor: 16200,
      });
      assert.deepEqual(report.series, [
        { period: "2026-11-18", revenueMinor: 32400, bills: 2 },
      ]);
      assert.equal(report.popular[0].quantity, 3);
      assert.equal(report.popular[0].foodMinor, 30000);
      assert.equal(report.payments.length, 2);
      assert.equal(
        ok(await staff.admin(path + "&group=month")).series[0].period,
        "2026-11",
      );
      const empty = ok(
        await staff.admin(
          "/api/staff/reports/sales?start=2026-11-01&end=2026-11-03",
        ),
      );
      assert.equal(empty.series.length, 3);
      assert.equal(empty.summary.revenueMinor, 0);
      error(
        await staff.admin(
          "/api/staff/reports/sales?start=2026-02-30&end=2026-03-01",
        ),
        400,
        "INVALID_INPUT",
      );
      error(
        await staff.admin(
          "/api/staff/reports/sales?start=2026-11-19&end=2026-11-18",
        ),
        400,
        "INVALID_RANGE",
      );
      error(
        await staff.admin(
          "/api/staff/reports/sales?start=2025-01-01&end=2026-11-18",
        ),
        400,
        "INVALID_RANGE",
      );
      const csvPath =
        "/api/staff/reports/sales.csv?start=2026-11-18&end=2026-11-18&section=items";
      const csv = await staff.admin(csvPath);
      ok(csv);
      assert.match(csv.headers.get("content-type"), /text\/csv/);
      assert.match(csv.headers.get("content-disposition"), /attachment/);
      assert.ok(csv.text.includes("'=HYPERLINK"));
      assert.ok(csv.text.includes('"300.00"'));
      error(await staff.kitchen(csvPath), 403, "FORBIDDEN");
    },
  );
});
