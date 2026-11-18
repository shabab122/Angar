import { z } from "zod";
import { body, HttpError } from "./http.js";
import { ACTIONS, lockAvailableDishes, orderView } from "./orders.js";
import { getGuest, hash } from "./security.js";

const reason = z.string().trim().min(3).max(160);
const base = { expectedRevision: z.number().int().min(0), reason };
const changeInput = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("cancel"), ...base }),
  z.strictObject({
    type: z.literal("edit"),
    ...base,
    note: z.string().trim().max(200),
    lines: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(11),
          quantity: z.number().int().min(0).max(10),
        }),
      )
      .min(1)
      .max(12)
      .refine(
        (lines) =>
          new Set(lines.map((line) => line.index)).size === lines.length,
      ),
  }),
]);
const transaction = (store, task) =>
  store.client.withSession((session) =>
    session.withTransaction(() => task(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }),
  );
const editable = (order) => ["placed", "queued"].includes(order.status);
const pending = (order) => order.changeRequest?.status === "pending";

async function lockVisit(store, order, session) {
  const table = await store.tables.findOneAndUpdate(
    {
      _id: order.tableId,
      activeVisitId: order.visitId,
      billingState: { $ne: "finalized" },
    },
    { $inc: { revision: 1 } },
    { session },
  );
  if (!table)
    throw new HttpError(
      409,
      "TABLE_CLOSED",
      "This table visit has ended or its bill is finalized.",
    );
}

export async function moveOrder(store, id, action, reasonText, user) {
  const step = ACTIONS[action];
  if (step.role !== user.role)
    throw new HttpError(
      403,
      "FORBIDDEN",
      "This action belongs to a different staff role.",
    );
  if (action === "reject" && reasonText.trim().length < 3)
    throw new HttpError(
      400,
      "REASON_REQUIRED",
      "Give a reason the guest can see.",
    );
  return transaction(store, async (session) => {
    const order = await store.orders.findOne({ _id: id }, { session });
    if (!order || order.status !== step.from)
      throw new HttpError(
        409,
        "ORDER_UPDATED",
        "This order changed. Refresh the queue and try again.",
      );
    if (pending(order) && action !== "reject")
      throw new HttpError(
        409,
        "CHANGE_PENDING",
        "An administrator must review the guest's change request before this order continues.",
      );
    await lockVisit(store, order, session);
    const now = new Date();
    const set = { status: step.to, updatedAt: now };
    if (pending(order))
      set.changeRequest = {
        ...order.changeRequest,
        status: "expired",
        decidedAt: now,
        decidedBy: user.username,
        decisionReason: reasonText,
      };
    const updated = await store.orders.findOneAndUpdate(
      { _id: id },
      {
        $set: set,
        $inc: { revision: 1 },
        $push: {
          history: {
            status: step.to,
            at: now,
            by: user.username,
            ...(action === "reject" ? { reason: reasonText } : {}),
          },
        },
      },
      { session, returnDocument: "after" },
    );
    return orderView(updated, true);
  });
}

export async function cancelBeforeCooking(store, id, reasonText, user) {
  return transaction(store, async (session) => {
    const order = await store.orders.findOne({ _id: id }, { session });
    if (!order)
      throw new HttpError(404, "NOT_FOUND", "This order could not be found.");
    if (!editable(order))
      throw new HttpError(
        409,
        "ORDER_LOCKED",
        "Cancellation is only allowed before cooking starts.",
      );
    await lockVisit(store, order, session);
    const now = new Date();
    const set = { status: "cancelled", updatedAt: now };
    if (pending(order))
      set.changeRequest = {
        ...order.changeRequest,
        status: "expired",
        decisionReason: reasonText,
        decidedAt: now,
        decidedBy: user.username,
      };
    await store.orders.updateOne(
      { _id: id },
      {
        $set: set,
        $inc: { revision: 1 },
        $push: {
          history: {
            status: "cancelled",
            at: now,
            by: user.username,
            reason: reasonText,
          },
        },
      },
      { session },
    );
    await store.audit.insertOne(
      {
        type: "order.cancelled",
        orderId: id,
        by: user.username,
        reason: reasonText,
        at: now,
      },
      { session },
    );
  });
}

