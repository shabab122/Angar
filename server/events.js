import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { getGuest, randomToken } from "./security.js";

export const eventOptions = {
  spaces: [
    {
      id: "dining-room",
      name: "The dining room",
      capacity: 60,
      description: "A private gathering across the full dining room.",
    },
    {
      id: "family-corner",
      name: "The family corner",
      capacity: 20,
      description: "An intimate section within our dining room.",
    },
  ],
  packages: [
    {
      id: "dhaka-table",
      name: "The Dhaka Table",
      perGuest: 550,
      description: "Kacchi, kebab, borhani and phirni.",
    },
    {
      id: "charcoal-evening",
      name: "A Charcoal Evening",
      perGuest: 650,
      description: "Grilled chicken, seekh kebab, rice and dessert.",
    },
    {
      id: "your-menu",
      name: "Make it yours",
      perGuest: null,
      description: "Talk to our team about a menu for your guests.",
    },
  ],
};
const eventInput = z.strictObject({
  requestKey: z.string().regex(/^[a-f0-9]{32}$/),
  name: z.string().trim().min(2).max(70),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9 ()-]{10,22}$/, "Enter a valid contact number."),
  type: z.enum(["birthday", "family", "corporate", "celebration"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z
    .string()
    .regex(
      /^(1[2-9]|2[0-1]):[0-5]\d$/,
      "Select a time between 12:00 and 21:59.",
    ),
  hours: z.number().int().min(1).max(5),
  guests: z.number().int().min(8).max(60),
  spaceId: z.enum(["dining-room", "family-corner"]),
  packageId: z.enum(["dhaka-table", "charcoal-evening", "your-menu"]),
  note: z.string().trim().max(600).default(""),
});
const quoteInput = z.strictObject({
  hallFee: z.number().int().min(0).max(500000),
  perGuest: z.number().int().min(0).max(10000),
  extras: z.number().int().min(0).max(500000),
  depositPercent: z.number().int().min(0).max(100),
  terms: z.string().trim().min(10).max(1000),
  menu: z.string().trim().min(3).max(500),
  validHours: z.number().int().min(1).max(168).default(48),
});

export function eventView(event, staff = false) {
  const {
    _id,
    code,
    name,
    type,
    guests,
    spaceId,
    packageId,
    startsAt,
    endsAt,
    status,
    quote,
    createdAt,
    note,
    history,
  } = event;
  return {
    id: _id.toString(),
    code,
    name,
    type,
    guests,
    spaceId,
    packageId,
    startsAt,
    endsAt,
    status,
    quote: quote || null,
    createdAt,
    note,
    history,
    ...(staff ? { phone: event.phone } : {}),
  };
}

async function assertSlot(store, event, session) {
  await store.eventLocks.updateOne(
    { _id: "dhanmondi-dining" },
    { $inc: { revision: 1 } },
    { session, upsert: true },
  );
  const conflict = await store.events.findOne(
    {
      _id: { $ne: event._id },
      startsAt: { $lt: event.blockedUntil },
      blockedUntil: { $gt: event.startsAt },
      $and: [
        {
          $or: [
            { spaceId: "dining-room" },
            { spaceId: event.spaceId },
            ...(event.spaceId === "dining-room" ? [{}] : []),
          ],
        },
        {
          $or: [
            { status: { $in: ["confirmed"] } },
            {
              status: { $in: ["quote_sent", "awaiting_deposit"] },
              "quote.expiresAt": { $gt: new Date() },
            },
          ],
        },
      ],
    },
    { session, projection: { _id: 1 } },
  );
  const tableBooking = await store.reservations.findOne(
    {
      status: { $in: ["confirmed", "seated"] },
      startsAt: { $lt: event.blockedUntil },
      endsAt: { $gt: event.startsAt },
    },
    { session, projection: { _id: 1 } },
  );
  if (tableBooking)
    throw new HttpError(
      409,
      "SLOT_BUSY",
      "This private gathering overlaps a confirmed table reservation.",
    );
  if (conflict)
    throw new HttpError(
      409,
      "SLOT_BUSY",
      "That space overlaps another held or confirmed event, including its cleanup buffer.",
    );
}

