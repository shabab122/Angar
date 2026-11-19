import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { test } from "node:test";
import { fixture, key, ok, error, post, patch } from "./support.js";

const tomorrow = () =>
  new Date(Date.now() + 86400000 + 6 * 3600000).toISOString().slice(0, 10);
const booking = (overrides = {}) => ({
  name: "Test Party",
  phone: "01700000000",
  partySize: 4,
  note: "",
  date: tomorrow(),
  time: "12:00",
  requestKey: key(),
  ...overrides,
});

test("concurrent reservations cannot double-book a suitable table; cancellation frees the slot", async (t) => {
  const f = await fixture(t),
    first = f.browser(),
    second = f.browser();
  const a = booking(),
    b = booking();
  const results = await Promise.all([
    post(first, "/api/reservations", a),
    post(second, "/api/reservations", b),
  ]);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  const index = results[0].status === 201 ? 0 : 1,
    owner = index ? second : first,
    other = index ? first : second,
    input = index ? b : a;
  const reservation = results[index].data.reservation;
  assert.equal(
    ok(await post(owner, "/api/reservations", input), 201).reservation.id,
    reservation.id,
  );
  assert.equal(
    await f.store.reservations.countDocuments({ status: "confirmed" }),
    1,
  );
  error(
    await post(other, "/api/reservations/" + reservation.id + "/cancel", {
      reason: "Not my booking",
    }),
    404,
    "NOT_FOUND",
  );
  error(
    await patch(f.staff.admin, "/api/staff/tables/T01/capacity", {
      capacity: 2,
    }),
    409,
    "CAPACITY_BOOKED",
  );
  const unavailable = ok(
    await owner(
      "/api/reservations/availability?date=" + input.date + "&partySize=4",
    ),
  );
  assert.equal(
    unavailable.slots.find((slot) => slot.time === "12:00").available,
    false,
  );
  ok(
    await post(owner, "/api/reservations/" + reservation.id + "/cancel", {
      reason: "Plans changed",
    }),
    204,
  );
  assert.equal(
    ok(await post(other, "/api/reservations", booking()), 201).reservation
      .status,
    "confirmed",
  );
  error(
    await post(first, "/api/reservations", booking({ date: "2026-02-30" })),
    400,
    "INVALID_SLOT",
  );
});

test("private-event holds and table reservations use the same dining lock", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  const input = booking(),
    start = new Date(input.date + "T12:00:00+06:00"),
    end = new Date(start.getTime() + 2 * 3600000);
  const eventId = new ObjectId();
  await f.store.events.insertOne({
    _id: eventId,
    guestHash: "test-event",
    requestKey: key(),
    spaceId: "dining-room",
    startsAt: start,
    endsAt: end,
    blockedUntil: end,
    status: "confirmed",
  });
  error(await post(guest, "/api/reservations", input), 409, "SLOT_BUSY");
  await f.store.events.deleteOne({ _id: eventId });
  const reserved = ok(
    await post(guest, "/api/reservations", input),
    201,
  ).reservation;
  await f.store.events.insertOne({
    _id: eventId,
    guestHash: "test-event",
    requestKey: key(),
    code: "EV-TEST",
    spaceId: "dining-room",
    packageId: "dhaka-table",
    type: "family",
    guests: 8,
    name: "Private party",
    phone: "01700000000",
    startsAt: start,
    endsAt: end,
    blockedUntil: end,
    status: "requested",
    createdAt: new Date(),
    history: [],
  });
  const quoted = await post(
    f.staff.admin,
    "/api/staff/events/" + eventId + "/quote",
    {
      hallFee: 1000,
      perGuest: 500,
      extras: 0,
      depositPercent: 20,
      terms: "Test event terms",
      menu: "Test event menu",
      validHours: 24,
    },
  );
  error(quoted, 409, "SLOT_BUSY");
  assert.equal(
    (await f.store.reservations.findOne({ _id: new ObjectId(reserved.id) }))
      .status,
    "confirmed",
  );
});