export function registerGuestOrderChanges(api, store, config, requireId) {
  api.post("/orders/:id/changes", async (req, res) => {
    const id = requireId(req.params.id);
    const input = body(changeInput, req.body);
    const requestId = req.get("idempotency-key");
    if (!/^[a-f0-9]{32}$/.test(requestId || ""))
      throw new HttpError(400, "INVALID_KEY", "Missing change request key.");
    const guestHash = getGuest(req, res, config);
    const fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const order = await store.orders.findOne(
        { _id: id, guestHash },
        { session },
      );
      if (!order)
        throw new HttpError(404, "NOT_FOUND", "This order could not be found.");
      if (order.changeRequest?.id === requestId) {
        if (order.changeRequest.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This request key belongs to a different change.",
          );
        return { order: orderView(order), replay: true };
      }
      if (!editable(order))
        throw new HttpError(
          409,
          "ORDER_LOCKED",
          "Changes are only allowed before cooking starts.",
        );
      if (pending(order))
        throw new HttpError(
          409,
          "CHANGE_PENDING",
          "Your previous request is still awaiting staff approval.",
        );
      if ((order.revision || 0) !== input.expectedRevision)
        throw new HttpError(
          409,
          "ORDER_UPDATED",
          "Your order changed. Refresh before requesting a change.",
        );
      if ((order.changeCount || 0) >= 20)
        throw new HttpError(
          409,
          "CHANGE_LIMIT",
          "Please ask your server for further changes.",
        );
      await lockVisit(store, order, session);
      let proposal = {};
      if (input.type === "edit") {
        const lines = [...input.lines].sort((a, b) => a.index - b.index);
        if (
          lines.length !== order.items.length ||
          lines.some((line, index) => line.index !== index)
        )
          throw new HttpError(
            400,
            "INVALID_LINES",
            "Include each existing order line exactly once.",
          );
        const items = order.items.flatMap((item, index) =>
          lines[index].quantity
            ? [
                {
                  ...item,
                  quantity: lines[index].quantity,
                  subtotal: lines[index].quantity * item.unitPrice,
                },
              ]
            : [],
        );
        if (!items.length)
          throw new HttpError(
            400,
            "EMPTY_CHANGE",
            "Use a cancellation request to remove the whole order.",
          );
        if (
          lines.every(
            (line, index) => line.quantity === order.items[index].quantity,
          ) &&
          input.note === order.note
        )
          throw new HttpError(
            400,
            "NO_CHANGE",
            "Change a quantity or kitchen note first.",
          );
        proposal = {
          items,
          note: input.note,
          total: items.reduce((total, item) => total + item.subtotal, 0),
          increasedDishIds: lines
            .filter(
              (line, index) => line.quantity > order.items[index].quantity,
            )
            .map((line) => order.items[line.index].dishId),
        };
      }
      const change = {
        id: requestId,
        fingerprint,
        type: input.type,
        reason: input.reason,
        status: "pending",
        requestedAt: new Date(),
        ...proposal,
      };
      const updated = await store.orders.findOneAndUpdate(
        { _id: id },
        {
          $set: { changeRequest: change, updatedAt: new Date() },
          $inc: { revision: 1, changeCount: 1 },
        },
        { session, returnDocument: "after" },
      );
      await store.audit.insertOne(
        {
          type: "order.change_requested",
          orderId: id,
          requestId,
          changeType: input.type,
          reason: input.reason,
          at: change.requestedAt,
        },
        { session },
      );
      return { order: orderView(updated), replay: false };
    });
    res.status(result.replay ? 200 : 201).json({ order: result.order });
  });
}

export function registerStaffOrderChanges(api, store, requireAdmin, requireId) {
  api.post(
    "/orders/:id/changes/:requestId/decision",
    requireAdmin,
    async (req, res) => {
      const input = body(
        z.strictObject({ decision: z.enum(["approve", "reject"]), reason }),
        req.body,
      );
      const id = requireId(req.params.id);
      const result = await transaction(store, async (session) => {
        const order = await store.orders.findOne({ _id: id }, { session });
        if (!order)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "This order could not be found.",
          );
        const change = order.changeRequest;
        if (!change || change.id !== req.params.requestId)
          throw new HttpError(
            409,
            "ORDER_UPDATED",
            "This request changed. Refresh the order.",
          );
        const status = input.decision === "approve" ? "approved" : "rejected";
        if (change.status !== "pending") {
          if (change.status === status) return orderView(order, true);
          throw new HttpError(
            409,
            "CHANGE_DECIDED",
            "This request already has a different decision.",
          );
        }
        if (!editable(order))
          throw new HttpError(
            409,
            "ORDER_LOCKED",
            "Cooking has already started.",
          );
        await lockVisit(store, order, session);
        if (status === "approved" && change.type === "edit")
          await lockAvailableDishes(
            store,
            change.increasedDishIds || [],
            session,
          );
        const now = new Date();
        const decided = {
          ...change,
          status,
          decidedAt: now,
          decidedBy: req.staff.username,
          decisionReason: input.reason,
        };
        const set = { changeRequest: decided, updatedAt: now };
        if (status === "approved") {
          if (change.type === "cancel") set.status = "cancelled";
          else
            Object.assign(set, {
              items: change.items,
              note: change.note,
              total: change.total,
            });
        }
        const history =
          status === "approved"
            ? {
                history: {
                  status: set.status || order.status,
                  at: now,
                  by: req.staff.username,
                  reason:
                    (change.type === "cancel"
                      ? "Cancellation approved: "
                      : "Order change approved: ") + input.reason,
                },
              }
            : {};
        const updated = await store.orders.findOneAndUpdate(
          { _id: id },
          {
            $set: set,
            $inc: { revision: 1 },
            $push: { ...history, changeHistory: decided },
          },
          { session, returnDocument: "after" },
        );
        await store.audit.insertOne(
          {
            type: "order.change_" + status,
            orderId: id,
            requestId: change.id,
            by: req.staff.username,
            reason: input.reason,
            before: {
              items: order.items,
              note: order.note,
              total: order.total,
              status: order.status,
            },
            after: {
              items: updated.items,
              note: updated.note,
              total: updated.total,
              status: updated.status,
            },
            at: now,
          },
          { session },
        );
        return orderView(updated, true);
      });
      res.json({ order: result });
    },
  );
}