export function registerEventGuest(api, store, config, requireId) {
  api.get("/events/options", (req, res) => res.json(eventOptions));
  api.post("/events", async (req, res) => {
    const input = body(eventInput, req.body);
    const guestHash = getGuest(req, res, config);
    const existing = await store.events.findOne({
      guestHash,
      requestKey: input.requestKey,
    });
    const sameRequest = (event) => {
      if (
        !event ||
        !Object.entries(input).every(([key, value]) => event[key] === value)
      ) {
        throw new HttpError(
          409,
          "REQUEST_CHANGED",
          "This retry key was used for a different event request. Refresh the form before submitting another request.",
        );
      }
      return event;
    };
    if (existing) return res.json({ event: eventView(sameRequest(existing)) });
    const startsAt = new Date(input.date + "T" + input.time + ":00+06:00");
    const localStart = new Date(startsAt.getTime() + 6 * 3600000);
    if (
      !Number.isFinite(startsAt.getTime()) ||
      localStart.toISOString().slice(0, 10) !== input.date ||
      startsAt <= new Date() ||
      startsAt > new Date(Date.now() + 366 * 86400000)
    ) {
      throw new HttpError(
        400,
        "EVENT_DATE",
        "Select a future event date within the next year.",
      );
    }
    const space = eventOptions.spaces.find((item) => item.id === input.spaceId);
    if (input.guests > space.capacity)
      throw new HttpError(
        400,
        "CAPACITY",
        "This space has a smaller seating capacity.",
      );
    const endsAt = new Date(startsAt.getTime() + input.hours * 3600000);
    const localEndHour = new Date(endsAt.getTime() + 6 * 3600000).getUTCHours();
    if (localEndHour < 12 || localEndHour >= 23)
      throw new HttpError(
        400,
        "EVENT_HOURS",
        "The event must finish before 23:00.",
      );
    const now = new Date();
    const event = {
      _id: new ObjectId(),
      ...input,
      guestHash,
      startsAt,
      endsAt,
      blockedUntil: new Date(endsAt.getTime() + 30 * 60000),
      code: "EV-" + randomToken(5).replace(/[-_]/g, "X").toUpperCase(),
      status: "requested",
      createdAt: now,
      history: [{ status: "requested", at: now }],
    };
    try {
      await store.events.insertOne(event);
    } catch (error) {
      if (error.code !== 11000) throw error;
      return res.json({
        event: eventView(
          sameRequest(
            await store.events.findOne({
              guestHash,
              requestKey: input.requestKey,
            }),
          ),
        ),
      });
    }
    res.status(201).json({ event: eventView(event) });
  });
  api.get("/events", async (req, res) => {
    const events = await store.events
      .find({ guestHash: getGuest(req, res, config) })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    res.json({ events: events.map((event) => eventView(event)) });
  });
  api.post("/events/:id/accept", async (req, res) => {
    const id = requireId(req.params.id);
    const { version } = body(
      z.strictObject({ version: z.number().int().min(1) }),
      req.body,
    );
    const guestHash = getGuest(req, res, config);
    const result = await store.client.withSession((session) =>
      session.withTransaction(async () => {
        const event = await store.events.findOne(
          { _id: id, guestHash },
          { session },
        );
        if (!event)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "This event could not be found.",
          );
        if (event.status !== "quote_sent" || event.quote?.version !== version)
          throw new HttpError(
            409,
            "QUOTE_CHANGED",
            "This quote changed. Review the latest quote.",
          );
        if (event.quote.expiresAt <= new Date())
          throw new HttpError(
            409,
            "QUOTE_EXPIRED",
            "The quote expired. Ask the team for a new quote.",
          );
        await assertSlot(store, event, session);
        const status =
          event.quote.deposit > 0 ? "awaiting_deposit" : "confirmed";
        await store.events.updateOne(
          { _id: id },
          {
            $set: { status, acceptedVersion: version },
            $push: { history: { status, at: new Date() } },
          },
          { session },
        );
        return { ...event, status };
      }),
    );
    res.json({ event: eventView(result) });
  });
}

