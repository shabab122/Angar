import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { once } from "node:events";
import { ObjectId } from "mongodb";
import { createApp } from "../server/app.js";
import { fixture, post, ok, key, password } from "./support.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((row) => row.split(";")[0])
    .join("; ");
}
async function stream(f, cookie) {
  const controller = new AbortController(),
    response = await fetch(f.url + "/api/customer/live", {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [],
    reader = response.body.getReader();
  let buffer = "";
  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString("utf8");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!chunk.startsWith("event:")) continue;
          const type = /event: ([^\n]+)/.exec(chunk)?.[1],
            data = /data: (.+)/.exec(chunk)?.[1];
          if (data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    events,
    close: async () => {
      controller.abort();
      await done;
    },
    wait: async (predicate, timeout = 4000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const found = events.find(predicate);
        if (found) return found;
        await delay(20);
      }
      throw new Error(
        "Expected customer live event did not arrive: " +
          JSON.stringify(events),
      );
    },
  };
}
test("customer live events invalidate only the owning account and never include document IDs or personal fields", async (t) => {
  const f = await fixture(t),
    one = f.browser(),
    two = f.browser(),
    a = await post(one, "/api/account/register", {
      name: "Live member one",
      email: key() + "@example.test",
      password,
    }),
    b = await post(two, "/api/account/register", {
      name: "Live member two",
      email: key() + "@example.test",
      password,
    });
  ok(a, 201);
  ok(b, 201);
  const c1 = await stream(f, cookies(a)),
    c2 = await stream(f, cookies(b));
  try {
    await Promise.all([
      c1.wait((e) => e.type === "state" && e.data.state === "connected"),
      c2.wait((e) => e.type === "state" && e.data.state === "connected"),
    ]);
    const id = new ObjectId();
    await f.store.orders.insertOne({
      _id: id,
      customerId: new ObjectId(a.data.customer.id),
      code: "PRIVATE-LIVE-CODE",
      guestHash: "private",
      requestKey: key(),
      phone: "01700000000",
      status: "placed",
      createdAt: new Date(),
    });
    const event = await c1.wait((e) => e.type === "refresh");
    assert.deepEqual(event.data.topics, ["orders"]);
    assert.equal(
      JSON.stringify(c1.events).includes("PRIVATE-LIVE-CODE"),
      false,
    );
    assert.equal(JSON.stringify(c1.events).includes(String(id)), false);
    await delay(180);
    assert.equal(
      c2.events.some((e) => e.type === "refresh"),
      false,
    );
  } finally {
    await Promise.all([c1.close(), c2.close()]);
  }
});
test("guest reservations and waiting-list alerts stream privately and reconnect with an explicit resync", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    initial = await guest("/api/orders"),
    cookie = cookies(initial);
  let live = await stream(f, cookie);
  try {
    await live.wait((e) => e.type === "state" && e.data.state === "connected");
    const guestHash = (await import("../server/security.js")).hash;
    const signedCookie = cookie
      .split(";")
      .find((value) => value.trim().startsWith("angar_guest="));
    assert.ok(signedCookie);
    const encoded = decodeURIComponent(
        signedCookie.trim().slice("angar_guest=".length),
      ),
      token = encoded.slice(2).split(".")[0],
      owner = guestHash(token),
      reservationId = new ObjectId();
    await f.store.reservations.insertOne({
      _id: reservationId,
      customerId: null,
      guestHash: owner,
      status: "confirmed",
      code: "PRIVATE-BOOKING",
      createdAt: new Date(),
    });
    await live.wait(
      (e) => e.type === "refresh" && e.data.topics.includes("reservations"),
    );
    await f.store.waitlist.insertOne({
      _id: new ObjectId(),
      customerId: null,
      guestHash: owner,
      status: "notified",
      code: "PRIVATE-WAITING",
    });
    await live.wait(
      (e) => e.type === "refresh" && e.data.topics.includes("waitlist"),
    );
    await live.close();
    await f.store.reservations.updateOne(
      { _id: reservationId },
      { $set: { status: "cancelled" } },
    );
    live = await stream(f, cookie);
    const ready = await live.wait((e) => e.type === "ready");
    assert.equal(ready.data.resync, true);
    assert.equal(
      JSON.stringify(live.events).includes("PRIVATE-BOOKING"),
      false,
    );
  } finally {
    await live.close();
  }
});
test("customer logout revokes an already-open authenticated stream at its next access check", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    login = await post(guest, "/api/account/register", {
      name: "Live logout member",
      email: key() + "@example.test",
      password,
    });
  ok(login, 201);
  const live = await stream(f, cookies(login));
  try {
    await live.wait((e) => e.type === "ready");
    ok(await post(guest, "/api/account/logout"), 204);
    const access = await live.wait((e) => e.type === "access", 7500);
    assert.equal(access.data.changed, true);
  } finally {
    await live.close();
  }
});
test("navigating away during customer stream authentication does not log a server error or affect reconnect", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    login = await post(guest, "/api/account/register", {
      name: "Interrupted live member",
      email: key() + "@example.test",
      password,
    });
  ok(login, 201);
  const app = createApp(f.store, f.config),
    server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port,
    findOne = f.store.customerSessions.findOne.bind(f.store.customerSessions),
    started = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    handled = Promise.withResolvers(),
    closed = Promise.withResolvers(),
    messages = [];
  let intercept = true;
  t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));
  f.store.customerSessions.findOne = async (...args) => {
    if (intercept) {
      intercept = false;
      started.resolve();
      await resume.promise;
    }
    return findOne(...args);
  };
  t.after(async () => {
    resume.resolve();
    f.store.customerSessions.findOne = findOne;
    await app.stopLive();
    await new Promise((resolve) => server.close(resolve));
  });
  server.once("request", (_req, res) => {
    res.once("close", closed.resolve);
    const end = res.end;
    res.end = function (...args) {
      handled.resolve();
      return end.apply(this, args);
    };
  });
  const request = get(url + "/api/customer/live", {
    headers: { Cookie: cookies(login) },
  });
  request.on("error", () => {});
  try {
    await started.promise;
    request.destroy();
    await closed.promise;
    resume.resolve();
    await handled.promise;
    assert.deepEqual(messages, []);
    const live = await stream({ url }, cookies(login));
    try {
      await live.wait((e) => e.type === "ready");
    } finally {
      await live.close();
    }
  } finally {
    request.destroy();
    resume.resolve();
  }
});
