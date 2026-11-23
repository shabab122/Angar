import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, post, ok, error, password, key } from "./support.js";
const tomorrow = () =>
  new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const request = () => ({
  requestKey: key(),
  name: "Event guest",
  phone: "01700000000",
  type: "family",
  date: tomorrow(),
  time: "18:00",
  hours: 2,
  guests: 12,
  spaceId: "family-corner",
  packageId: "dhaka-table",
  note: "",
});
const put = (client, data) =>
  client("/api/staff/event-config", { method: "PUT", data });
test("event configuration validates capacity/prices, keeps exact quote snapshots and rejects stale edits", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    base = ok(await f.staff.admin("/api/staff/event-config")).configuration;
  error(await f.staff.kitchen("/api/staff/event-config"), 403, "FORBIDDEN");
  const next = structuredClone(base);
  next.spaces[1].capacity = 14;
  next.packages[0].perGuest = 625;
  ok(
    await put(f.staff.admin, {
      spaces: next.spaces,
      packages: next.packages,
      expectedRevision: 0,
      reason: "Seasonal events update",
    }),
  );
  const options = ok(await guest("/api/events/options"));
  assert.equal(options.packages[0].perGuest, 625);
  assert.equal(options.spaces[1].capacity, 14);
  error(
    await put(f.staff.admin, {
      spaces: next.spaces,
      packages: next.packages,
      expectedRevision: 0,
      reason: "Concurrent edit",
    }),
    409,
    "EVENT_CONFIG_CHANGED",
  );
  error(
    await post(guest, "/api/events", { ...request(), guests: 15 }),
    400,
    "CAPACITY",
  );
  const event = ok(
    await post(guest, "/api/events", {
      ...request(),
      expectedConfigRevision: 1,
    }),
    201,
  ).event;
  assert.equal(event.package.perGuest, 625);
  const quoted = ok(
    await post(f.staff.admin, "/api/staff/events/" + event.id + "/quote", {
      hallFee: 1000,
      perGuest: 625,
      extras: 0,
      depositPercent: 20,
      terms: "Confirm guest count with our team.",
      menu: "Seasonal event menu",
      validHours: 48,
    }),
  ).event;
  next.packages[0].perGuest = 700;
  ok(
    await put(f.staff.admin, {
      spaces: next.spaces,
      packages: next.packages,
      expectedRevision: 1,
      reason: "New requests price update",
    }),
  );
  const existing = ok(await guest("/api/events")).events.find(
    (row) => row.id === event.id,
  );
  assert.equal(existing.quote.total, quoted.quote.total);
  assert.equal(existing.quote.perGuest, 625);
  next.spaces[1].resourceIds = ["separate-room"];
  error(
    await put(f.staff.admin, {
      spaces: next.spaces,
      packages: next.packages,
      expectedRevision: 2,
      reason: "Move an already held event",
    }),
    409,
    "EVENT_HELD",
  );
  next.spaces[1].resourceIds = ["family-corner"];
  next.spaces[1].active = false;
  ok(
    await put(f.staff.admin, {
      spaces: next.spaces,
      packages: next.packages,
      expectedRevision: 2,
      reason: "Archive held space for new requests",
    }),
  );
  assert.equal(ok(await guest("/api/events/options")).spaces.length, 1);
  ok(
    await post(guest, "/api/events/" + event.id + "/accept", {
      version: quoted.quote.version,
    }),
  );
});
test("custom independent event resources avoid false conflicts while dining-floor holds remain exclusive", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    base = ok(await f.staff.admin("/api/staff/event-config")).configuration;
  base.spaces.push({
    id: "rooftop",
    name: "Private rooftop",
    capacity: 50,
    minGuests: 8,
    description: "Independent event room",
    resourceIds: ["rooftop"],
    blocksDining: false,
    active: true,
  });
  ok(
    await put(f.staff.admin, {
      ...base,
      expectedRevision: 0,
      revision: undefined,
      reason: "Add independent event room",
    }),
  );
  const quote = {
    hallFee: 100,
    perGuest: 550,
    extras: 0,
    depositPercent: 0,
    terms: "Confirm final guest numbers.",
    menu: "A private set menu",
    validHours: 48,
  };
  const a = ok(await post(guest, "/api/events", request()), 201).event,
    b = ok(
      await post(guest, "/api/events", { ...request(), spaceId: "rooftop" }),
      201,
    ).event;
  ok(await post(f.staff.admin, "/api/staff/events/" + a.id + "/quote", quote));
  ok(await post(f.staff.admin, "/api/staff/events/" + b.id + "/quote", quote));
});
async function stream(f, signal) {
  const client = f.browser(),
    login = await post(client, "/api/staff/login", {
      username: "admin",
      password,
    }),
    cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  const response = await fetch(f.url + "/api/staff/live?branch=main", {
    headers: { Cookie: cookie },
    signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    async event(name, timeout = 7000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const part = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (part.startsWith("event: " + name + "\n"))
            return JSON.parse(part.split("\ndata: ")[1]);
        }
        const read = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timed out waiting for live " + name)),
              Math.max(1, deadline - Date.now()),
            );
            timer.unref();
          }),
        ]);
        if (read.done) throw new Error("Live stream closed early");
        buffer += decoder.decode(read.value, { stream: true });
      }
      throw new Error("Live event absent");
    },
  };
}
test("staff live events invalidate views without exposing documents and reconnect with an explicit resync", async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const first = await stream(f, abort.signal);
  try {
    const ready = await first.event("ready");
    assert.equal(ready.resync, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await f.store.dishes.updateOne(
      { _id: "mutton-kacchi" },
      { $set: { price: 430, privateSecret: "never-stream-this" } },
    );
    const event = await first.event("refresh");
    assert.ok(event.topics.includes("menu"));
    assert.equal(JSON.stringify(event).includes("privateSecret"), false);
    assert.equal(JSON.stringify(event).includes("430"), false);
  } finally {
    abort.abort();
    await first.reader.cancel().catch(() => {});
  }
  await f.store.dishes.updateOne(
    { _id: "mutton-kacchi" },
    { $set: { price: 440 } },
  );
  const nextAbort = new AbortController(),
    next = await stream(f, nextAbort.signal);
  try {
    assert.equal((await next.event("ready")).resync, true);
    assert.equal(
      ok(await f.staff.admin("/api/menu")).dishes.find(
        (d) => d._id === "mutton-kacchi",
      ).price,
      440,
    );
  } finally {
    nextAbort.abort();
    await next.reader.cancel().catch(() => {});
  }
});
