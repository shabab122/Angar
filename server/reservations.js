import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { body, HttpError } from "./http.js";
import { getGuest, hash } from "./security.js";
import { actorKey, contactPhone, orderOwner } from "./customer.js";
import { transaction } from "./money.js";

const defaults = {
  open: "12:00",
  close: "22:30",
  durationMinutes: 90,
  daysAhead: 90,
  enabled: true,
};
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const contact = {
  name: z.string().trim().min(2).max(80),
  phone: contactPhone,
  partySize: z.number().int().min(1).max(30),
  note: z.string().trim().max(200).default(""),
};
const ACTIVE_RESERVATIONS = ["confirmed", "seated"];
export const reservationView = (row, staff = false) => ({
  id: row._id.toString(),
  code: row.code,
  tableNumber: row.tableNumber,
  name: row.name,
  phone: row.phone,
  partySize: row.partySize,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  status: row.status,
  note: row.note,
  createdAt: row.createdAt,
  ...(staff ? { history: row.history || [] } : {}),
});
const waitView = (row) =>
  row
    ? {
        id: row._id.toString(),
        name: row.name,
        phone: row.phone,
        partySize: row.partySize,
        note: row.note,
        status: row.status,
        createdAt: row.createdAt,
        calledAt: row.calledAt,
        tableNumber: row.tableNumber,
      }
    : null;
const dhakaDate = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const minutes = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export async function reservationSettings(store, session) {
  return {
    ...defaults,
    ...(await store.settings.findOne({ _id: "restaurant" }, { session }))
      ?.reservations,
  };
}
export async function lockDining(store, session) {
  await store.eventLocks.updateOne(
    { _id: "dhanmondi-dining" },
    { $inc: { revision: 1 } },
    { session, upsert: true },
  );
}
export async function assertNoPrivateEvent(store, start, end, session) {
  const event = await store.events.findOne(
    {
      "space.blocksDining": { $ne: false },
      startsAt: { $lt: end },
      blockedUntil: { $gt: start },
      $or: [
        { status: "confirmed" },
        {
          status: { $in: ["quote_sent", "awaiting_deposit"] },
          "quote.expiresAt": { $gt: new Date() },
        },
      ],
    },
    { session, projection: { _id: 1 } },
  );
  if (event)
    throw new HttpError(
      409,
      "SLOT_BUSY",
      "A private gathering holds this dining time. Please choose another slot.",
    );
}
function slotWindow(settings, input) {
  if (!settings.enabled)
    throw new HttpError(
      409,
      "RESERVATIONS_PAUSED",
      "Table reservations are temporarily paused.",
    );
  const start = new Date(input.date + "T" + input.time + ":00+06:00");
  const now = new Date();
  if (
    !Number.isFinite(start.getTime()) ||
    dhakaDate(start) !== input.date ||
    minutes(input.time) % 30 ||
    minutes(input.time) < minutes(settings.open) ||
    minutes(input.time) + settings.durationMinutes > minutes(settings.close) ||
    start.getTime() < now.getTime() + 30 * 60000 ||
    start.getTime() > now.getTime() + settings.daysAhead * 86400000
  )
    throw new HttpError(
      400,
      "INVALID_SLOT",
      "Choose an available half-hour slot at least 30 minutes ahead, within opening hours and the booking window.",
    );
  return {
    settings,
    start,
    end: new Date(start.getTime() + settings.durationMinutes * 60000),
  };
}
async function slot(store, input, session) {
  return slotWindow(await reservationSettings(store, session), input);
}
async function freeTable(
  store,
  start,
  end,
  partySize,
  session,
  number = null,
  forSeating = false,
) {
  const tables = await store.tables
    .find(number ? { number } : {}, { session })
    .sort({ capacity: 1, number: 1 })
    .toArray();
  tables.sort(
    (a, b) =>
      (a.capacity || 4) - (b.capacity || 4) || a.number.localeCompare(b.number),
  );
  for (const table of tables) {
    if ((table.capacity || 4) < partySize) continue;
    if (
      table.activeVisitId &&
      (forSeating || start.getTime() < Date.now() + 90 * 60000)
    )
      continue;
    const locked = session
      ? await store.tables.findOneAndUpdate(
          { _id: table._id },
          { $inc: { revision: 1 } },
          { session, returnDocument: "after" },
        )
      : table;
    if (
      locked.activeVisitId &&
      (forSeating || start.getTime() < Date.now() + 90 * 60000)
    )
      continue;
    if (
      await store.reservations.findOne(
        {
          tableId: table._id,
          status: { $in: ACTIVE_RESERVATIONS },
          startsAt: { $lt: end },
          endsAt: { $gt: start },
        },
        { session, projection: { _id: 1 } },
      )
    )
      continue;
    return locked;
  }
  throw new HttpError(
    409,
    "NO_TABLE",
    "No suitable table is available for that time and party size.",
  );
}

