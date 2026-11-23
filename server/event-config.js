import { z } from "zod";
import { eventOptions } from "./event-defaults.js";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";
const id = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  text = (max) => z.string().trim().max(max);
export const spaceSnapshot = (row) => ({
  id: row.id,
  name: row.name,
  capacity: row.capacity,
  minGuests: row.minGuests ?? 8,
  description: row.description || "",
  resourceIds:
    row.resourceIds ||
    (row.id === "dining-room" ? ["dining-room", "family-corner"] : [row.id]),
  blocksDining: row.blocksDining !== false,
});
export const eventDefaults = () => ({
  revision: 0,
  spaces: eventOptions.spaces.map((row) => ({
    ...spaceSnapshot(row),
    active: true,
  })),
  packages: eventOptions.packages.map((row) => ({
    ...row,
    active: true,
    hallFee: 0,
    depositPercent: 0,
  })),
});
export async function readEventConfiguration(store, session) {
  const row = await store.settings.findOne(
    { _id: "event-options" },
    { session },
  );
  return row
    ? { revision: row.revision, spaces: row.spaces, packages: row.packages }
    : eventDefaults();
}
const input = z.strictObject({
  expectedRevision: z.number().int().min(0),
  reason: text(160).min(3),
  spaces: z
    .array(
      z.strictObject({
        id,
        name: text(80).min(2),
        description: text(300),
        capacity: z.number().int().min(1).max(500),
        minGuests: z.number().int().min(1).max(500),
        resourceIds: z
          .array(id)
          .min(1)
          .max(12)
          .refine((v) => new Set(v).size === v.length),
        blocksDining: z.boolean(),
        active: z.boolean(),
      }),
    )
    .min(1)
    .max(12),
  packages: z
    .array(
      z.strictObject({
        id,
        name: text(80).min(2),
        description: text(500),
        perGuest: z.number().int().min(0).max(10000).nullable(),
        hallFee: z.number().int().min(0).max(500000),
        depositPercent: z.number().int().min(0).max(100),
        active: z.boolean(),
      }),
    )
    .min(1)
    .max(12),
});
export function registerEventConfiguration(api, store, requireAdmin) {
  api.get("/event-config", requireAdmin, async (req, res) =>
    res.json({ configuration: await readEventConfiguration(store) }),
  );
  api.put("/event-config", requireAdmin, async (req, res) => {
    const value = body(input, req.body);
    for (const rows of [value.spaces, value.packages])
      if (
        new Set(rows.map((r) => r.id)).size !== rows.length ||
        !rows.some((r) => r.active)
      )
        throw new HttpError(
          400,
          "EVENT_CONFIG",
          "Use unique codes and keep an active space and package.",
        );
    if (value.spaces.some((row) => row.minGuests > row.capacity))
      throw new HttpError(
        400,
        "CAPACITY",
        "Minimum party size cannot exceed capacity.",
      );
    await transaction(store, async (session) => {
      await store.eventLocks.updateOne(
        { _id: "dhanmondi-dining" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const old = await readEventConfiguration(store, session);
      if (old.revision !== value.expectedRevision)
        throw new HttpError(
          409,
          "EVENT_CONFIG_CHANGED",
          "Another administrator edited these options. Refresh first.",
        );
      const holds = await store.events
        .find(
          {
            blockedUntil: { $gt: new Date() },
            $or: [
              { status: "confirmed" },
              {
                status: { $in: ["quote_sent", "awaiting_deposit"] },
                "quote.expiresAt": { $gt: new Date() },
              },
            ],
          },
          { session },
        )
        .toArray();
      for (const event of holds) {
        const before =
          event.space ||
          spaceSnapshot(
            old.spaces.find((s) => s.id === event.spaceId) || {
              id: event.spaceId,
              capacity: 60,
            },
          );
        const after = value.spaces.find((s) => s.id === event.spaceId);
        if (
          !after ||
          after.capacity < event.guests ||
          JSON.stringify([...after.resourceIds].sort()) !==
            JSON.stringify([...before.resourceIds].sort()) ||
          after.blocksDining !== before.blocksDining
        )
          throw new HttpError(
            409,
            "EVENT_HELD",
            "A future held or confirmed event uses this space. Keep its resources and sufficient capacity; archive it to stop new requests.",
          );
      }
      await store.settings.updateOne(
        { _id: "event-options" },
        {
          $set: {
            spaces: value.spaces,
            packages: value.packages,
            revision: old.revision + 1,
          },
        },
        { upsert: true, session },
      );
      await store.audit.insertOne(
        {
          type: "event.configuration_updated",
          before: old,
          after: { spaces: value.spaces, packages: value.packages },
          by: req.staff.username,
          reason: value.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ configuration: await readEventConfiguration(store) });
  });
}