export function registerEventStaff(api, store, requireAdmin, requireId) {
  api.get("/events", requireAdmin, async (req, res) => {
    const events = await store.events
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    res.json({ events: events.map((event) => eventView(event, true)) });
  });
  api.post("/events/:id/quote", requireAdmin, async (req, res) => {
    const id = requireId(req.params.id);
    const input = body(quoteInput, req.body);
    const result = await store.client.withSession((session) =>
      session.withTransaction(async () => {
        const event = await store.events.findOne({ _id: id }, { session });
        if (!event)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "This event could not be found.",
          );
        if (!["requested", "reviewing", "quote_sent"].includes(event.status))
          throw new HttpError(
            409,
            "EVENT_STATE",
            "A quote can only be sent before the guest accepts it.",
          );
        if (event.startsAt <= new Date())
          throw new HttpError(409, "EVENT_DATE", "This event date has passed.");
        await assertSlot(store, event, session);
        const total =
          input.hallFee + input.perGuest * event.guests + input.extras;
        if (total <= 0)
          throw new HttpError(
            400,
            "QUOTE_TOTAL",
            "The quote total must be greater than zero.",
          );
        const quote = {
          ...input,
          total,
          deposit: Math.round((total * input.depositPercent) / 100),
          balance: total - Math.round((total * input.depositPercent) / 100),
          version: (event.quote?.version || 0) + 1,
          expiresAt: new Date(
            Math.min(
              Date.now() + input.validHours * 3600000,
              event.startsAt.getTime(),
            ),
          ),
        };
        await store.events.updateOne(
          { _id: id },
          {
            $set: { quote, status: "quote_sent" },
            $push: {
              history: {
                status: "quote_sent",
                at: new Date(),
                by: req.staff.username,
                version: quote.version,
              },
            },
          },
          { session },
        );
        return { ...event, quote, status: "quote_sent" };
      }),
    );
    res.json({ event: eventView(result, true) });
  });
  api.post("/events/:id/action", requireAdmin, async (req, res) => {
    const id = requireId(req.params.id);
    const input = body(
      z.strictObject({
        action: z.enum(["review", "decline", "deposit", "complete", "cancel"]),
        reason: z.string().trim().max(200).default(""),
        reference: z.string().trim().max(100).default(""),
        verified: z.boolean().optional(),
      }),
      req.body,
    );
    const result = await store.client.withSession((session) =>
      session.withTransaction(async () => {
        const event = await store.events.findOne({ _id: id }, { session });
        if (!event)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "This event could not be found.",
          );
        const choices = {
          review: { from: ["requested"], to: "reviewing" },
          decline: {
            from: ["requested", "reviewing", "quote_sent"],
            to: "declined",
          },
          deposit: { from: ["awaiting_deposit"], to: "confirmed" },
          complete: { from: ["confirmed"], to: "completed" },
          cancel: {
            from: ["requested", "reviewing", "quote_sent"],
            to: "cancelled",
          },
        };
        const choice = choices[input.action];
        if (!choice.from.includes(event.status))
          throw new HttpError(
            409,
            "EVENT_STATE",
            "This action is not available at the current event stage.",
          );
        if (["decline", "cancel"].includes(input.action) && !input.reason)
          throw new HttpError(
            400,
            "REASON_REQUIRED",
            "Give a reason for the guest.",
          );
        if (input.action === "deposit") {
          if (!input.verified)
            throw new HttpError(
              400,
              "VERIFY_DEPOSIT",
              "Verify the deposit at the counter before recording it.",
            );
          if (!input.reference)
            throw new HttpError(
              400,
              "REFERENCE_REQUIRED",
              "Enter the reference for the deposit you verified at the counter.",
            );
          if (event.quote.expiresAt <= new Date())
            throw new HttpError(
              409,
              "QUOTE_EXPIRED",
              "This hold expired. Review the booking before accepting funds.",
            );
          await assertSlot(store, event, session);
        }
        if (input.action === "complete" && event.endsAt > new Date())
          throw new HttpError(
            409,
            "EVENT_DATE",
            "Complete the event after its scheduled end.",
          );
        await store.events.updateOne(
          { _id: id },
          {
            $set: {
              status: choice.to,
              ...(input.action === "deposit"
                ? {
                    depositReceived: event.quote.deposit,
                    depositReference: input.reference,
                  }
                : {}),
            },
            $push: {
              history: {
                status: choice.to,
                at: new Date(),
                by: req.staff.username,
                reason: input.reason,
              },
            },
          },
          { session },
        );
        return { ...event, status: choice.to };
      }),
    );
    res.json({ event: eventView(result, true) });
  });
}
