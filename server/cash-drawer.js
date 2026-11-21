import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash } from "./security.js";
import { transaction } from "./money.js";
import { csvDocument } from "./audit-dashboard.js";

const amount = z.number().int().min(0).max(1_000_000_000),
  reason = z.string().trim().min(3).max(160),
  requestKey = z.string().regex(/^[a-f0-9]{32}$/);
const view = (row) =>
  row
    ? {
        id: String(row._id),
        code: row.code,
        status: row.status,
        openingMinor: row.openingMinor,
        expectedMinor: row.expectedMinor,
        cashInMinor: row.cashInMinor,
        cashOutMinor: row.cashOutMinor,
        countedMinor: row.countedMinor ?? null,
        varianceMinor: row.varianceMinor ?? null,
        openedBy: row.openedBy,
        closedBy: row.closedBy || "",
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        reason: row.reason,
        closingReason: row.closingReason || "",
        revision: row.revision || 0,
        review: row.review || null,
      }
    : null;

// Every cash receipt/return and shift boundary writes this register in the same
// business transaction, so a close cannot omit a concurrent verified payment.
export async function recordCash(store, input, session) {
  if (!Number.isSafeInteger(input.deltaMinor) || !input.deltaMinor)
    throw new HttpError(400, "CASH_AMOUNT", "Use a nonzero exact cash amount.");
  const prior = await store.cashMovements.findOne(
    { _id: input.key },
    { session },
  );
  if (prior) {
    if (prior.deltaMinor !== input.deltaMinor || prior.kind !== input.kind)
      throw new HttpError(
        409,
        "REQUEST_REUSED",
        "This cash reference was already recorded differently.",
      );
    return prior;
  }
  const register = await store.cashRegisters.findOneAndUpdate(
    { _id: "main" },
    { $inc: { revision: 1 } },
    { upsert: true, session, returnDocument: "after" },
  );
  let shift = null;
  if (register.activeShiftId) {
    shift = await store.cashShifts.findOneAndUpdate(
      { _id: register.activeShiftId, status: "open" },
      {
        $inc: {
          expectedMinor: input.deltaMinor,
          [input.deltaMinor > 0 ? "cashInMinor" : "cashOutMinor"]: Math.abs(
            input.deltaMinor,
          ),
          revision: 1,
        },
      },
      { session, returnDocument: "after" },
    );
    if (!shift)
      throw new HttpError(
        409,
        "SHIFT_CHANGED",
        "Refresh the cash drawer before recording this money.",
      );
    if (input.requireFunds && shift.expectedMinor < 0)
      throw new HttpError(
        409,
        "CASH_LOW",
        "The open drawer does not have enough recorded cash. Record an actual cash top-up or use another payment channel.",
      );
  }
  const row = {
    _id: input.key,
    shiftId: shift?._id || null,
    kind: input.kind,
    deltaMinor: input.deltaMinor,
    by: input.by || "system",
    reference: input.reference || "",
    reason: input.reason || "",
    sourceId: String(input.sourceId || ""),
    at: new Date(),
    balanceMinor: shift?.expectedMinor ?? null,
  };
  await store.cashMovements.insertOne(row, { session });
  return row;
}
const movementView = (row) => ({
  id: row._id,
  kind: row.kind,
  deltaMinor: row.deltaMinor,
  by: row.by,
  reference: row.reference,
  reason: row.reason,
  sourceId: row.sourceId,
  at: row.at,
  balanceMinor: row.balanceMinor,
});

