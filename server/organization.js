import { authenticatedStaff, getBranchRuntime } from "./branches.js";
import { isPlatformAdmin, hasPermission } from "./access.js";
import { HttpError } from "./http.js";
import { reportWindow, salesReport } from "./reports.js";
import { profitReport } from "./finance.js";
import { stockDay } from "./ingredient-batches.js";
import { csvDocument } from "./audit-dashboard.js";
export const requirePlatformCapability =
  (store, config, key) => async (req, res, next) => {
    req.platformStaff = await authenticatedStaff(store, req, config);
    if (
      !isPlatformAdmin(req.platformStaff) ||
      !hasPermission(req.platformStaff, key)
    )
      throw new HttpError(
        403,
        "PLATFORM_ADMIN_REQUIRED",
        "An authorized main-branch administrator manages this installation-wide view.",
      );
    next();
  };
function sumRows(rows, key) {
  const result = rows.reduce((sum, row) => sum + (row[key] || 0), 0);
  if (!Number.isSafeInteger(result))
    throw new HttpError(
      409,
      "REPORT_LIMIT",
      "The combined value exceeds its supported exact-money limit. Narrow this report.",
    );
  return result;
}
export async function consolidatedDashboard(root, config, query) {
  const window = reportWindow(query),
    runtime = getBranchRuntime(root, config);
  await runtime.ready;
  const branches = await root.branches.find({}).sort({ _id: 1 }).toArray(),
    rows = [];
  for (const branch of branches) {
    if (!branch.active || branch.state !== "ready") {
      rows.push({
        branchId: branch._id,
        name: branch.name,
        status: "unavailable",
        reason: branch.state,
      });
      continue;
    }
    try {
      const { store } = await runtime.get(branch._id),
        [sales, profit, ingredients, batches, register, cash] =
          await Promise.all([
            salesReport(store, window),
            profitReport(store, window),
            store.ingredients.find({}).limit(501).toArray(),
            store.ingredientBatches
              .find({ remaining: { $gt: 0 } })
              .limit(20001)
              .toArray(),
            store.cashRegisters.findOne({ _id: "main" }),
            store.cashMovements
              .aggregate([
                { $match: { at: { $gte: window.startAt, $lt: window.endAt } } },
                {
                  $group: {
                    _id: null,
                    inMinor: {
                      $sum: {
                        $cond: [{ $gt: ["$deltaMinor", 0] }, "$deltaMinor", 0],
                      },
                    },
                    outMinor: {
                      $sum: {
                        $cond: [
                          { $lt: ["$deltaMinor", 0] },
                          { $multiply: ["$deltaMinor", -1] },
                          0,
                        ],
                      },
                    },
                    netMinor: { $sum: "$deltaMinor" },
                  },
                },
              ])
              .toArray(),
          ]);
      if (ingredients.length > 500 || batches.length > 20000)
        throw new HttpError(
          409,
          "REPORT_LIMIT",
          "Branch inventory exceeds this dashboard limit.",
        );
      const shift = register?.activeShiftId
          ? await store.cashShifts.findOne({
              _id: register.activeShiftId,
              status: "open",
            })
          : null,
        units = {
          g: { stock: 0, usable: 0 },
          ml: { stock: 0, usable: 0 },
          pcs: { stock: 0, usable: 0 },
        };
      let knownStockValueMinor = 0,
        unknownCostIngredients = 0,
        lowStockIngredients = 0;
      for (const ingredient of ingredients) {
        if (!units[ingredient.unit]) continue;
        const available = ingredient.batchTracked
          ? batches
              .filter(
                (b) =>
                  String(b.ingredientId) === String(ingredient._id) &&
                  !b.blocked &&
                  (!b.expiresOn || b.expiresOn >= stockDay()),
              )
              .reduce((sum, b) => sum + b.remaining, 0)
          : ingredient.stock;
        units[ingredient.unit].stock += ingredient.stock;
        units[ingredient.unit].usable += available;
        knownStockValueMinor += ingredient.inventoryValueMinor || 0;
        if (ingredient.stock && ingredient.costComplete !== true)
          unknownCostIngredients++;
        if (available <= ingredient.reorderLevel) lowStockIngredients++;
      }
      rows.push({
        branchId: branch._id,
        name: branch.name,
        status: "available",
        salesMinor: sales.summary.revenueMinor,
        paidBills: sales.summary.bills,
        netRevenueMinor: profit.summary.netRevenueMinor,
        operatingResultMinor: profit.summary.operatingResultMinor,
        costMinor: profit.summary.costMinor,
        expenseMinor: profit.summary.expenseMinor,
        wasteMinor: profit.summary.wasteMinor,
        costCoverageComplete: profit.summary.costCoverageComplete,
        missingBills: profit.summary.missingBills,
        cashInMinor: cash[0]?.inMinor || 0,
        cashOutMinor: cash[0]?.outMinor || 0,
        cashNetMinor: cash[0]?.netMinor || 0,
        currentDrawer: shift
          ? {
              code: shift.code,
              expectedMinor: shift.expectedMinor,
              openedAt: shift.openedAt,
            }
          : null,
        stock: {
          ingredients: ingredients.length,
          units,
          knownStockValueMinor,
          unknownCostIngredients,
          lowStockIngredients,
        },
      });
    } catch (error) {
      rows.push({
        branchId: branch._id,
        name: branch.name,
        status: "unavailable",
        reason:
          error.code === "REPORT_LIMIT"
            ? "Narrow the report range or review inventory size."
            : "Branch data could not be read. No zero values were assumed.",
      });
    }
  }
  const available = rows.filter((row) => row.status === "available"),
    totals = {};
  for (const key of [
    "salesMinor",
    "paidBills",
    "netRevenueMinor",
    "operatingResultMinor",
    "costMinor",
    "expenseMinor",
    "wasteMinor",
    "cashInMinor",
    "cashOutMinor",
    "cashNetMinor",
  ])
    totals[key] = sumRows(available, key);
  totals.knownStockValueMinor = sumRows(
    available.map((r) => r.stock),
    "knownStockValueMinor",
  );
  totals.unknownCostIngredients = sumRows(
    available.map((r) => r.stock),
    "unknownCostIngredients",
  );
  const transfers = await root.transfers
    .find({ status: "dispatched" })
    .limit(10001)
    .toArray();
  if (transfers.length > 10000)
    throw new HttpError(
      409,
      "REPORT_LIMIT",
      "Too many outstanding transfers for this dashboard.",
    );
  totals.inTransitKnownValueMinor = transfers.reduce(
    (sum, row) =>
      sum +
      row.lines.reduce(
        (s, line) =>
          s + (line.cost?.amountMinor || 0) - (line.receivedValueMinor || 0),
        0,
      ),
    0,
  );
  if (!Number.isSafeInteger(totals.inTransitKnownValueMinor))
    throw new HttpError(
      409,
      "REPORT_LIMIT",
      "The combined in-transit value exceeds the supported exact-money limit.",
    );
  totals.inTransitIncompleteLines = transfers
    .flatMap((row) => row.lines)
    .filter(
      (line) =>
        !line.cost?.complete && (line.receivedQuantity || 0) < line.quantity,
    ).length;
  totals.transfersNeedingRecovery = transfers.filter(
    (row) => row.needsRecovery,
  ).length;
  return {
    window: { start: window.start, end: window.end, timezone: window.timezone },
    asOf: new Date(),
    branches: rows,
    totals,
    complete: available.length === rows.length,
    costCoverageComplete:
      totals.inTransitIncompleteLines === 0 &&
      available.length === rows.length &&
      available.every(
        (r) => r.costCoverageComplete && r.stock.unknownCostIngredients === 0,
      ),
    scope: { available: available.length, total: rows.length },
    policy:
      "Selected-period settled sales, operating-result and cash flows reuse the branch report policies. Drawer balances and unallocated stock are current snapshots. Units are never added together. Unknown costs and unavailable branches remain explicit; in-transit transfer value is separate and is not sales or an expense.",
  };
}
export function registerOrganization(api, root, config) {
  const guard = requirePlatformCapability(root, config, "branches.dashboard");
  api.get("/organization/dashboard", guard, async (req, res) =>
    res.json(await consolidatedDashboard(root, config, req.query)),
  );
  api.get("/organization/dashboard.csv", guard, async (req, res) => {
    const result = await consolidatedDashboard(root, config, req.query);
    res
      .type("text/csv")
      .attachment(
        "angar-branches-" +
          result.window.start +
          "-" +
          result.window.end +
          ".csv",
      )
      .send(
        csvDocument([
          [
            "Branch",
            "Status",
            "Gross settled sales BDT",
            "Operating result BDT",
            "Cash in BDT",
            "Cash out BDT",
            "Known stock value BDT",
            "Unknown cost ingredients",
            "Cost complete",
          ],
          ...result.branches.map((row) => [
            row.name,
            row.status,
            row.status === "available" ? row.salesMinor / 100 : "Unavailable",
            row.status === "available"
              ? row.operatingResultMinor / 100
              : "Unavailable",
            row.status === "available" ? row.cashInMinor / 100 : "Unavailable",
            row.status === "available" ? row.cashOutMinor / 100 : "Unavailable",
            row.stock ? row.stock.knownStockValueMinor / 100 : "Unavailable",
            row.stock?.unknownCostIngredients ?? "Unavailable",
            row.status === "available" ? row.costCoverageComplete : false,
          ]),
          [
            "Totals include available branches only",
            result.complete ? "Complete scope" : "Partial scope",
            result.totals.salesMinor / 100,
            result.totals.operatingResultMinor / 100,
            result.totals.cashInMinor / 100,
            result.totals.cashOutMinor / 100,
            result.totals.knownStockValueMinor / 100,
            result.totals.unknownCostIngredients,
            result.costCoverageComplete,
          ],
        ]),
      );
  });
}