test("reserved seating opens one table visit and closes with the existing billing/close workflow", async (t) => {
  const f = await fixture(t),
    guest = f.browser();
  const reservation = ok(
    await post(guest, "/api/reservations", booking()),
    201,
  ).reservation;
  error(
    await post(
      f.staff.waiter,
      "/api/staff/reservations/" + reservation.id + "/action",
      { action: "seat" },
    ),
    409,
    "SEATING_TIME",
  );
  await f.store.reservations.updateOne(
    { _id: new ObjectId(reservation.id) },
    {
      $set: {
        startsAt: new Date(Date.now() - 5 * 60000),
        endsAt: new Date(Date.now() + 85 * 60000),
      },
    },
  );
  const seated = ok(
    await post(
      f.staff.waiter,
      "/api/staff/reservations/" + reservation.id + "/action",
      { action: "seat" },
    ),
  ).reservation;
  assert.equal(seated.status, "seated");
  error(
    await post(
      f.staff.waiter,
      "/api/staff/reservations/" + reservation.id + "/action",
      { action: "seat" },
    ),
    409,
    "BOOKING_UPDATED",
  );
  const table = await f.store.tables.findOne({ number: "T01" });
  assert.ok(table.activeVisitId);
  const order = await f.order(guest, table);
  await f.serve(order);
  const bill = ok(
    await post(f.staff.cashier, "/api/staff/billing/T01/finalize"),
  ).bill;
  ok(
    await post(f.staff.cashier, "/api/staff/bills/" + bill.id + "/pay", {
      method: "cash",
      reference: "",
      verified: true,
    }),
  );
  assert.equal(
    (await f.store.reservations.findOne({ _id: new ObjectId(reservation.id) }))
      .status,
    "completed",
  );
  assert.equal(
    (await f.store.tables.findOne({ number: "T01" })).activeVisitId,
    null,
  );
});

test("waiting-list entries deduplicate, remain private, and seat only at a free suitable table", async (t) => {
  const f = await fixture(t),
    guest = f.browser(),
    other = f.browser();
  await f.store.settings.updateOne(
    { _id: "restaurant" },
    {
      $set: {
        reservations: {
          open: "00:00",
          close: "23:59",
          durationMinutes: 30,
          daysAhead: 90,
          enabled: true,
        },
      },
    },
    { upsert: true },
  );
  const input = {
    name: "Waiting party",
    phone: "01700000000",
    partySize: 4,
    note: "Window preferred",
  };
  const first = ok(await post(guest, "/api/waitlist", input), 201).entry;
  assert.equal(
    ok(await post(guest, "/api/waitlist", input), 201).entry.id,
    first.id,
  );
  assert.equal(ok(await guest("/api/waitlist")).position, 1);
  assert.equal(ok(await other("/api/waitlist")).entry, null);
  error(
    await post(f.staff.kitchen, "/api/staff/waitlist/" + first.id + "/action", {
      action: "call",
    }),
    403,
    "FORBIDDEN",
  );
  ok(
    await post(f.staff.waiter, "/api/staff/waitlist/" + first.id + "/action", {
      action: "call",
    }),
  );
  assert.equal(ok(await guest("/api/waitlist")).entry.status, "notified");
  const occupied = await f.open("T01");
  error(
    await post(f.staff.waiter, "/api/staff/waitlist/" + first.id + "/action", {
      action: "seat",
      tableNumber: "T01",
    }),
    409,
    "NO_TABLE",
  );
  ok(await post(f.staff.waiter, "/api/staff/tables/T01/close"), 204);
  const seated = ok(
    await post(f.staff.waiter, "/api/staff/waitlist/" + first.id + "/action", {
      action: "seat",
      tableNumber: "T01",
    }),
  ).entry;
  assert.equal(seated.status, "seated");
  assert.equal(seated.tableNumber, "T01");
  assert.equal(ok(await guest("/api/waitlist")).entry, null);
  assert.ok(occupied.activeVisitId);
});