export function registerCashDrawer(
  api,
  store,
  billingRoles,
  requireAdmin,
  requireId,
) {
  api.get("/cash-drawer", billingRoles, async (req, res) => {
    const register = await store.cashRegisters.findOne({ _id: "main" }),
      recent = await store.cashShifts
        .find({})
        .sort({ openedAt: -1 })
        .limit(30)
        .toArray();
    const active = register?.activeShiftId
      ? await store.cashShifts.findOne({
          _id: register.activeShiftId,
          status: "open",
        })
      : null;
    const unassigned = await store.cashMovements
      .find({ shiftId: null })
      .sort({ at: -1 })
      .limit(30)
      .toArray();
    res.json({
      active: view(active),
      shifts: recent.map(view),
      unassigned: unassigned.map(movementView),
    });
  });
  api.get("/cash-drawer/:id", billingRoles, async (req, res) => {
    const row = await store.cashShifts.findOne({
      _id: requireId(req.params.id),
    });
    if (!row) throw new HttpError(404, "NOT_FOUND", "Shift not found.");
    const movements = await store.cashMovements
      .find({ shiftId: row._id })
      .sort({ at: 1, _id: 1 })
      .limit(500)
      .toArray();
    res.json({
      shift: view(row),
      movements: movements.map(movementView),
      more: movements.length === 500,
    });
  });
  api.get("/cash-drawer/:id/export.csv", billingRoles, async (req, res) => {
    const row = await store.cashShifts.findOne({
      _id: requireId(req.params.id),
    });
    if (!row) throw new HttpError(404, "NOT_FOUND", "Shift not found.");
    const rows = await store.cashMovements
      .find({ shiftId: row._id })
      .sort({ at: 1, _id: 1 })
      .limit(10001)
      .toArray();
    if (rows.length > 10000)
      throw new HttpError(
        409,
        "EXPORT_LIMIT",
        "This shift exceeds the 10,000 movement export limit.",
      );
    res
      .type("text/csv")
      .attachment(row.code + ".csv")
      .send(
        csvDocument([
          ["Shift", row.code],
          ["Opening BDT", row.openingMinor / 100],
          ["Expected BDT", row.expectedMinor / 100],
          [
            "Counted BDT",
            row.countedMinor === undefined ? "" : row.countedMinor / 100,
          ],
          [
            "Variance BDT",
            row.varianceMinor === undefined ? "" : row.varianceMinor / 100,
          ],
          [],
          [
            "Time (UTC)",
            "Kind",
            "Cash change BDT",
            "Actor",
            "Source",
            "Reference",
            "Reason",
          ],
          ...rows.map((item) => [
            item.at.toISOString(),
            item.kind,
            item.deltaMinor / 100,
            item.by,
            item.sourceId,
            item.reference,
            item.reason,
          ]),
        ]),
      );
  });
  api.post("/cash-drawer/open", billingRoles, async (req, res) => {
    const input = body(
        z.strictObject({
          openingMinor: amount,
          reason,
          verified: z.literal(true),
          requestKey,
        }),
        req.body,
      ),
      fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const previous = await store.cashShifts.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another shift.",
          );
        return previous;
      }
      const register = await store.cashRegisters.findOneAndUpdate(
        { _id: "main" },
        { $inc: { revision: 1 } },
        { session, upsert: true, returnDocument: "after" },
      );
      if (register.activeShiftId)
        throw new HttpError(
          409,
          "SHIFT_OPEN",
          "Close the current shared cash drawer before starting another shift.",
        );
      const id = new ObjectId(),
        row = {
          _id: id,
          code: "CS-" + id.toString().slice(-10).toUpperCase(),
          status: "open",
          openingMinor: input.openingMinor,
          expectedMinor: input.openingMinor,
          cashInMinor: 0,
          cashOutMinor: 0,
          openedAt: new Date(),
          openedBy: req.staff.username,
          reason: input.reason,
          revision: 0,
          requestKey: input.requestKey,
          fingerprint,
        };
      await store.cashShifts.insertOne(row, { session });
      await store.cashRegisters.updateOne(
        { _id: "main" },
        { $set: { activeShiftId: id } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "cash.shift_opened",
          shiftId: id,
          amountMinor: input.openingMinor,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ shift: view(result) });
  });
  api.post("/cash-drawer/movements", billingRoles, async (req, res) => {
    const input = body(
      z.strictObject({
        direction: z.enum(["in", "out"]),
        amountMinor: amount.min(1),
        reason,
        reference: z.string().trim().max(80).default(""),
        verified: z.literal(true),
        requestKey,
      }),
      req.body,
    );
    const fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const old = await store.cashMovements.findOne(
        { _id: "manual:" + input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another movement.",
          );
        return old;
      }
      const register = await store.cashRegisters.findOneAndUpdate(
        { _id: "main" },
        { $inc: { revision: 1 } },
        { session, upsert: true, returnDocument: "after" },
      );
      if (!register.activeShiftId)
        throw new HttpError(
          409,
          "SHIFT_REQUIRED",
          "Open a cash shift before recording a manual top-up or withdrawal.",
        );
      const row = await recordCash(
        store,
        {
          key: "manual:" + input.requestKey,
          deltaMinor: (input.direction === "in" ? 1 : -1) * input.amountMinor,
          kind: input.direction === "in" ? "cash_top_up" : "cash_withdrawal",
          by: req.staff.username,
          reason: input.reason,
          reference: input.reference,
          requireFunds: true,
        },
        session,
      );
      await store.cashMovements.updateOne(
        { _id: row._id },
        { $set: { fingerprint } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "cash.manual_movement",
          shiftId: row.shiftId,
          amountMinor: row.deltaMinor,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ movement: movementView(result) });
  });
  api.post("/cash-drawer/:id/close", billingRoles, async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: z.number().int().min(0),
          countedMinor: amount,
          reason,
          verified: z.literal(true),
          requestKey,
        }),
        req.body,
      ),
      id = requireId(req.params.id),
      fingerprint = hash(JSON.stringify(input));
    const result = await transaction(store, async (session) => {
      const register = await store.cashRegisters.findOneAndUpdate(
        { _id: "main" },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      const row = await store.cashShifts.findOne({ _id: id }, { session });
      if (row?.closeKey === input.requestKey) {
        if (row.closeFingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another closing count.",
          );
        return row;
      }
      if (
        !row ||
        row.status !== "open" ||
        !register?.activeShiftId?.equals(id) ||
        row.revision !== input.expectedRevision
      )
        throw new HttpError(
          409,
          "SHIFT_UPDATED",
          "Cash activity changed. Refresh and count the drawer again before closing.",
        );
      const changes = {
        status: "closed",
        closedAt: new Date(),
        closedBy: req.staff.username,
        countedMinor: input.countedMinor,
        varianceMinor: input.countedMinor - row.expectedMinor,
        closingReason: input.reason,
        closeKey: input.requestKey,
        closeFingerprint: fingerprint,
      };
      await store.cashShifts.updateOne(
        { _id: id },
        { $set: changes, $inc: { revision: 1 } },
        { session },
      );
      await store.cashRegisters.updateOne(
        { _id: "main" },
        { $set: { activeShiftId: null } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "cash.shift_closed",
          shiftId: id,
          amountMinor: changes.varianceMinor,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { ...row, ...changes, revision: row.revision + 1 };
    });
    res.json({ shift: view(result) });
  });
  api.post("/cash-drawer/:id/review", requireAdmin, async (req, res) => {
    const input = body(z.strictObject({ reason }), req.body),
      id = requireId(req.params.id);
    await transaction(store, async (session) => {
      const row = await store.cashShifts.findOneAndUpdate(
        { _id: id, status: "closed", review: { $exists: false } },
        {
          $set: {
            review: {
              reason: input.reason,
              by: req.staff.username,
              at: new Date(),
            },
          },
        },
        { session },
      );
      if (!row)
        throw new HttpError(
          409,
          "SHIFT_STATE",
          "Only an unreviewed closed shift can be reviewed.",
        );
      await store.audit.insertOne(
        {
          type: "cash.variance_reviewed",
          shiftId: id,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
    });
    res.json({ reviewed: true });
  });
}
