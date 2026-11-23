import { useState } from "react";
import { useResource } from "../lib/useResource";
import { localDate, money, dhakaTime } from "../lib/api";
import { Button, Loading, ErrorMessage } from "../components/UI";
const amount = (value) => money(value / 100);
export default function OrganizationDashboard() {
  const [dates, setDates] = useState({ start: localDate(), end: localDate() }),
    [range, setRange] = useState(dates),
    query = new URLSearchParams(range),
    resource = useResource("/organization/dashboard?" + query, {
      interval: 30000,
    }),
    data = resource.data;
  return (
    <section className="v28-panel">
      <div className="panel-heading">
        <div>
          <h2>All-branch dashboard</h2>
          <p>
            Compare settled sales, operating result, cash flows and current
            stock.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh all branches
        </Button>
      </div>
      <form
        className="v28-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setRange({ ...dates });
        }}
      >
        <label>
          From
          <input
            aria-label="Branch report from"
            type="date"
            required
            value={dates.start}
            onChange={(e) => setDates({ ...dates, start: e.target.value })}
          />
        </label>
        <label>
          Through
          <input
            aria-label="Branch report through"
            type="date"
            required
            value={dates.end}
            onChange={(e) => setDates({ ...dates, end: e.target.value })}
          />
        </label>
        <Button type="submit">Compare branches</Button>
        <a
          className="button button-secondary"
          href={"/api/organization/dashboard.csv?" + query}
        >
          Export branch comparison
        </a>
      </form>
      {resource.loading && <Loading />}
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {data && (
        <>
          <p className="commerce-note">
            Asia/Dhaka · {data.scope.available} of {data.scope.total} branches
            available · Updated {dhakaTime(data.asOf)}
          </p>
          {!data.complete && (
            <ErrorMessage>
              Some branches are unavailable. Totals include available branches
              only.
            </ErrorMessage>
          )}
          {!data.costCoverageComplete && (
            <p className="courier-review">
              Some ingredient costs are incomplete. The operating result and
              known stock value need review.
            </p>
          )}
          {(data.totals.inTransitIncompleteLines > 0 ||
            data.totals.transfersNeedingRecovery > 0) && (
            <p className="courier-review">
              In-transit cost review: {data.totals.inTransitIncompleteLines}{" "}
              incomplete line(s) · {data.totals.transfersNeedingRecovery}{" "}
              transfer(s) awaiting recovery reconciliation.
            </p>
          )}
          <div className="v28-metrics">
            {[
              ["Settled sales", data.totals.salesMinor],
              ["Operating result", data.totals.operatingResultMinor],
              ["Cash received", data.totals.cashInMinor],
              ["Cash paid out", data.totals.cashOutMinor],
              ["Known stock value", data.totals.knownStockValueMinor],
              ["Stock value in transit", data.totals.inTransitKnownValueMinor],
            ].map(([label, value]) => (
              <article className="commerce-card" key={label}>
                <span>{label}</span>
                <strong>{amount(value)}</strong>
              </article>
            ))}
          </div>
          <div className="v28-table-wrap">
            <table className="v28-table">
              <caption>Branch comparison for the selected period</caption>
              <thead>
                <tr>
                  {[
                    "Branch",
                    "Settled sales",
                    "Operating result",
                    "Cash in / out",
                    "Current drawer",
                    "Known stock value",
                    "Stock / usable stock",
                    "Cost coverage",
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.branches.map((row) => (
                  <tr key={row.branchId}>
                    <th scope="row">
                      {row.name}
                      <small>{row.branchId}</small>
                    </th>
                    {row.status !== "available" ? (
                      <td colSpan={7}>Unavailable · {row.reason}</td>
                    ) : (
                      <>
                        <td>
                          {amount(row.salesMinor)}
                          <small>{row.paidBills} settled bills</small>
                        </td>
                        <td>{amount(row.operatingResultMinor)}</td>
                        <td>
                          {amount(row.cashInMinor)} / {amount(row.cashOutMinor)}
                        </td>
                        <td>
                          {row.currentDrawer
                            ? amount(row.currentDrawer.expectedMinor)
                            : "No open shift"}
                        </td>
                        <td>
                          {amount(row.stock.knownStockValueMinor)}
                          <small>
                            {row.stock.lowStockIngredients} low-stock
                            ingredients
                          </small>
                        </td>
                        <td>
                          {Object.entries(row.stock.units).map(
                            ([unit, quantity]) => (
                              <small key={unit}>
                                {quantity.stock.toLocaleString()} /{" "}
                                {quantity.usable.toLocaleString()} {unit}
                              </small>
                            ),
                          )}
                        </td>
                        <td>
                          {row.costCoverageComplete &&
                          !row.stock.unknownCostIngredients
                            ? "Complete"
                            : "Needs review"}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="commerce-note">{data.policy}</p>
        </>
      )}
    </section>
  );
}
