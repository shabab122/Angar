import { ObjectId } from "mongodb";
import { z } from "zod";
import { body, HttpError } from "./http.js";
import { transaction } from "./money.js";
import { hash } from "./security.js";
import { recordCash } from "./cash-drawer.js";
import { ratioMinor } from "./inventory-cost.js";
import { reportWindow } from "./reports.js";
import { csvDocument } from "./audit-dashboard.js";
const key = z.string().regex(/^[a-f0-9]{32}$/),
  reason = z.string().trim().min(3).max(160),
  amount = z.number().int().min(1).max(10_000_000_000);
const calendar = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const expenseCategories = [
  "salary",
  "rent",
  "utilities",
  "maintenance",
  "transport",
  "supplies",
  "other",
];
const view = (row) => ({
  ...row,
  id: String(row._id),
  _id: undefined,
  requestKey: undefined,
  fingerprint: undefined,
  balanceMinor: row.amountMinor - row.paidMinor,
});
export async function profitReport(store, window) {
  const range = { $gte: window.startAt, $lt: window.endAt };
  const bills = await store.bills
    .find({ status: "paid", paidAt: range })
    .limit(10001)
    .toArray();
  if (bills.length > 10000)
    throw new HttpError(
      409,
      "REPORT_LIMIT",
      "Narrow the range to at most 10,000 settled bills.",
    );
  let salesMinor = 0,
    costMinor = 0,
    missingBills = 0;
  const sources = [];
  const allSources = [
    ...new Map(
      bills
        .flatMap((bill) =>
          bill.fulfillmentId ? [bill.fulfillmentId] : bill.orderIds || [],
        )
        .map((id) => [String(id), id]),
    ).values(),
  ];
  const allCosts = allSources.length
    ? await store.inventoryConsumptions
        .find({ _id: { $in: allSources } })
        .toArray()
    : [];
  const costsBySource = new Map(
    allCosts.map((cost) => [String(cost._id), cost]),
  );
  for (const bill of bills) {
    salesMinor += bill.totalMinor - (bill.taxMinor || 0);
    const ids = bill.fulfillmentId ? [bill.fulfillmentId] : bill.orderIds || [];
    const costs = ids
      .map((id) => costsBySource.get(String(id)))
      .filter(Boolean);
    costMinor += costs.reduce((sum, c) => sum + c.totalMinor, 0);
    if (
      !ids.length ||
      costs.length !== ids.length ||
      costs.some((c) => !c.complete)
    )
      missingBills++;
    sources.push(...ids);
  }
  const refunds = await store.refunds
    .find({
      status: "refunded",
      source: { $nin: ["event", "overpayment"] },
      refundedAt: range,
    })
    .toArray();
  const refundMinor = refunds.reduce(
    (s, r) => s + r.amountMinor - (r.creditNote?.taxMinor || 0),
    0,
  );
  const expenses = await store.expenses
    .find({
      status: { $in: ["approved", "paid"] },
      incurredOn: { $gte: window.start, $lte: window.end },
    })
    .toArray();
  const expenseMinor = expenses.reduce((s, e) => s + e.amountMinor, 0);
  const losses = await store.stockMovements
    .find({
      at: range,
      $or: [
        { kind: "waste" },
        { kind: "stocktake_adjustment", delta: { $lt: 0 } },
      ],
    })
    .toArray();
  const wasteMinor = losses.reduce((s, m) => s + (m.cost?.amountMinor || 0), 0),
    missingLosses = losses.filter((m) => !m.cost?.complete).length;
  const returned = await store.supplierReturns
      .find({ status: "returned", confirmedAt: range })
      .toArray(),
    valuationAdjustmentMinor = returned.reduce(
      (s, r) => s + (r.creditNote?.valuationAdjustmentMinor || 0),
      0,
    ),
    missingReturns = returned.filter(
      (r) => r.creditNote?.missingQuantity,
    ).length;
  const prepared = await store.inventoryConsumptions
    .find({ at: range, _id: { $nin: sources } })
    .toArray();
  const byCategory = expenseCategories.map((category) => ({
    category,
    amountMinor: expenses
      .filter((e) => e.category === category)
      .reduce((s, e) => s + e.amountMinor, 0),
  }));
  return {
    window: { start: window.start, end: window.end, timezone: "Asia/Dhaka" },
    summary: {
      salesMinor,
      refundMinor,
      netRevenueMinor: salesMinor - refundMinor,
      costMinor,
      wasteMinor,
      expenseMinor,
      valuationAdjustmentMinor,
      operatingResultMinor:
        salesMinor -
        refundMinor -
        costMinor -
        wasteMinor -
        expenseMinor +
        valuationAdjustmentMinor,
      settledBills: bills.length,
      missingBills,
      missingLosses,
      missingReturns,
      costCoverageComplete: !missingBills && !missingLosses && !missingReturns,
      preparedOutsideSalesMinor: prepared.reduce((s, c) => s + c.totalMinor, 0),
    },
    byCategory,
    policy:
      "Settled sales excluding VAT, less confirmed non-VAT food refunds, original preparation costs, period stock losses and approved expenses by incurred date. Purchases and supplier cash settlements are not expenses again. Prepared food is never restocked by a refund. Missing historical recipe/valuation data makes this an estimate.",
  };
}
export function registerFinance(
  api,
  store,
  requireAdmin,
  billingRoles,
  requireId,
) {
  api.get("/finance/valuation", billingRoles, async (req, res) => {
    const rows = await store.ingredients.find({}).sort({ name: 1 }).toArray();
    res.json({
      ingredients: rows.map((row) => ({
        id: String(row._id),
        name: row.name,
        unit: row.unit,
        stock: row.stock,
        revision: row.revision || 0,
        inventoryValueMinor: row.inventoryValueMinor || 0,
        costComplete: row.stock === 0 || row.costComplete === true,
      })),
    });
  });
  api.post("/finance/valuation/:id", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        expectedRevision: z.number().int().min(0),
        unitPriceMinor: z.number().int().min(0).max(100_000_000),
        pricePerQuantity: z.number().int().min(1).max(1_000_000),
        reason,
      }),
      req.body,
    );
    const row = await transaction(store, async (session) => {
      const row = await store.ingredients.findOneAndUpdate(
        { _id: requireId(req.params.id), revision: input.expectedRevision },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "INVENTORY_UPDATED",
          "Stock changed. Refresh valuation first.",
        );
      const value = ratioMinor(
        input.unitPriceMinor,
        row.stock,
        input.pricePerQuantity,
      );
      await store.ingredients.updateOne(
        { _id: row._id },
        { $set: { inventoryValueMinor: value, costComplete: true } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "inventory.valuation_recorded",
          ingredientId: row._id,
          amountMinor: value,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { valueMinor: value };
    });
    res.json(row);
  });
  api.get("/expenses", billingRoles, async (req, res) => {
    const w = reportWindow(req.query),
      rows = await store.expenses
        .find({ incurredOn: { $gte: w.start, $lte: w.end } })
        .sort({ incurredOn: -1, createdAt: -1 })
        .limit(200)
        .toArray();
    res.json({
      expenses: rows.map(view),
      categories: expenseCategories,
      window: { start: w.start, end: w.end },
    });
  });
  api.post("/expenses", billingRoles, async (req, res) => {
    const input = body(
        z.strictObject({
          category: z.enum(expenseCategories),
          payee: z.string().trim().min(2).max(100),
          amountMinor: amount,
          incurredOn: calendar,
          dueOn: calendar.optional(),
          reference: z.string().trim().max(80).default(""),
          notes: z.string().trim().min(3).max(240),
          requestKey: key,
        }),
        req.body,
      ),
      fingerprint = hash(JSON.stringify(input));
    const row = await transaction(store, async (session) => {
      await store.settings.updateOne(
        { _id: "expense-setup-lock" },
        { $inc: { revision: 1 } },
        { session },
      );
      const old = await store.expenses.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another expense.",
          );
        return old;
      }
      const row = {
        _id: new ObjectId(),
        code: "EX-" + new ObjectId().toString().slice(-10).toUpperCase(),
        ...input,
        fingerprint,
        status: "requested",
        paidMinor: 0,
        revision: 0,
        payments: [],
        createdBy: req.staff.username,
        createdAt: new Date(),
      };
      await store.expenses.insertOne(row, { session });
      await store.audit.insertOne(
        {
          type: "expense.requested",
          expenseId: row._id,
          amountMinor: input.amountMinor,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.status(201).json({ expense: view(row) });
  });
  api.post("/expenses/:id/decision", requireAdmin, async (req, res) => {
    const input = body(
      z.strictObject({
        decision: z.enum(["approve", "reject", "cancel"]),
        expectedRevision: z.number().int().min(0),
        reason,
      }),
      req.body,
    );
    const row = await transaction(store, async (session) => {
      const row = await store.expenses.findOneAndUpdate(
        {
          _id: requireId(req.params.id),
          revision: input.expectedRevision,
          status:
            input.decision === "cancel"
              ? { $in: ["requested", "approved"] }
              : "requested",
          ...(input.decision === "cancel" ? { paidMinor: 0 } : {}),
        },
        {
          $set: {
            status:
              input.decision === "approve"
                ? "approved"
                : input.decision === "cancel"
                  ? "cancelled"
                  : "rejected",
            reviewedBy: req.staff.username,
            reviewedAt: new Date(),
            reviewReason: input.reason,
          },
          $inc: { revision: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!row)
        throw new HttpError(
          409,
          "EXPENSE_UPDATED",
          "Only an unchanged pending expense, or an unpaid expense for cancellation, can make this transition.",
        );
      await store.audit.insertOne(
        {
          type: "expense." + row.status,
          expenseId: row._id,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return row;
    });
    res.json({ expense: view(row) });
  });
  api.post("/expenses/:id/payments", billingRoles, async (req, res) => {
    const input = body(
        z.strictObject({
          amountMinor: amount,
          method: z.enum(["cash", "bank", "bkash", "nagad", "card"]),
          reference: z.string().trim().max(100).default(""),
          reason,
          verified: z.literal(true),
          requestKey: key,
        }),
        req.body,
      ),
      expenseId = requireId(req.params.id),
      fingerprint = hash(JSON.stringify({ expenseId, ...input }));
    if (input.method !== "cash" && !input.reference)
      throw new HttpError(
        400,
        "REFERENCE_REQUIRED",
        "Enter the actual payment reference.",
      );
    const row = await transaction(store, async (session) => {
      const old = await store.expensePayments.findOne(
        { requestKey: input.requestKey },
        { session },
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "REQUEST_REUSED",
            "This key belongs to another expense payment.",
          );
        return store.expenses.findOne({ _id: expenseId }, { session });
      }
      const row = await store.expenses.findOneAndUpdate(
        { _id: expenseId, status: "approved" },
        { $inc: { revision: 1 } },
        { session, returnDocument: "after" },
      );
      if (!row || input.amountMinor > row.amountMinor - row.paidMinor)
        throw new HttpError(
          409,
          "EXPENSE_PAYMENT_LIMIT",
          "Pay only the approved outstanding expense balance.",
        );
      const payment = {
        _id: new ObjectId(),
        expenseId,
        ...input,
        fingerprint,
        by: req.staff.username,
        at: new Date(),
      };
      await store.expensePayments.insertOne(payment, { session });
      if (input.method === "cash")
        await recordCash(
          store,
          {
            key: "expense:" + payment._id,
            kind: "expense_payment",
            deltaMinor: -input.amountMinor,
            sourceId: expenseId,
            by: req.staff.username,
            reference: input.reference || row.code,
            reason: input.reason,
            requireFunds: true,
          },
          session,
        );
      const changes = {
        paidMinor: row.paidMinor + input.amountMinor,
        status:
          row.paidMinor + input.amountMinor === row.amountMinor
            ? "paid"
            : "approved",
      };
      const record = {
        id: String(payment._id),
        amountMinor: input.amountMinor,
        method: input.method,
        reference: input.reference,
        reason: input.reason,
        by: req.staff.username,
        at: payment.at,
      };
      await store.expenses.updateOne(
        { _id: expenseId },
        { $set: changes, $push: { payments: record } },
        { session },
      );
      await store.audit.insertOne(
        {
          type: "expense.payment_recorded",
          expenseId,
          amountMinor: input.amountMinor,
          reason: input.reason,
          by: req.staff.username,
          at: new Date(),
        },
        { session },
      );
      return { ...row, ...changes, payments: [...row.payments, record] };
    });
    res.status(201).json({ expense: view(row) });
  });
  api.get("/finance/profit", billingRoles, async (req, res) =>
    res.json(await profitReport(store, reportWindow(req.query))),
  );
  api.get("/finance/profit.csv", billingRoles, async (req, res) => {
    const report = await profitReport(store, reportWindow(req.query));
    res
      .type("text/csv")
      .attachment("angar-operating-result.csv")
      .send(
        csvDocument([
          ["Start Bangladesh", report.window.start],
          ["End inclusive", report.window.end],
          [
            "Cost coverage",
            report.summary.costCoverageComplete
              ? "complete for recorded recipe costs"
              : "incomplete estimate",
          ],
          ...[...Object.entries(report.summary)].map(([k, v]) => [
            k,
            k.endsWith("Minor") ? v / 100 : String(v),
          ]),
          [],
          ["Expense category", "BDT"],
          ...report.byCategory.map((c) => [c.category, c.amountMinor / 100]),
          [],
          ["Policy", report.policy],
        ]),
      );
  });
}
