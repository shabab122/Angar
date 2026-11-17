import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ObjectId } from "mongodb";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { connectDatabase } from "../server/db.js";
import { passwordHash, randomToken, STAFF_ROLES } from "../server/security.js";
import { menu } from "../scripts/menu-data.js";

const origin = "http://angar.test";
const pass = "Isolated-test-only-123";
const key = () => randomBytes(16).toString("hex");

function browser(url) {
  const jar = new Map();
  return async (
    path,
    { method = "GET", data, requestKey, from = origin, image } = {},
  ) => {
    const headers = {
      Cookie: [...jar].map(([name, value]) => name + "=" + value).join("; "),
    };
    if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      headers.Origin = from;
    }
    if (image) {
      headers["Content-Type"] = "image/webp";
      headers.Origin = from;
    }
    if (requestKey) headers["Idempotency-Key"] = requestKey;
    const response = await fetch(url + path, {
      method,
      headers,
      redirect: "manual",
      ...(image
        ? { body: image }
        : data === undefined
          ? {}
          : { body: JSON.stringify(data) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      if (pair.slice(index + 1))
        jar.set(pair.slice(0, index), pair.slice(index + 1));
      else jar.delete(pair.slice(0, index));
    }
    const content = response.headers.get("content-type");
    return {
      response,
      status: response.status,
      data: content?.includes("json") ? await response.json() : null,
    };
  };
}
const post = (client, path, data = {}, requestKey) =>
  client(path, { method: "POST", data, requestKey });
const patch = (client, path, data) => client(path, { method: "PATCH", data });
const code = (response, expectedStatus, expectedCode) => {
  assert.equal(response.status, expectedStatus, JSON.stringify(response.data));
  assert.equal(response.data.error.code, expectedCode);
};

test("MongoDB-backed QR order, staff handoff and moderated dish rating", async (t) => {
  const config = {
    ...loadConfig(),
    mongoDatabase: "angar_test_" + key(),
    origin,
    secureCookies: false,
    proxyHops: 0,
  };
  const store = await connectDatabase(config);
  let server;
  t.after(async () => {
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      // The test only deletes the randomly named database it created.
      await store.db.dropDatabase();
    } finally {
      await store.client.close();
    }
  });

  await store.dishes.insertMany(menu.map((dish) => ({ ...dish })));
  const table = {
    _id: new ObjectId(),
    number: "T01",
    qrToken: randomToken(24),
    activeVisitId: new ObjectId(),
    openedAt: new Date(),
    revision: 0,
  };
  await store.tables.insertOne(table);
  await store.tables.insertOne({
    number: "T02",
    qrToken: randomToken(24),
    activeVisitId: null,
    openedAt: null,
    revision: 0,
  });
  const password = await passwordHash(pass);
  await store.staff.insertMany(
    STAFF_ROLES.map((role) => ({
      username: role,
      role,
      passwordHash: password,
      active: true,
    })),
  );
  server = createApp(store, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port;
  const guest = browser(url);
  const outsider = browser(url);
  const admin = browser(url);
  const kitchen = browser(url);
  const waiter = browser(url);
  const payload = {
    visitKey: "0000000000000000",
    items: [{ dishId: "mutton-kacchi", quantity: 2, expectedPrice: 420 }],
    note: "Less chilli",
  };
  const login = async (client, username) => {
    const result = await post(client, "/api/staff/login", {
      username,
      password: pass,
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.role, username);
  };

  await t.test(
    "a public visitor can browse, but only a valid open table can order",
    async () => {
      assert.equal((await guest("/healthz")).status, 200);
      assert.equal((await guest("/api/menu")).data.dishes.length, 6);
      assert.equal((await guest("/api/context")).data.table, null);
      code(
        await post(guest, "/api/orders", payload, key()),
        409,
        "TABLE_REQUIRED",
      );
      code(
        await guest("/api/orders", {
          method: "POST",
          data: payload,
          requestKey: key(),
          from: "http://other.test",
        }),
        403,
        "ORIGIN",
      );
      code(await guest("/api/staff/orders"), 401, "STAFF_REQUIRED");
      assert.equal(
        (await outsider("/t/" + randomToken(24))).response.headers.get(
          "location",
        ),
        "/menu?scan=invalid",
      );
      const scan = await guest("/t/" + table.qrToken);
      assert.equal(scan.status, 303);
      assert.equal(scan.response.headers.get("location"), "/menu");
      const context = (await guest("/api/context")).data.table;
      assert.equal(context.number, "T01");
      assert.equal(context.active, true);
      assert.match(context.visitKey, /^[0-9a-f]{16}$/);
      payload.visitKey = context.visitKey;
      assert.equal((await guest("/api/orders")).data.orders.length, 0);
    },
  );

  let id;
  let orderKey;
  await t.test(
    "the server checks price and availability and deduplicates concurrent checkout",
    async () => {
      await login(admin, "admin");
      await login(kitchen, "kitchen");
      await login(waiter, "waiter");
      code(
        await patch(kitchen, "/api/staff/menu/mutton-kacchi", {
          price: 1,
          available: true,
        }),
        403,
        "FORBIDDEN",
      );
      assert.equal(
        (
          await patch(admin, "/api/staff/menu/mutton-kacchi", {
            price: 440,
            available: false,
          })
        ).status,
        200,
      );
      code(
        await post(guest, "/api/orders", payload, key()),
        409,
        "ITEM_UNAVAILABLE",
      );
      assert.equal(
        (
          await patch(admin, "/api/staff/menu/mutton-kacchi", {
            price: 440,
            available: true,
          })
        ).status,
        200,
      );
      code(
        await post(guest, "/api/orders", payload, key()),
        409,
        "PRICE_CHANGED",
      );
      payload.items[0].expectedPrice = 440;
      orderKey = key();
      const duplicate = await Promise.all([
        post(guest, "/api/orders", payload, orderKey),
        post(guest, "/api/orders", payload, orderKey),
      ]);
      assert.deepEqual(
        duplicate.map((result) => result.status).sort(),
        [200, 201],
      );
      id = duplicate[0].data.order.id;
      assert.equal(duplicate[1].data.order.id, id);
      assert.equal(duplicate[0].data.order.total, 880);
      assert.equal(duplicate[0].data.order.status, "placed");
      assert.equal(await store.orders.countDocuments({}), 1);
      code(
        await post(
          guest,
          "/api/orders",
          { ...payload, note: "Changed" },
          orderKey,
        ),
        409,
        "REQUEST_REUSED",
      );
      assert.equal((await outsider("/api/orders")).data.orders.length, 0);
    },
  );

  const action = (client, step) =>
    post(client, "/api/staff/orders/" + id + "/action", { action: step });
  const rate = (client, dishId = "mutton-kacchi") =>
    post(client, "/api/orders/" + id + "/reviews", {
      dishId,
      rating: 5,
      comment: "<Great> with less chilli",
    });

  await t.test(
    "each station sees only its queue and can perform only its next action",
    async () => {
      assert.equal((await admin("/api/staff/orders")).data.orders[0].id, id);
      assert.deepEqual((await kitchen("/api/staff/orders")).data.orders, []);
      code(await post(admin, "/api/staff/tables/T01/close"), 409, "TABLE_BUSY");
      code(await rate(guest), 409, "NOT_SERVED");
      code(await action(kitchen, "send"), 403, "FORBIDDEN");
      code(await action(kitchen, "start"), 409, "ORDER_UPDATED");
      assert.equal((await action(admin, "send")).data.order.status, "queued");
      code(await action(admin, "send"), 409, "ORDER_UPDATED");
      assert.equal((await kitchen("/api/staff/orders")).data.orders[0].id, id);
      assert.equal(
        (await action(kitchen, "start")).data.order.status,
        "preparing",
      );
      code(await action(waiter, "serve"), 409, "ORDER_UPDATED");
      assert.equal((await action(kitchen, "ready")).data.order.status, "ready");
      assert.equal((await waiter("/api/staff/orders")).data.orders[0].id, id);
      assert.equal((await action(waiter, "serve")).data.order.status, "served");
      const saved = (await guest("/api/orders")).data.orders[0];
      assert.deepEqual(
        saved.history.map((step) => step.status),
        ["placed", "queued", "preparing", "ready", "served"],
      );
      assert.equal(saved.history[1].by, undefined);
      assert.equal(saved.total, 880);
      code(
        await post(admin, "/api/staff/tables/T01/close"),
        409,
        "BILL_REQUIRED",
      );
      const bill = await post(admin, "/api/staff/billing/T01/finalize");
      assert.equal(bill.status, 200);
      assert.equal(bill.data.bill.total, 880);
      code(
        await post(guest, "/api/orders", payload, key()),
        409,
        "BILL_FINALIZED",
      );
      const paid = await post(
        admin,
        "/api/staff/bills/" + bill.data.bill.id + "/pay",
        { method: "cash", reference: "", verified: true },
      );
      assert.equal(paid.data.bill.status, "paid");
      assert.equal(
        (await post(admin, "/api/staff/tables/T01/open")).status,
        200,
      );
      code(
        await post(guest, "/api/orders", payload, key()),
        409,
        "TABLE_CLOSED",
      );
      assert.equal(
        (await post(guest, "/api/orders", payload, orderKey)).status,
        200,
      );
      await guest("/t/" + table.qrToken);
      code(
        await post(guest, "/api/orders", payload, orderKey),
        409,
        "REQUEST_REUSED",
      );
      code(
        await post(guest, "/api/orders", payload, key()),
        409,
        "TABLE_CHANGED",
      );
      payload.visitKey = (await guest("/api/context")).data.table.visitKey;
    },
  );

  await t.test(
    "only the ordering browser can rate a served dish, once, before moderation",
    async () => {
      code(await rate(outsider), 404, "NOT_FOUND");
      code(await rate(guest, "beef-seekh"), 404, "NOT_FOUND");
      assert.equal((await rate(guest)).status, 201);
      code(await rate(guest), 409, "REVIEW_EXISTS");
      assert.deepEqual(
        (await guest("/api/menu/mutton-kacchi/reviews")).data.reviews,
        [],
      );
      const [review] = (await admin("/api/staff/reviews")).data.reviews;
      code(
        await patch(waiter, "/api/staff/reviews/" + review.id, {
          status: "approved",
        }),
        403,
        "FORBIDDEN",
      );
      assert.equal(
        (
          await patch(admin, "/api/staff/reviews/" + review.id, {
            status: "approved",
          })
        ).status,
        200,
      );
      const [published] = (await outsider("/api/menu/mutton-kacchi/reviews"))
        .data.reviews;
      assert.equal(published.comment, "<Great> with less chilli");
      assert.equal(published.sample, false);
      assert.deepEqual((await outsider("/api/menu")).data.dishes[0].rating, {
        count: 1,
        average: 5,
      });
      assert.equal(
        (
          await patch(admin, "/api/staff/reviews/" + review.id, {
            status: "hidden",
          })
        ).status,
        200,
      );
      assert.equal((await outsider("/api/menu")).data.dishes[0].rating, null);
    },
  );

  await t.test(
    "placing an order and closing the same table cannot both succeed",
    async () => {
      const [placed, closed] = await Promise.all([
        post(guest, "/api/orders", payload, key()),
        post(admin, "/api/staff/tables/T01/close"),
      ]);
      if (placed.status === 201) {
        code(closed, 409, "TABLE_BUSY");
        const rejected = await post(
          admin,
          "/api/staff/orders/" + placed.data.order.id + "/action",
          { action: "reject", reason: "Please check with staff." },
        );
        assert.equal(rejected.data.order.status, "cancelled");
        assert.equal(
          (await post(admin, "/api/staff/tables/T01/close")).status,
          204,
        );
      } else {
        code(placed, 409, "TABLE_CLOSED");
        assert.equal(closed.status, 204);
      }
      assert.equal((await guest("/api/context")).data.table.active, false);
      assert.equal((await post(admin, "/api/staff/logout")).status, 204);
      code(await admin("/api/staff/orders"), 401, "STAFF_REQUIRED");
    },
  );
});

test("React upgrade supports two phones, a precise table bill, review privacy and event holds", async (t) => {
  const uploads = await mkdtemp(path.join(os.tmpdir(), "angar-review-test-"));
  const store = await connectDatabase({
    ...loadConfig(),
    mongoDatabase: "angar_upgrade_test_" + key(),
  });
  const config = {
    ...loadConfig(),
    origin,
    secureCookies: false,
    proxyHops: 0,
    uploadDir: uploads,
  };
  const server = createApp(store, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      await store.db.dropDatabase();
    } finally {
      await store.client.close();
      await rm(uploads, { recursive: true, force: true });
    }
  });
  await store.dishes.insertMany(menu.map((dish) => ({ ...dish })));
  const password = await passwordHash(pass);
  await store.staff.insertMany(
    STAFF_ROLES.map((role) => ({
      username: role,
      role,
      passwordHash: password,
      active: true,
    })),
  );
  const table = {
    _id: new ObjectId(),
    number: "T01",
    qrToken: randomToken(24),
    activeVisitId: new ObjectId(),
    openedAt: new Date(),
    revision: 0,
  };
  await store.tables.insertMany([
    table,
    {
      number: "T02",
      qrToken: randomToken(24),
      activeVisitId: null,
      revision: 0,
    },
  ]);
  await store.eventLocks.insertOne({ _id: "dhanmondi-dining", revision: 0 });
  const url = "http://127.0.0.1:" + server.address().port;
  const first = browser(url),
    second = browser(url),
    stranger = browser(url),
    admin = browser(url),
    kitchen = browser(url),
    waiter = browser(url),
    cashier = browser(url);
  for (const [client, username] of [
    [admin, "admin"],
    [kitchen, "kitchen"],
    [waiter, "waiter"],
    [cashier, "cashier"],
  ]) {
    assert.equal(
      (await post(client, "/api/staff/login", { username, password: pass }))
        .status,
      200,
    );
  }
  for (const client of [first, second]) await client("/t/" + table.qrToken);
  const visitKey = (await first("/api/context")).data.table.visitKey;
  const one = {
    visitKey,
    items: [
      {
        dishId: "mutton-kacchi",
        quantity: 2,
        variantId: "regular",
        addonIds: ["extra-potato"],
        expectedPrice: 450,
      },
    ],
    note: "One shared table",
  };
  const two = {
    visitKey,
    items: [{ dishId: "mint-borhani", quantity: 1, expectedPrice: 110 }],
    note: "",
  };
  let firstOrder, secondOrder, bill;

  await t.test(
    "two separate guests place independently with server-calculated add-ons",
    async () => {
      const changed = {
        ...one,
        items: [{ ...one.items[0], expectedPrice: 420 }],
      };
      code(
        await post(first, "/api/orders", changed, key()),
        409,
        "PRICE_CHANGED",
      );
      firstOrder = (await post(first, "/api/orders", one, key())).data.order;
      secondOrder = (await post(second, "/api/orders", two, key())).data.order;
      assert.equal(firstOrder.total, 900);
      assert.equal(firstOrder.items[0].addons[0].name, "Extra potato");
      assert.equal(secondOrder.total, 110);
      assert.equal((await first("/api/orders")).data.orders.length, 1);
      assert.equal((await second("/api/orders")).data.orders.length, 1);
      const calls = await Promise.all([
        post(first, "/api/service-requests", { type: "bill", note: "" }),
        post(second, "/api/service-requests", { type: "bill", note: "" }),
        post(first, "/api/service-requests", { type: "bill", note: "" }),
      ]);
      assert.ok(calls.every((response) => response.status === 201));
      assert.equal(
        await store.serviceRequests.countDocuments({ status: "open" }),
        1,
      );
      code(
        await post(cashier, "/api/staff/orders/" + firstOrder.id + "/action", {
          action: "send",
        }),
        403,
        "FORBIDDEN",
      );
      code(
        await post(cashier, "/api/staff/billing/T01/finalize"),
        409,
        "UNFINISHED_ORDERS",
      );
      for (const order of [firstOrder, secondOrder]) {
        for (const [client, action] of [
          [admin, "send"],
          [kitchen, "start"],
          [kitchen, "ready"],
          [waiter, "serve"],
        ]) {
          assert.equal(
            (
              await post(client, "/api/staff/orders/" + order.id + "/action", {
                action,
              })
            ).status,
            200,
          );
        }
      }
    },
  );
  await t.test(
    "finalized totals preserve snapshots and payment is posted once",
    async () => {
      assert.equal(
        (
          await patch(admin, "/api/staff/settings", {
            orderingEnabled: true,
            serviceChargeBps: 250,
          })
        ).status,
        200,
      );
      await patch(admin, "/api/staff/menu/mutton-kacchi", {
        price: 430,
        available: true,
      });
      const attempts = await Promise.all([
        post(cashier, "/api/staff/billing/T01/finalize"),
        post(admin, "/api/staff/billing/T01/finalize"),
      ]);
      assert.equal(attempts[0].status, 200);
      assert.equal(attempts[1].status, 200);
      bill = attempts[0].data.bill;
      assert.equal(bill.id, attempts[1].data.bill.id);
      assert.equal(bill.subtotal, 1010);
      assert.equal(bill.charge, 25.25);
      assert.equal(bill.total, 1035.25);
      code(
        await post(second, "/api/orders", two, key()),
        409,
        "BILL_FINALIZED",
      );
      code(
        await post(waiter, "/api/staff/bills/" + bill.id + "/pay", {
          method: "cash",
          reference: "",
          verified: true,
        }),
        403,
        "FORBIDDEN",
      );
      const payments = await Promise.all([
        post(cashier, "/api/staff/bills/" + bill.id + "/pay", {
          method: "cash",
          reference: "",
          verified: true,
        }),
        post(cashier, "/api/staff/bills/" + bill.id + "/pay", {
          method: "cash",
          reference: "",
          verified: true,
        }),
      ]);
      assert.ok(
        payments.every(
          (response) =>
            response.status === 200 && response.data.bill.status === "paid",
        ),
      );
      assert.equal(await store.audit.countDocuments({ type: "bill.paid" }), 1);
      assert.equal((await first("/api/context")).data.table.active, false);
      assert.equal(
        await store.serviceRequests.countDocuments({ status: "open" }),
        0,
      );
      code(
        await post(first, "/api/service-requests", {
          type: "waiter",
          note: "",
        }),
        409,
        "TABLE_CLOSED",
      );
      assert.equal(
        (await first("/api/receipts/" + bill.id)).data.bill.total,
        1035.25,
      );
      code(await stranger("/api/receipts/" + bill.id), 404, "NOT_FOUND");
      assert.equal((await admin("/api/staff/overview")).data.sales, 1035.25);
    },
  );
  await t.test(
    "private feedback and image failures preserve guest consent and saved text",
    async () => {
      assert.equal(
        (
          await post(second, "/api/orders/" + secondOrder.id + "/reviews", {
            dishId: "mint-borhani",
            rating: 2,
            comment: "Too much spice for me.",
            visibility: "private",
          })
        ).status,
        201,
      );
      let review = (await admin("/api/staff/reviews")).data.reviews.find(
        (item) => item.dishName === "Mint Borhani",
      );
      await patch(admin, "/api/staff/reviews/" + review.id, {
        status: "approved",
        reply: "Thank you for letting us know.",
      });
      assert.equal(
        (await stranger("/api/menu/mint-borhani/reviews")).data.reviews.length,
        0,
      );
      assert.equal(
        (
          await post(first, "/api/orders/" + firstOrder.id + "/reviews", {
            dishId: "mutton-kacchi",
            rating: 3,
            comment: "A little less chilli next time.",
            visibility: "public",
          })
        ).status,
        201,
      );
      const photoPath =
        "/api/orders/" + firstOrder.id + "/reviews/mutton-kacchi/photo";
      code(
        await first(photoPath, {
          method: "POST",
          image: Buffer.from("invalid image"),
        }),
        400,
        "PHOTO_INVALID",
      );
      assert.equal(
        await store.reviews.countDocuments({
          orderId: new ObjectId(firstOrder.id),
        }),
        1,
      );
      const image = await sharp({
        create: { width: 16, height: 16, channels: 3, background: "#f0c57d" },
      })
        .webp()
        .toBuffer();
      assert.equal(
        (await first(photoPath, { method: "POST", image })).status,
        201,
      );
      review = (await admin("/api/staff/reviews")).data.reviews.find(
        (item) => item.dishName === "Dhakai Mutton Kacchi",
      );
      assert.equal((await admin(review.photo)).status, 200);
      const filename = review.photo.split("/").at(-1);
      code(await stranger("/api/review-media/" + filename), 404, "NOT_FOUND");
      await patch(admin, "/api/staff/reviews/" + review.id, {
        status: "approved",
        reply: "We appreciate your honest feedback.",
      });
      const published = (await stranger("/api/menu/mutton-kacchi/reviews")).data
        .reviews[0];
      assert.equal(published.rating, 3);
      assert.equal(published.reply, "We appreciate your honest feedback.");
      assert.equal((await stranger(published.photo)).status, 200);
    },
  );
  await t.test(
    "table pauses, waiter entry and QR replacement are enforced",
    async () => {
      const opened = await post(waiter, "/api/staff/tables/T02/open");
      assert.equal(opened.status, 200);
      const otherTable = await store.tables.findOne({ number: "T02" });
      await stranger("/t/" + otherTable.qrToken);
      const context = (await stranger("/api/context")).data.table;
      await patch(admin, "/api/staff/settings", {
        orderingEnabled: false,
        serviceChargeBps: 250,
      });
      const payload = {
        visitKey: context.visitKey,
        items: [{ dishId: "beef-seekh", quantity: 1, expectedPrice: 290 }],
        note: "",
      };
      code(
        await post(stranger, "/api/orders", payload, key()),
        409,
        "ORDERING_PAUSED",
      );
      await patch(admin, "/api/staff/settings", {
        orderingEnabled: true,
        serviceChargeBps: 250,
      });
      const entry = await post(
        waiter,
        "/api/staff/manual-orders",
        { tableNumber: "T02", order: payload },
        key(),
      );
      assert.equal(entry.status, 201);
      assert.equal(entry.data.order.source, "staff");
      await post(admin, "/api/staff/tables/T02/rotate-qr");
      const scan = await stranger("/t/" + otherTable.qrToken);
      assert.equal(scan.response.headers.get("location"), "/menu?scan=invalid");
    },
  );
  await t.test(
    "event quotes hold the full space including partitions and cleanup",
    async () => {
      const date = new Date(Date.now() + 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      const input = {
        requestKey: key(),
        name: "Test gathering",
        phone: "01700000000",
        type: "family",
        date,
        time: "19:00",
        hours: 2,
        guests: 12,
        spaceId: "family-corner",
        packageId: "dhaka-table",
        note: "Test request",
      };
      const requested = await post(first, "/api/events", input);
      assert.equal(requested.status, 201, JSON.stringify(requested.data));
      const event = requested.data.event;
      assert.equal(
        (await post(first, "/api/events", input)).data.event.id,
        event.id,
      );
      code(
        await post(first, "/api/events", { ...input, guests: 15 }),
        409,
        "REQUEST_CHANGED",
      );
      const competingResponse = await post(second, "/api/events", {
        ...input,
        requestKey: key(),
        spaceId: "dining-room",
        time: "21:15",
        hours: 1,
      });
      assert.equal(
        competingResponse.status,
        201,
        JSON.stringify(competingResponse.data),
      );
      const competing = competingResponse.data.event;
      const quote = {
        hallFee: 1000,
        perGuest: 550,
        extras: 0,
        depositPercent: 20,
        terms: "Final guest count is required two days before the event.",
        menu: "Kacchi, borhani and phirni.",
        validHours: 48,
      };
      const response = await post(
        admin,
        "/api/staff/events/" + event.id + "/quote",
        quote,
      );
      assert.equal(response.status, 200);
      assert.equal(response.data.event.quote.total, 7600);
      code(
        await post(
          admin,
          "/api/staff/events/" + competing.id + "/quote",
          quote,
        ),
        409,
        "SLOT_BUSY",
      );
      code(
        await post(second, "/api/events/" + event.id + "/accept", {
          version: 1,
        }),
        404,
        "NOT_FOUND",
      );
      assert.equal(
        (
          await post(first, "/api/events/" + event.id + "/accept", {
            version: 1,
          })
        ).data.event.status,
        "awaiting_deposit",
      );
      code(
        await post(admin, "/api/staff/events/" + event.id + "/action", {
          action: "deposit",
          reference: "Test counter reference",
        }),
        400,
        "VERIFY_DEPOSIT",
      );
      assert.equal(
        (
          await post(admin, "/api/staff/events/" + event.id + "/action", {
            action: "deposit",
            reference: "Test counter reference",
            verified: true,
          })
        ).data.event.status,
        "confirmed",
      );
    },
  );
});
