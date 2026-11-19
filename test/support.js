import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
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

export const key = () => randomBytes(16).toString("hex");
export const origin = "http://angar.test";
export const password = "Commerce-test-only-123!";
export function browser(url) {
  const jar = new Map();
  return async (
    path,
    { method = "GET", data, headers: custom = {}, raw } = {},
  ) => {
    const response = await fetch(url + path, {
      method,
      redirect: "manual",
      headers: {
        Cookie: [...jar].map(([name, value]) => name + "=" + value).join("; "),
        ...(data === undefined
          ? {}
          : { "Content-Type": "application/json", Origin: origin }),
        ...custom,
      },
      ...(raw === undefined
        ? data === undefined
          ? {}
          : { body: JSON.stringify(data) }
        : { body: raw }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0],
        index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    return {
      status: response.status,
      text,
      headers: response.headers,
      data:
        response.headers.get("content-type")?.includes("json") && text
          ? JSON.parse(text)
          : null,
    };
  };
}
export const post = (client, path, data = {}, headers = {}) =>
  client(path, { method: "POST", data, headers });
export const patch = (client, path, data) =>
  client(path, { method: "PATCH", data });
export const ok = (response, status = 200) => {
  assert.equal(response.status, status, response.text);
  return response.data;
};
export const error = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  if (code) assert.equal(response.data.error.code, code);
};

export async function fixture(t, overrides = {}) {
  const config = {
    ...loadConfig(),
    origin,
    secureCookies: false,
    proxyHops: 0,
    mongoDatabase: "angar_commerce_test_" + key(),
    ...overrides,
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
  const ph = await passwordHash(password);
  await store.staff.insertMany(
    STAFF_ROLES.map((role) => ({
      username: role,
      role,
      active: true,
      passwordHash: ph,
    })),
  );
  const staff = {};
  for (const role of STAFF_ROLES) {
    staff[role] = browser(url);
    ok(
      await post(staff[role], "/api/staff/login", { username: role, password }),
    );
  }
  const tables = Array.from({ length: 6 }, (_, index) => ({
    _id: new ObjectId(),
    number: "T0" + (index + 1),
    qrToken: randomToken(24),
    activeVisitId: null,
    revision: 0,
    capacity: index ? 2 : 4,
  }));
  await store.tables.insertMany(tables);
  async function account(client, suffix = key()) {
    return ok(
      await post(client, "/api/account/register", {
        name: "Test Member",
        email: suffix + "@example.test",
        phone: "01700000000",
        password,
      }),
      201,
    ).customer;
  }
  async function open(number = "T01") {
    const table = tables.find((table) => table.number === number);
    const visitId = new ObjectId();
    await store.tables.updateOne(
      { _id: table._id },
      {
        $set: {
          activeVisitId: visitId,
          openedAt: new Date(),
          billingState: "open",
          promotion: null,
        },
        $unset: { billId: "", reservationId: "" },
      },
    );
    return { ...table, activeVisitId: visitId };
  }
  async function order(client, table, quantity = 2) {
    await client("/t/" + table.qrToken);
    return ok(
      await post(
        client,
        "/api/orders",
        {
          visitKey: tableVisitKey(table.activeVisitId),
          items: [{ dishId: "mutton-kacchi", quantity, expectedPrice: 420 }],
          note: "",
        },
        { "Idempotency-Key": key() },
      ),
      201,
    ).order;
  }
  async function serve(order) {
    for (const [role, action] of [
      ["admin", "send"],
      ["kitchen", "start"],
      ["kitchen", "ready"],
      ["waiter", "serve"],
    ])
      ok(
        await post(staff[role], "/api/staff/orders/" + order.id + "/action", {
          action,
        }),
      );
  }
  async function finalized(client, number = "T01") {
    const table = await open(number),
      placed = await order(client, table);
    await serve(placed);
    return ok(
      await post(staff.cashier, "/api/staff/billing/" + number + "/finalize"),
    ).bill;
  }
  return {
    store,
    config,
    url,
    staff,
    tables,
    browser: () => browser(url),
    account,
    open,
    order,
    serve,
    finalized,
  };
}
