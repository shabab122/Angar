import { z } from "zod";
import { body, HttpError } from "./http.js";
import { getTableCookie } from "./security.js";

export function serviceRequestView(request, staff = false) {
  return {
    id: request._id.toString(),
    tableNumber: request.tableNumber,
    type: request.type,
    note: request.note,
    status:
      request.status === "open" && request.acknowledgedAt
        ? "acknowledged"
        : request.status,
    createdAt: request.createdAt,
    acknowledgedAt: request.acknowledgedAt || null,
    resolvedAt: request.resolvedAt || null,
    ...(staff
      ? {
          acknowledgedBy: request.acknowledgedBy || "",
          resolvedBy: request.resolvedBy || "",
        }
      : {}),
  };
}

async function activeTable(req, store, session, lock = false) {
  const context = getTableCookie(req);
  if (!context?.visitId)
    throw new HttpError(
      409,
      "TABLE_REQUIRED",
      "Scan your active table code first.",
    );
  const filter = { _id: context.tableId, activeVisitId: context.visitId };
  const table = lock
    ? await store.tables.findOneAndUpdate(
        filter,
        { $inc: { revision: 1 } },
        { session },
      )
    : await store.tables.findOne(filter);
  if (!table)
    throw new HttpError(409, "TABLE_CLOSED", "This table visit has ended.");
  return { table, context };
}

export function registerGuestServiceRequests(api, store) {
  api.get("/service-requests", async (req, res) => {
    const { table, context } = await activeTable(req, store);
    const requests = await store.serviceRequests
      .find({ tableId: table._id, visitId: context.visitId })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    res.json({
      requests: requests.map((request) => serviceRequestView(request)),
    });
  });
  api.post("/service-requests", async (req, res) => {
    const input = body(
      z.strictObject({
        type: z.enum(["waiter", "bill", "issue"]),
        note: z.string().trim().max(200).default(""),
      }),
      req.body,
    );
    const request = await store.client.withSession((session) =>
      session.withTransaction(
        async () => {
          const { table, context } = await activeTable(
            req,
            store,
            session,
            true,
          );
          const filter = {
            tableId: table._id,
            visitId: context.visitId,
            type: input.type,
            status: "open",
          };
          // Table-level deduplication also covers two phones tapping at once.
          return store.serviceRequests.findOneAndUpdate(
            filter,
            {
              $setOnInsert: {
                ...filter,
                tableNumber: table.number,
                note: input.note,
                createdAt: new Date(),
              },
            },
            { session, upsert: true, returnDocument: "after" },
          );
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
      ),
    );
    res
      .status(201)
      .json({ status: "open", request: serviceRequestView(request) });
  });
}

export function registerStaffServiceRequests(
  api,
  store,
  floorRoles,
  requireId,
) {
  api.get("/service-requests", floorRoles, async (req, res) => {
    const tables = await store.tables
      .find(
        { activeVisitId: { $type: "objectId" } },
        { projection: { activeVisitId: 1 } },
      )
      .toArray();
    const rows = await store.serviceRequests
      .find({
        status: "open",
        visitId: { $in: tables.map((table) => table.activeVisitId) },
      })
      .sort({ createdAt: 1 })
      .limit(120)
      .toArray();
    res.json({
      requests: rows.map((request) => serviceRequestView(request, true)),
    });
  });
  for (const action of ["acknowledge", "resolve"]) {
    api.post(
      "/service-requests/:id/" + action,
      floorRoles,
      async (req, res) => {
        const id = requireId(req.params.id);
        const now = new Date();
        const set =
          action === "acknowledge"
            ? { acknowledgedBy: req.staff.username, acknowledgedAt: now }
            : {
                status: "resolved",
                resolvedBy: req.staff.username,
                resolvedAt: now,
              };
        const filter = {
          _id: id,
          status: "open",
          ...(action === "acknowledge"
            ? { acknowledgedAt: { $exists: false } }
            : {}),
        };
        const changed = await store.serviceRequests.updateOne(filter, {
          $set: set,
        });
        if (!changed.matchedCount) {
          const current = await store.serviceRequests.findOne({ _id: id });
          if (!current)
            throw new HttpError(
              404,
              "NOT_FOUND",
              "This request could not be found.",
            );
          if (action === "acknowledge" && current.status !== "open")
            throw new HttpError(
              409,
              "REQUEST_RESOLVED",
              "This request has already been resolved.",
            );
        }
        res.status(204).end();
      },
    );
  }
}
