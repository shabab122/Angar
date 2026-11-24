import { z } from "zod";
import { body, HttpError } from "./http.js";
import { passwordMatches } from "./security.js";
import { transaction } from "./money.js";
import { assertStaffAction } from "./access.js";
const printerId = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
  stationId = printerId.refine((value) => value !== "general");
export function printerConfiguration(config, id = "default") {
  if (id === "default")
    return { ...config, kitchenPrinter: config.kitchenPrinter || {} };
  const profile = config.kitchenPrinters?.find((row) => row.id === id);
  if (!profile) return null;
  return {
    ...config,
    kitchenPrinter: profile,
    printerTransport: config.printerTransport
      ? (bytes) => config.printerTransport(bytes, { printerId: id })
      : undefined,
  };
}
export const printerProfiles = (config) => [
  {
    id: "default",
    name: "Default kitchen / receipt",
    ...(config.kitchenPrinter || {}),
  },
  ...(config.kitchenPrinters || []),
];
export function registerPrinterRouting(api, store, config, helpers) {
  const { printerReady, destinationHash } = helpers;
  api.get("/printing/routing", async (req, res) => {
    const saved = await store.settings.findOne({ _id: "print-routing" });
    res.json({
      enabled: Boolean(saved?.enabled),
      revision: saved?.revision || 0,
      stations: saved?.stations || [],
      printers: printerProfiles(config).map((profile) => ({
        id: profile.id,
        name: profile.name,
        configured: printerReady(printerConfiguration(config, profile.id)),
      })),
      dishes: (
        await store.dishes.find({}).sort({ name: 1 }).limit(500).toArray()
      ).map((row) => ({ id: row._id, name: row.name, category: row.category })),
    });
  });
  api.put("/printing/routing", async (req, res) => {
    const input = body(
        z.strictObject({
          enabled: z.boolean(),
          expectedRevision: z.number().int().min(0),
          stations: z
            .array(
              z.strictObject({
                id: stationId,
                name: z.string().trim().min(2).max(50),
                printerId,
                categories: z
                  .array(z.enum(["mains", "grill", "drinks", "dessert"]))
                  .max(4),
                dishIds: z
                  .array(z.string().regex(/^[a-z0-9-]{1,64}$/))
                  .max(100),
              }),
            )
            .max(8),
          currentPassword: z.string().min(1).max(128),
          reason: z.string().trim().min(3).max(160),
        }),
        req.body,
      ),
      actor = await store.staff.findOne({ _id: req.staff._id, active: true });
    if (
      !actor ||
      !(await passwordMatches(input.currentPassword, actor.passwordHash))
    )
      throw new HttpError(
        401,
        "PASSWORD_REQUIRED",
        "Re-enter the administrator password.",
      );
    const ids = input.stations.map((s) => s.id),
      categories = input.stations.flatMap((s) => s.categories),
      dishes = input.stations.flatMap((s) => s.dishIds);
    if (
      new Set(ids).size !== ids.length ||
      new Set(categories).size !== categories.length ||
      new Set(dishes).size !== dishes.length
    )
      throw new HttpError(
        400,
        "STATION_DUPLICATE",
        "Give each station a unique ID and route each category or explicit dish to only one station.",
      );
    if (input.enabled && !input.stations.length)
      throw new HttpError(
        400,
        "STATION_REQUIRED",
        "Add at least one station before enabling routing.",
      );
    for (const row of input.stations)
      if (!printerProfiles(config).some((p) => p.id === row.printerId))
        throw new HttpError(
          400,
          "PRINTER_REQUIRED",
          "Choose an operator-configured printer profile.",
        );
    await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "printing.configure", session);
      await store.settings.updateOne(
        { _id: "print-routing-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const old = await store.settings.findOne(
        { _id: "print-routing" },
        { session },
      );
      if ((old?.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "ROUTING_UPDATED",
          "Station routing changed. Reload before saving.",
        );
      if (
        dishes.length &&
        (await store.dishes.countDocuments(
          { _id: { $in: dishes } },
          { session },
        )) !== dishes.length
      )
        throw new HttpError(
          400,
          "DISH_REQUIRED",
          "Choose existing menu dishes.",
        );
      const destinationHashes = Object.fromEntries(
        printerProfiles(config).map((p) => [
          p.id,
          printerReady(printerConfiguration(config, p.id))
            ? destinationHash(printerConfiguration(config, p.id))
            : "",
        ]),
      );
      await store.settings.updateOne(
        { _id: "print-routing" },
        {
          $set: {
            enabled: input.enabled,
            stations: input.stations,
            destinationHashes,
            updatedAt: new Date(),
          },
          $inc: { revision: 1 },
        },
        { session, upsert: true },
      );
      await store.audit.insertOne(
        {
          type: "printer.routing_updated",
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ saved: true });
  });
}
export async function routedTicketGroups(store, order, session) {
  const previous = await store.printJobs.findOne(
      { sourceId: order._id, kind: "kitchen", copyOf: { $exists: false } },
      { session, sort: { sourceRevision: -1, createdAt: -1, _id: -1 } },
    ),
    saved = await store.settings.findOne({ _id: "print-routing" }, { session });
  if ((previous && !previous.routingSnapshot) || (!previous && !saved?.enabled))
    return null;
  const snapshot = structuredClone(
      previous?.routingSnapshot || {
        stations: saved.stations,
        destinationHashes: saved.destinationHashes || {},
        dishStations: {},
      },
    ),
    menu = await store.dishes
      .find(
        { _id: { $in: order.items.map((i) => i.dishId) } },
        { session, projection: { category: 1 } },
      )
      .toArray(),
    groups = new Map();
  for (const item of order.items) {
    const dish = menu.find((d) => d._id === item.dishId);
    let selected = snapshot.dishStations[item.dishId];
    if (!selected) {
      selected =
        snapshot.stations.find((s) => s.dishIds.includes(item.dishId))?.id ||
        snapshot.stations.find((s) => s.categories.includes(dish?.category))
          ?.id ||
        "general";
      snapshot.dishStations[item.dishId] = selected;
    }
    const station = snapshot.stations.find((s) => s.id === selected) || {
      id: "general",
      name: "General kitchen",
      printerId: "default",
    };
    if (!groups.has(selected)) groups.set(selected, { station, items: [] });
    groups.get(selected).items.push(item);
  }
  if (previous) {
    const cohort = await store.printJobs
      .find(
        {
          sourceId: order._id,
          kind: "kitchen",
          sourceRevision: previous.sourceRevision,
          copyOf: { $exists: false },
        },
        { session },
      )
      .toArray();
    for (const old of cohort)
      if (!groups.has(old.stationId))
        groups.set(old.stationId, {
          station: {
            id: old.stationId,
            name: old.stationName,
            printerId: old.printerId,
          },
          items: [],
        });
  }
  return { snapshot, groups: [...groups.values()] };
}