export async function openWalkInTable(store, number) {
  return transaction(store, async (session) => {
    await lockDining(store, session);
    const settings = await reservationSettings(store, session);
    const now = new Date(),
      end = new Date(now.getTime() + settings.durationMinutes * 60000);
    await assertNoPrivateEvent(store, now, end, session);
    const table = await freeTable(store, now, end, 1, session, number, true);
    const updated = await store.tables.findOneAndUpdate(
      { _id: table._id, activeVisitId: null },
      {
        $set: {
          activeVisitId: new ObjectId(),
          openedAt: now,
          billingState: "open",
          promotion: null,
        },
        $inc: { revision: 1 },
      },
      { session, returnDocument: "after" },
    );
    if (!updated)
      throw new HttpError(
        409,
        "TABLE_ALREADY_OPEN",
        "This table is already open.",
      );
    return updated;
  });
}

export function registerGuestReservations(api, store, config, requireId) {
  const bookingLimit = rateLimit({
    windowMs: 3600000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: {
        code: "RATE_LIMIT",
        message:
          "Too many booking attempts. Please wait or contact the restaurant.",
      },
    },
  });
  api.get("/reservations/options", async (req, res) =>
    res.json({
      ...(await reservationSettings(store)),
      timezone: "Asia/Dhaka",
      slotMinutes: 30,
      defaultTableCapacity: 4,
    }),
  );
  api.get("/reservations/availability", async (req, res) => {
    const input = body(
      z.object({ date, partySize: z.coerce.number().int().min(1).max(30) }),
      req.query,
    );
    const settings = await reservationSettings(store);
    const dayStart = new Date(input.date + "T00:00:00+06:00"),
      dayEnd = new Date(dayStart.getTime() + 86400000);
    if (
      !Number.isFinite(dayStart.getTime()) ||
      dhakaDate(dayStart) !== input.date
    )
      throw new HttpError(400, "INVALID_SLOT", "Choose a real calendar date.");
    // Availability is a preview: fetch the day's schedule once, then check each
    // slot in memory. The booking transaction repeats the authoritative checks.
    const [tables, bookings, events] = await Promise.all([
      store.tables.find({}).toArray(),
      store.reservations
        .find({
          status: { $in: ACTIVE_RESERVATIONS },
          startsAt: { $lt: dayEnd },
          endsAt: { $gt: dayStart },
        })
        .toArray(),
      store.events
        .find({
          startsAt: { $lt: dayEnd },
          blockedUntil: { $gt: dayStart },
          $or: [
            { status: "confirmed" },
            {
              status: { $in: ["quote_sent", "awaiting_deposit"] },
              "quote.expiresAt": { $gt: new Date() },
            },
          ],
        })
        .toArray(),
    ]);
    const slots = [];
    for (
      let value = minutes(settings.open);
      value + settings.durationMinutes <= minutes(settings.close);
      value += 30
    ) {
      const time =
        String(Math.floor(value / 60)).padStart(2, "0") +
        ":" +
        String(value % 60).padStart(2, "0");
      let available = false;
      try {
        const { start, end } = slotWindow(settings, { ...input, time });
        available =
          !events.some(
            (event) => event.startsAt < end && event.blockedUntil > start,
          ) &&
          tables.some(
            (table) =>
              (table.capacity || 4) >= input.partySize &&
              !(
                table.activeVisitId && start.getTime() < Date.now() + 90 * 60000
              ) &&
              !bookings.some(
                (booking) =>
                  booking.tableId.equals(table._id) &&
                  booking.startsAt < end &&
                  booking.endsAt > start,
              ),
          );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
      }
      slots.push({ time, available });
    }
    res.json({ date: input.date, slots });
  });
  api.get("/reservations", async (req, res) => {
    const rows = await store.reservations
      .find(orderOwner(req, getGuest(req, res, config)))
      .sort({ startsAt: -1 })
      .limit(50)
      .toArray();
    res.json({ reservations: rows.map((row) => reservationView(row)) });
  });
  api.post("/reservations", bookingLimit, async (req, res) => {
    const input = body(
      z.strictObject({
        ...contact,
        date,
        time: clock,
        requestKey: z.string().regex(/^[a-f0-9]{32}$/),
      }),
      req.body,
    );
    const guestHash = getGuest(req, res, config),
      owner = orderOwner(req, guestHash),
      fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      await lockDining(store, session);
      const existing = await store.reservations.findOne(
        { ...owner, requestKey: input.requestKey },
        { session },
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This booking key belongs to different details.",
          );
        return existing;
      }
      if (
        (await store.reservations.countDocuments(
          {
            ...owner,
            status: { $in: ACTIVE_RESERVATIONS },
            endsAt: { $gt: new Date() },
          },
          { session },
        )) >= 5
      )
        throw new HttpError(
          409,
          "BOOKING_LIMIT",
          "You already have five active reservations. Contact the restaurant for larger plans.",
        );
      const { start, end } = await slot(store, input, session);
      await assertNoPrivateEvent(store, start, end, session);
      const table = await freeTable(
        store,
        start,
        end,
        input.partySize,
        session,
      );
      const row = {
        _id: new ObjectId(),
        code: "RS-" + randomBytes(5).toString("hex").toUpperCase(),
        guestHash,
        ...(req.customer ? { customerId: req.customer._id } : {}),
        actorKey: actorKey(req, guestHash),
        requestKey: input.requestKey,
        fingerprint,
        name: input.name,
        phone: input.phone,
        partySize: input.partySize,
        note: input.note,
        tableId: table._id,
        tableNumber: table.number,
        startsAt: start,
        endsAt: end,
        status: "confirmed",
        createdAt: new Date(),
        history: [{ status: "confirmed", at: new Date() }],
      };
      await store.reservations.insertOne(row, { session });
      return row;
    });
    res.status(201).json({ reservation: reservationView(result) });
  });
  api.post("/reservations/:id/cancel", async (req, res) => {
    const { reason } = body(
      z.strictObject({ reason: z.string().trim().min(3).max(160) }),
      req.body,
    );
    await transaction(store, async (session) => {
      await lockDining(store, session);
      const row = await store.reservations.findOne(
        {
          _id: requireId(req.params.id),
          ...orderOwner(req, getGuest(req, res, config)),
        },
        { session },
      );
      if (!row)
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This reservation could not be found.",
        );
      if (row.status === "cancelled") return;
      if (row.status !== "confirmed" || row.startsAt <= new Date())
        throw new HttpError(
          409,
          "BOOKING_LOCKED",
          "Please contact staff to change a reservation that has started.",
        );
      await store.reservations.updateOne(
        { _id: row._id },
        {
          $set: { status: "cancelled" },
          $push: { history: { status: "cancelled", reason, at: new Date() } },
        },
        { session },
      );
    });
    res.status(204).end();
  });
  api.get("/waitlist", async (req, res) => {
    const row = await store.waitlist.findOne({
      ...orderOwner(req, getGuest(req, res, config)),
      active: true,
    });
    const position = row
      ? 1 +
        (await store.waitlist.countDocuments({
          active: true,
          $or: [
            { createdAt: { $lt: row.createdAt } },
            { createdAt: row.createdAt, _id: { $lt: row._id } },
          ],
        }))
      : null;
    res.json({ entry: waitView(row), position });
  });
  api.post("/waitlist", bookingLimit, async (req, res) => {
    const input = body(z.strictObject(contact), req.body),
      guestHash = getGuest(req, res, config);
    const row = await transaction(store, async (session) => {
      await lockDining(store, session);
      const existing = await store.waitlist.findOne(
        { ...orderOwner(req, guestHash), active: true },
        { session },
      );
      if (existing) return existing;
      const settings = await reservationSettings(store, session);
      const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dhaka",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (
        !settings.enabled ||
        minutes(time) < minutes(settings.open) ||
        minutes(time) >= minutes(settings.close)
      )
        throw new HttpError(
          409,
          "WAITLIST_CLOSED",
          "The waiting list is available during restaurant opening hours.",
        );
      const capacities = await store.tables.find({}, { session }).toArray();
      if (!capacities.some((table) => (table.capacity || 4) >= input.partySize))
        throw new HttpError(
          409,
          "PARTY_TOO_LARGE",
          "Contact the restaurant to arrange seating for this party size.",
        );
      const record = {
        _id: new ObjectId(),
        ...input,
        guestHash,
        ...(req.customer ? { customerId: req.customer._id } : {}),
        actorKey: actorKey(req, guestHash),
        active: true,
        status: "waiting",
        createdAt: new Date(),
      };
      await store.waitlist.insertOne(record, { session });
      return record;
    });
    res.status(201).json({ entry: waitView(row) });
  });
  api.post("/waitlist/:id/cancel", async (req, res) => {
    const result = await store.waitlist.updateOne(
      {
        _id: requireId(req.params.id),
        ...orderOwner(req, getGuest(req, res, config)),
        active: true,
      },
      { $set: { active: false, status: "cancelled", updatedAt: new Date() } },
    );
    if (!result.matchedCount)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "This waiting-list entry could not be found.",
      );
    res.status(204).end();
  });
}

