import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { hash, passwordMatches } from "./security.js";
import { transaction } from "./money.js";
import {
  isPlatformAdmin,
  identityStaff,
  hasPermission,
  assertStaffAction,
} from "./access.js";
import { getBranchRuntime } from "./branches.js";
import { moveInventoryValue, ratioMinor } from "./inventory-cost.js";
import {
  orderBatchChange,
  addIngredientBatch,
  stockDay,
  stockLimit,
} from "./ingredient-batches.js";
const code = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
  id = z.string().regex(/^[a-f0-9]{24}$/),
  key = z.string().regex(/^[a-f0-9]{32}$/),
  reason = z.string().trim().min(3).max(160),
  revision = z.number().int().min(0);
const line = z.strictObject({
  sourceIngredientId: id,
  targetIngredientId: id,
  quantity: z.number().int().min(1).max(stockLimit),
});
const rootOf = (store) => store.rootStore || store;
const runtimeOf = (store, config) => getBranchRuntime(rootOf(store), config);
function view(row, staff) {
  const money = hasPermission(staff, "finance.view");
  return {
    id: String(row._id),
    code: row.code,
    fromBranch: row.fromBranch,
    toBranch: row.toBranch,
    fromName: row.fromName,
    toName: row.toName,
    status: row.status,
    revision: row.revision,
    reason: row.reason,
    createdAt: row.createdAt,
    approvedBy: row.approvedBy || "",
    dispatchedAt: row.dispatchedAt || null,
    completedAt: row.completedAt || null,
    needsRecovery: Boolean(row.needsRecovery),
    history: row.history || [],
    lines: row.lines.map((item) => ({
      sourceIngredientId: item.sourceIngredientId,
      targetIngredientId: item.targetIngredientId,
      sourceName: item.sourceName,
      targetName: item.targetName,
      unit: item.unit,
      quantity: item.quantity,
      receivedQuantity: item.receivedQuantity || 0,
      batchTracked: item.batchTracked,
      lots: (item.lots || []).map((lot) => ({ ...lot })),
      ...(money
        ? {
            cost: item.cost || null,
            receivedValueMinor: item.receivedValueMinor || 0,
          }
        : {}),
    })),
  };
}
function checkPair(source, target) {
  if (
    !source ||
    !target ||
    source.active === false ||
    target.active === false ||
    source.unit !== target.unit ||
    Boolean(source.batchTracked) !== Boolean(target.batchTracked)
  )
    throw new HttpError(
      409,
      "TRANSFER_INGREDIENTS",
      "Use active source and destination ingredients with the same unit and batch-tracking mode.",
    );
}
const audit = async (store, row, type, staff, why, session) => {
  await store.audit.insertOne(
    {
      type: "stock_transfer." + type,
      transferId: row._id,
      fromBranch: row.fromBranch,
      toBranch: row.toBranch,
      by: staff.username,
      reason: why,
      at: new Date(),
    },
    { session },
  );
};
export function registerStockTransfers(api, store, config, requireId) {
  const root = rootOf(store),
    runtime = runtimeOf(store, config),
    current = store.branchId || "main";
  api.get("/stock-transfers/options", async (req, res) => {
    if (!hasPermission(req.staff, "transfers.request"))
      throw new HttpError(
        403,
        "PERMISSION_DENIED",
        "Transfer request access is required to view destination ingredient names.",
      );
    const branches = await runtime.all();
    let target = [];
    if (req.query.to !== undefined) {
      const slug = body(code, req.query.to);
      if (slug === current)
        throw new HttpError(
          400,
          "TRANSFER_BRANCH",
          "Choose another destination branch.",
        );
      const other = await runtime.get(slug);
      target = await other.store.ingredients
        .find(
          { active: { $ne: false } },
          { projection: { name: 1, unit: 1, batchTracked: 1 } },
        )
        .sort({ name: 1 })
        .limit(500)
        .toArray();
    }
    const source = await store.ingredients
      .find({ active: { $ne: false } })
      .sort({ name: 1 })
      .limit(500)
      .toArray();
    res.json({
      branchId: current,
      branches: branches
        .filter((row) => row._id !== current)
        .map((row) => ({ id: row._id, name: row.name })),
      source: source.map((row) => ({
        id: String(row._id),
        name: row.name,
        unit: row.unit,
        stock: row.stock,
        batchTracked: Boolean(row.batchTracked),
      })),
      target: target.map((row) => ({
        id: String(row._id),
        name: row.name,
        unit: row.unit,
        batchTracked: Boolean(row.batchTracked),
      })),
    });
  });
  api.get("/stock-transfers", async (req, res) => {
    const rows = await store.transfers
      .find({ $or: [{ fromBranch: current }, { toBranch: current }] })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    res.json({
      branchId: current,
      transfers: rows.map((row) => view(row, req.staff)),
    });
  });
  api.post("/stock-transfers", async (req, res) => {
    const input = body(
      z.strictObject({
        toBranch: code,
        lines: z
          .array(line)
          .min(1)
          .max(30)
          .refine(
            (rows) =>
              new Set(rows.map((row) => row.sourceIngredientId)).size ===
                rows.length &&
              new Set(rows.map((row) => row.targetIngredientId)).size ===
                rows.length,
          ),
        reason,
        requestKey: key,
      }),
      req.body,
    );
    if (input.toBranch === current)
      throw new HttpError(
        400,
        "TRANSFER_BRANCH",
        "Source and destination must be different branches.",
      );
    const destination = await runtime.get(input.toBranch),
      source = await runtime.get(current),
      fingerprint = hash(JSON.stringify(input));
    const row = await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "transfers.request", session);
      await store.identitySettings.updateOne(
        { _id: "transfer-setup-lock" },
        { $inc: { revision: 1 } },
        { session, upsert: true },
      );
      const old = await store.transfers.findOne(
        { fromBranch: current, requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to a different transfer request.",
          );
        return old;
      }
      const lines = [];
      for (const item of input.lines) {
        const a = await store.ingredients.findOne(
            { _id: new ObjectId(item.sourceIngredientId) },
            { session },
          ),
          b = await destination.store.ingredients.findOne(
            { _id: new ObjectId(item.targetIngredientId) },
            { session },
          );
        checkPair(a, b);
        lines.push({
          ...item,
          sourceName: a.name,
          targetName: b.name,
          unit: a.unit,
          batchTracked: Boolean(a.batchTracked),
          receivedQuantity: 0,
          receivedValueMinor: 0,
          lots: [],
        });
      }
      const transferId = new ObjectId(),
        row = {
          _id: transferId,
          code: "TR-" + String(transferId).toUpperCase(),
          fromBranch: current,
          toBranch: input.toBranch,
          fromName: source.branch.name,
          toName: destination.branch.name,
          lines,
          status: "requested",
          revision: 0,
          reason: input.reason,
          requestKey: input.requestKey,
          fingerprint,
          createdAt: new Date(),
          history: [
            {
              status: "requested",
              by: req.staff.username,
              at: new Date(),
              reason: input.reason,
            },
          ],
          receipts: [],
        };
      await store.transfers.insertOne(row, { session });
      await audit(store, row, "requested", req.staff, input.reason, session);
      return row;
    });
    res.status(201).json({ transfer: view(row, req.staff) });
  });
  api.post("/stock-transfers/:id/action", async (req, res) => {
    const input = body(
        z.strictObject({
          action: z.enum(["approve", "reject", "cancel", "dispatch"]),
          expectedRevision: revision,
          reason,
          verified: z.boolean().default(false),
        }),
        req.body,
      ),
      transferId = requireId(req.params.id),
      initial = await store.transfers.findOne({
        _id: transferId,
        $or: [{ fromBranch: current }, { toBranch: current }],
      });
    if (!initial)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Transfer not found in this branch.",
      );
    if (initial.fromBranch !== current)
      throw new HttpError(
        403,
        "TRANSFER_SOURCE",
        "The source branch approves, cancels or dispatches this transfer.",
      );
    const destination = await runtime.get(initial.toBranch);
    const result = await transaction(store, async (session) => {
      await assertStaffAction(
        store,
        req.staff,
        input.action === "dispatch"
          ? "transfers.dispatch"
          : "transfers.approve",
        session,
      );
      const row = await store.transfers.findOneAndUpdate(
        {
          _id: transferId,
          fromBranch: current,
          revision: input.expectedRevision,
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "TRANSFER_UPDATED",
          "This transfer changed. Refresh before continuing.",
        );
      if (row.needsRecovery)
        throw new HttpError(
          409,
          "TRANSFER_RECOVERY",
          "This transfer was restored. Reconcile its physical stock before further processing.",
        );
      let status;
      if (input.action === "approve") {
        if (row.status !== "requested")
          throw new HttpError(
            409,
            "TRANSFER_STATE",
            "Approve an unchanged pending transfer.",
          );
        status = "approved";
        row.approvedBy = req.staff.username;
      }
      if (input.action === "reject") {
        if (row.status !== "requested")
          throw new HttpError(
            409,
            "TRANSFER_STATE",
            "Reject only a pending transfer.",
          );
        status = "rejected";
      }
      if (input.action === "cancel") {
        if (!["requested", "approved"].includes(row.status))
          throw new HttpError(
            409,
            "TRANSFER_STATE",
            "Dispatched goods cannot be silently returned to stock. Count and receive them at the destination.",
          );
        status = "cancelled";
      }
      if (input.action === "dispatch") {
        if (row.status !== "approved" || !input.verified)
          throw new HttpError(
            409,
            "TRANSFER_STATE",
            "Approve the transfer and verify the actual goods before dispatch.",
          );
        for (let index = 0; index < row.lines.length; index++) {
          const item = row.lines[index],
            a = await store.ingredients.findOneAndUpdate(
              {
                _id: new ObjectId(item.sourceIngredientId),
                stock: { $gte: item.quantity },
              },
              { $inc: { stock: -item.quantity, revision: 1 } },
              { session, returnDocument: "after" },
            ),
            b = await destination.store.ingredients.findOneAndUpdate(
              { _id: new ObjectId(item.targetIngredientId) },
              { $inc: { transferRevision: 1 } },
              { session, returnDocument: "after" },
            );
          if (!a)
            throw new HttpError(
              409,
              "TRANSFER_STOCK_LOW",
              "The source no longer has enough available stock.",
            );
          checkPair(a, b);
          if (Boolean(a.batchTracked) !== item.batchTracked)
            throw new HttpError(
              409,
              "TRANSFER_INGREDIENTS",
              "Ingredient tracking changed after approval. Cancel this request and review its replacements.",
            );
          item.cost = await moveInventoryValue(
            store,
            a,
            -item.quantity,
            session,
          );
          const lots = await orderBatchChange(
            store,
            a,
            -item.quantity,
            [],
            session,
            row,
          );
          item.lots = lots.length
            ? lots.map((lot) => ({
                key: lot.batchId,
                code: lot.code,
                expiresOn: lot.expiresOn,
                quantity: lot.quantity,
                received: 0,
              }))
            : [
                {
                  key: "bulk",
                  code: null,
                  expiresOn: null,
                  quantity: item.quantity,
                  received: 0,
                },
              ];
          if (row.lines.reduce((sum, line) => sum + line.lots.length, 0) > 100)
            throw new HttpError(
              409,
              "TRANSFER_LOT_LIMIT",
              "Split this request into transfers of at most 100 source batches.",
            );
          await store.stockMovements.insertOne(
            {
              key: "transfer:" + row._id + ":dispatch:" + index,
              kind: "transfer_out",
              transferId: row._id,
              ingredientId: a._id,
              ingredientName: a.name,
              unit: a.unit,
              delta: -item.quantity,
              balance: a.stock,
              cost: item.cost,
              batchAllocations: lots,
              by: req.staff.username,
              reason: input.reason,
              at: new Date(),
            },
            { session },
          );
          await store.transferEntries.insertOne(
            {
              _id: String(row._id) + ":dispatch:" + index,
              transferId: row._id,
              direction: "out",
              otherBranch: row.toBranch,
              ingredientId: a._id,
              quantity: item.quantity,
              cost: item.cost,
              lots: item.lots,
              at: new Date(),
            },
            { session },
          );
        }
        status = "dispatched";
        row.dispatchedAt = new Date();
      }
      const history = {
        status,
        by: req.staff.username,
        reason: input.reason,
        at: new Date(),
      };
      await store.transfers.updateOne(
        { _id: row._id },
        {
          $set: {
            status,
            lines: row.lines,
            approvedBy: row.approvedBy || "",
            ...(row.dispatchedAt ? { dispatchedAt: row.dispatchedAt } : {}),
          },
          $push: { history },
        },
        { session },
      );
      await audit(store, row, status, req.staff, input.reason, session);
      return { ...row, status, history: [...row.history, history] };
    });
    res.json({ transfer: view(result, req.staff) });
  });
  api.post("/stock-transfers/:id/receive", async (req, res) => {
    const input = body(
        z.strictObject({
          expectedRevision: revision,
          requestKey: key,
          reason,
          verified: z.literal(true),
          acceptQuarantine: z.boolean().default(false),
          items: z
            .array(
              z.strictObject({
                lineIndex: z.number().int().min(0).max(29),
                lotKey: z.string().min(1).max(30),
                quantity: z.number().int().min(1).max(stockLimit),
              }),
            )
            .min(1)
            .max(100)
            .refine(
              (items) =>
                new Set(items.map((i) => i.lineIndex + ":" + i.lotKey)).size ===
                items.length,
            ),
        }),
        req.body,
      ),
      fingerprint = hash(
        JSON.stringify({ ...input, expectedRevision: undefined }),
      ),
      transferId = requireId(req.params.id);
    const result = await transaction(store, async (session) => {
      await assertStaffAction(store, req.staff, "transfers.receive", session);
      const row = await store.transfers.findOneAndUpdate(
        { _id: transferId, toBranch: current },
        { $inc: { receiptRevision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          404,
          "NOT_FOUND",
          "Incoming transfer not found in this branch.",
        );
      const old = row.receipts?.find((r) => r.requestKey === input.requestKey);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another physical receipt.",
          );
        return row;
      }
      if (row.needsRecovery)
        throw new HttpError(
          409,
          "TRANSFER_RECOVERY",
          "Reconcile this restored transfer before accepting goods.",
        );
      if (
        row.status !== "dispatched" ||
        row.revision !== input.expectedRevision
      )
        throw new HttpError(
          409,
          "TRANSFER_UPDATED",
          "Receive an unchanged dispatched transfer. Refresh first.",
        );
      const changes = new Map();
      for (const received of input.items) {
        const item = row.lines[received.lineIndex],
          lot = item?.lots.find((l) => l.key === received.lotKey);
        if (!item || !lot || received.quantity > lot.quantity - lot.received)
          throw new HttpError(
            400,
            "TRANSFER_QUANTITY",
            "Count only the outstanding quantity of a dispatched batch.",
          );
        lot.received += received.quantity;
        changes.set(
          received.lineIndex,
          (changes.get(received.lineIndex) || 0) + received.quantity,
        );
      }
      for (const [index, quantity] of changes) {
        const item = row.lines[index],
          afterQuantity = item.receivedQuantity + quantity,
          nextValue = ratioMinor(
            item.cost.amountMinor,
            afterQuantity,
            item.quantity,
          ),
          deltaValue = nextValue - item.receivedValueMinor;
        const ingredient = await store.ingredients.findOneAndUpdate(
          {
            _id: new ObjectId(item.targetIngredientId),
            stock: { $lte: stockLimit - quantity },
            unit: item.unit,
            batchTracked: item.batchTracked ? true : { $ne: true },
          },
          { $inc: { stock: quantity, revision: 1 } },
          { session, returnDocument: "after" },
        );
        if (!ingredient)
          throw new HttpError(
            409,
            "TRANSFER_DESTINATION",
            "Destination stock or ingredient settings changed. Review the ingredient before receipt.",
          );
        const cost = await moveInventoryValue(
          store,
          ingredient,
          quantity,
          session,
          {
            amountMinor: deltaValue,
            knownQuantity: item.cost.complete ? quantity : 0,
          },
        );
        const allocation = [];
        for (const received of input.items.filter(
          (i) => i.lineIndex === index,
        )) {
          const lot = item.lots.find((l) => l.key === received.lotKey),
            expired = lot.expiresOn && lot.expiresOn < stockDay();
          if (expired && !input.acceptQuarantine)
            throw new HttpError(
              409,
              "TRANSFER_EXPIRED",
              "A received batch expired in transit. Explicitly accept it into quarantine or ask a manager to review the physical goods.",
            );
          if (item.batchTracked) {
            const batch = await addIngredientBatch(
              store,
              ingredient,
              received.quantity,
              {
                code:
                  row.code +
                  "-" +
                  (index + 1) +
                  "-" +
                  (item.lots.indexOf(lot) + 1),
                expiresOn: lot.expiresOn,
                noExpiry: lot.expiresOn === null,
              },
              session,
              {
                transferId: row._id,
                sourceBranch: row.fromBranch,
                originBatchCode: lot.code,
                originBatchId: lot.key,
                blocked: Boolean(expired),
                needsReview: Boolean(expired),
              },
            );
            if (expired)
              await store.ingredientBatches.updateOne(
                { _id: batch._id },
                {
                  $set: { blocked: true, needsReview: true },
                  $inc: { revision: 1 },
                },
                { session },
              );
            allocation.push({
              batchId: String(batch._id),
              code: batch.code,
              expiresOn: batch.expiresOn,
              quantity: received.quantity,
            });
          }
        }
        item.receivedQuantity = afterQuantity;
        item.receivedValueMinor = nextValue;
        await store.stockMovements.insertOne(
          {
            key:
              "transfer:" +
              row._id +
              ":receive:" +
              input.requestKey +
              ":" +
              index,
            kind: "transfer_in",
            transferId: row._id,
            ingredientId: ingredient._id,
            ingredientName: ingredient.name,
            unit: item.unit,
            delta: quantity,
            balance: ingredient.stock,
            cost,
            batchAllocations: allocation,
            by: req.staff.username,
            reason: input.reason,
            at: new Date(),
          },
          { session },
        );
        await store.transferEntries.insertOne(
          {
            _id: String(row._id) + ":receive:" + input.requestKey + ":" + index,
            transferId: row._id,
            direction: "in",
            otherBranch: row.fromBranch,
            ingredientId: ingredient._id,
            quantity,
            cost,
            lots: allocation,
            at: new Date(),
          },
          { session },
        );
      }
      const complete = row.lines.every(
        (item) => item.receivedQuantity === item.quantity,
      );
      if (row.receipts.length >= 99 && !complete)
        throw new HttpError(
          409,
          "TRANSFER_RECEIPT_LIMIT",
          "The final supported receipt must finish all outstanding quantities.",
        );
      const history = {
          status: complete ? "received" : "partial_receipt",
          by: req.staff.username,
          reason: input.reason,
          at: new Date(),
        },
        receipt = {
          requestKey: input.requestKey,
          fingerprint,
          by: req.staff.username,
          at: new Date(),
        };
      await store.transfers.updateOne(
        { _id: row._id },
        {
          $set: {
            lines: row.lines,
            status: complete ? "received" : "dispatched",
            ...(complete ? { completedAt: new Date() } : {}),
          },
          $inc: { revision: 1 },
          $push: { history, receipts: receipt },
        },
        { session },
      );
      await audit(store, row, "received", req.staff, input.reason, session);
      return {
        ...row,
        status: complete ? "received" : "dispatched",
        revision: row.revision + 1,
        history: [...row.history, history],
      };
    });
    res.status(201).json({ transfer: view(result, req.staff) });
  });
  api.post("/stock-transfers/:id/recovery", async (req, res) => {
    if (
      !isPlatformAdmin(req.staff) ||
      !hasPermission(identityStaff(req.staff), "branches.manage")
    )
      throw new HttpError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "A main-branch administrator reviews transfer recovery.",
      );
    const input = body(
        z.strictObject({
          expectedRevision: revision,
          sourceVerified: z.literal(true),
          destinationVerified: z.literal(true),
          currentPassword: z.string().min(1).max(128),
          reason,
        }),
        req.body,
      ),
      transferId = requireId(req.params.id),
      initial = await root.transfers.findOne({
        _id: transferId,
        $or: [{ fromBranch: current }, { toBranch: current }],
      });
    if (!initial) throw new HttpError(404, "NOT_FOUND", "Transfer not found.");
    const actor = await root.staff.findOne({
      _id: req.staff._id,
      active: true,
    });
    if (
      !actor ||
      !(await passwordMatches(input.currentPassword, actor.passwordHash))
    )
      throw new HttpError(
        403,
        "PASSWORD_CHECK",
        "Administrator password did not match.",
      );
    const [source, destination] = await Promise.all([
      runtime.get(initial.fromBranch),
      runtime.get(initial.toBranch),
    ]);
    await transaction(root, async (session) => {
      await assertStaffAction(store, req.staff, "transfers.approve", session);
      const row = await root.transfers.findOneAndUpdate(
        {
          _id: transferId,
          needsRecovery: true,
          revision: input.expectedRevision,
        },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "TRANSFER_UPDATED",
          "Reload the restored transfer before review.",
        );
      for (const [index, item] of row.lines.entries()) {
        const sent = await source.store.transferEntries.findOne(
            { _id: String(row._id) + ":dispatch:" + index },
            { session },
          ),
          received = await destination.store.transferEntries
            .find(
              {
                transferId: row._id,
                direction: "in",
                ingredientId: new ObjectId(item.targetIngredientId),
              },
              { session },
            )
            .toArray(),
          dispatched = ["dispatched", "received"].includes(row.status);
        if (
          dispatched
            ? !sent ||
              sent.quantity !== item.quantity ||
              sent.cost?.amountMinor !== item.cost?.amountMinor
            : Boolean(sent)
        )
          throw new HttpError(
            409,
            "TRANSFER_JOURNAL_MISMATCH",
            "Source transfer journal does not match this snapshot. Restore compatible records and reconcile physical stock before resuming.",
          );
        if (
          received.reduce((sum, r) => sum + r.quantity, 0) !==
            (item.receivedQuantity || 0) ||
          received.reduce((sum, r) => sum + (r.cost?.amountMinor || 0), 0) !==
            (item.receivedValueMinor || 0)
        )
          throw new HttpError(
            409,
            "TRANSFER_JOURNAL_MISMATCH",
            "Destination receipts do not match this snapshot. Restore compatible records and reconcile physical stock before resuming.",
          );
      }
      await root.transfers.updateOne(
        { _id: row._id },
        {
          $set: {
            needsRecovery: false,
            recoveryReviewedBy: req.staff.username,
            recoveryReviewedAt: new Date(),
          },
          $push: {
            history: {
              status: "recovery_reviewed",
              by: req.staff.username,
              reason: input.reason,
              at: new Date(),
            },
          },
        },
        { session },
      );
      await audit(
        store,
        row,
        "recovery_reviewed",
        req.staff,
        input.reason,
        session,
      );
    });
    res.json({ saved: true });
  });
}