export function registerStaffReservations(
  api,
  store,
  floorRoles,
  requireAdmin,
  requireId,
) {
  api.get("/reservations", floorRoles, async (req, res) => {
    const day = body(date, req.query.date || dhakaDate());
    const start = new Date(day + "T00:00:00+06:00"),
      end = new Date(start.getTime() + 86400000);
    if (!Number.isFinite(start.getTime()) || dhakaDate(start) !== day)
      throw new HttpError(400, "INVALID_DATE", "Choose a real calendar date.");
    const [reservations, waitlist, tables, settings] = await Promise.all([
      store.reservations
        .find({ startsAt: { $gte: start, $lt: end } })
        .sort({ startsAt: 1 })
        .toArray(),
      store.waitlist.find({ active: true }).sort({ createdAt: 1 }).toArray(),
      store.tables.find({}).sort({ number: 1 }).toArray(),
      reservationSettings(store),
    ]);
    res.json({
      reservations: reservations.map((row) => reservationView(row, true)),
      waitlist: waitlist.map(waitView),
      tables: tables.map((table) => ({
        number: table.number,
        capacity: table.capacity || 4,
        open: Boolean(table.activeVisitId),
      })),
      settings,
    });
  });
  api.post("/reservations/:id/action", floorRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        action: z.enum(["seat", "cancel", "no_show"]),
        reason: z.string().trim().max(160).default(""),
      }),
      req.body,
    );
    const result = await transaction(store, async (session) => {
      await lockDining(store, session);
      const row = await store.reservations.findOne(
        { _id: requireId(req.params.id) },
        { session },
      );
      if (!row || row.status !== "confirmed")
        throw new HttpError(
          409,
          "BOOKING_UPDATED",
          "This reservation is no longer awaiting arrival.",
        );
      let status =
        input.action === "seat"
          ? "seated"
          : input.action === "cancel"
            ? "cancelled"
            : "no_show";
      if (input.action === "seat") {
        const now = new Date();
        if (
          row.startsAt.getTime() - now.getTime() > 30 * 60000 ||
          row.endsAt <= now
        )
          throw new HttpError(
            409,
            "SEATING_TIME",
            "Seat this party within 30 minutes of its reserved time and before the slot ends.",
          );
        const table = await store.tables.findOneAndUpdate(
          { _id: row.tableId, activeVisitId: null },
          {
            $set: {
              activeVisitId: new ObjectId(),
              openedAt: now,
              billingState: "open",
              reservationId: row._id,
              promotion: null,
            },
            $inc: { revision: 1 },
          },
          { session, returnDocument: "after" },
        );
        if (!table)
          throw new HttpError(
            409,
            "TABLE_BUSY",
            "The reserved table is still occupied. Finish its current visit before seating.",
          );
      } else {
        if (input.reason.trim().length < 3)
          throw new HttpError(
            400,
            "REASON_REQUIRED",
            "Record a reason for this change.",
          );
        if (
          input.action === "no_show" &&
          Date.now() < row.startsAt.getTime() + 15 * 60000
        )
          throw new HttpError(
            409,
            "TOO_EARLY",
            "Wait until 15 minutes after the reservation starts before marking no-show.",
          );
      }
      const updated = await store.reservations.findOneAndUpdate(
        { _id: row._id },
        {
          $set: { status, updatedAt: new Date() },
          $push: {
            history: {
              status,
              by: req.staff.username,
              reason: input.reason,
              at: new Date(),
            },
          },
        },
        { session, returnDocument: "after" },
      );
      await store.audit.insertOne(
        {
          type: "reservation." + status,
          reservationId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return updated;
    });
    res.json({ reservation: reservationView(result, true) });
  });
  api.post("/waitlist/:id/action", floorRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        action: z.enum(["call", "seat", "cancel"]),
        tableNumber: z
          .string()
          .regex(/^T\d{2}$/)
          .optional(),
        reason: z.string().trim().max(160).default(""),
      }),
      req.body,
    );
    const row = await transaction(store, async (session) => {
      await lockDining(store, session);
      const row = await store.waitlist.findOne(
        { _id: requireId(req.params.id), active: true },
        { session },
      );
      if (!row)
        throw new HttpError(
          409,
          "WAITLIST_UPDATED",
          "This party is no longer on the waiting list.",
        );
      const set = { updatedAt: new Date() };
      if (input.action === "call")
        Object.assign(set, {
          status: "notified",
          calledAt: new Date(),
          calledBy: req.staff.username,
        });
      if (input.action === "cancel") {
        if (input.reason.length < 3)
          throw new HttpError(
            400,
            "REASON_REQUIRED",
            "Record why the party left the queue.",
          );
        Object.assign(set, { status: "cancelled", active: false });
      }
      if (input.action === "seat") {
        const settings = await reservationSettings(store, session),
          now = new Date(),
          end = new Date(now.getTime() + settings.durationMinutes * 60000);
        await assertNoPrivateEvent(store, now, end, session);
        const table = await freeTable(
          store,
          now,
          end,
          row.partySize,
          session,
          input.tableNumber,
          true,
        );
        const opened = await store.tables.updateOne(
          { _id: table._id, activeVisitId: null },
          {
            $set: {
              activeVisitId: new ObjectId(),
              openedAt: now,
              billingState: "open",
              waitlistId: row._id,
              promotion: null,
            },
          },
          { session },
        );
        if (!opened.matchedCount)
          throw new HttpError(
            409,
            "TABLE_BUSY",
            "This table is already occupied.",
          );
        Object.assign(set, {
          status: "seated",
          active: false,
          tableNumber: table.number,
          seatedAt: now,
        });
      }
      const updated = await store.waitlist.findOneAndUpdate(
        { _id: row._id },
        { $set: set },
        { session, returnDocument: "after" },
      );
      await store.audit.insertOne(
        {
          type: "waitlist." + input.action,
          waitlistId: row._id,
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
      return updated;
    });
    res.json({ entry: waitView(row) });
  });
  api.patch("/tables/:number/capacity", requireAdmin, async (req, res) => {
    const { capacity } = body(
      z.strictObject({ capacity: z.number().int().min(1).max(30) }),
      req.body,
    );
    await transaction(store, async (session) => {
      await lockDining(store, session);
      const table = await store.tables.findOneAndUpdate(
        { number: req.params.number },
        { $inc: { revision: 1 } },
        { session },
      );
      if (!table) throw new HttpError(404, "NOT_FOUND", "Table not found.");
      if (
        await store.reservations.findOne(
          {
            tableId: table._id,
            status: { $in: ACTIVE_RESERVATIONS },
            endsAt: { $gt: new Date() },
            partySize: { $gt: capacity },
          },
          { session },
        )
      )
        throw new HttpError(
          409,
          "CAPACITY_BOOKED",
          "An existing reservation needs more seats. Keep its capacity until that reservation ends.",
        );
      await store.tables.updateOne(
        { _id: table._id },
        { $set: { capacity } },
        { session },
      );
    });
    res.status(204).end();
  });
  api.patch("/reservation-settings", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        open: clock,
        close: clock,
        durationMinutes: z
          .number()
          .int()
          .min(30)
          .max(240)
          .refine((n) => n % 30 === 0),
        daysAhead: z.number().int().min(1).max(180),
        enabled: z.boolean(),
      }),
      req.body,
    );
    if (
      minutes(input.close) - minutes(input.open) < input.durationMinutes ||
      minutes(input.open) % 30 ||
      minutes(input.close) % 30
    )
      throw new HttpError(
        400,
        "INVALID_HOURS",
        "Use half-hour opening/closing times with room for a complete seating slot.",
      );
    await store.settings.updateOne(
      { _id: "restaurant" },
      { $set: { reservations: input } },
      { upsert: true },
    );
    res.json({ settings: input });
  });
}
