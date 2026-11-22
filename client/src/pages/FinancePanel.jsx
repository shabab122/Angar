import { useState } from "react";
import { api, dhakaTime, localDate, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { minorAmount } from "../components/Financial";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function FinancePanel({ user }) {
  const { money, notify } = useApp(),
    admin = user.role === "admin";
  const [tab, setTab] = useState("report"),
    [dates, setDates] = useState({ start: localDate(), end: localDate() }),
    [filter, setFilter] = useState(dates);
  const query = new URLSearchParams(filter),
    report = useResource("/staff/finance/profit?" + query, {
      enabled: tab === "report",
    }),
    expenses = useResource("/staff/expenses?" + query, {
      enabled: tab === "expenses",
      interval: 5000,
    }),
    valuation = useResource("/staff/finance/valuation", {
      enabled: tab === "valuation",
      interval: 10000,
    });
  const [action, setAction] = useState(null),
    [values, setValues] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function open(type, row) {
    setAction({ type, row, key: requestKey() });
    setError("");
    setValues({
      category: "other",
      payee: "",
      amount: row?.balanceMinor ? (row.balanceMinor / 100).toFixed(2) : "",
      incurredOn: localDate(),
      dueOn: "",
      reference: "",
      notes: "",
      reason: "",
      verified: false,
      method: "bank",
      price: "",
      per: row?.unit === "pcs" ? "1" : "1000",
    });
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let path, data;
      const { type, row } = action;
      if (type === "valuation") {
        const price = minorAmount(values.price);
        if (price === null) throw Error("Enter an exact BDT unit price.");
        path = "/staff/finance/valuation/" + row.id;
        data = {
          expectedRevision: row.revision,
          unitPriceMinor: price,
          pricePerQuantity: Number(values.per),
          reason: values.reason,
        };
      } else if (type === "create") {
        const amount = minorAmount(values.amount);
        if (!amount) throw Error("Enter a positive exact expense amount.");
        path = "/staff/expenses";
        data = {
          category: values.category,
          payee: values.payee,
          amountMinor: amount,
          incurredOn: values.incurredOn,
          ...(values.dueOn ? { dueOn: values.dueOn } : {}),
          reference: values.reference,
          notes: values.notes,
          requestKey: action.key,
        };
      } else if (type === "pay") {
        const amount = minorAmount(values.amount);
        if (!amount) throw Error("Enter a positive exact payment amount.");
        path = "/staff/expenses/" + row.id + "/payments";
        data = {
          amountMinor: amount,
          method: values.method,
          reference: values.reference,
          reason: values.reason,
          verified: values.verified,
          requestKey: action.key,
        };
      } else {
        path = "/staff/expenses/" + row.id + "/decision";
        data = {
          decision: type,
          expectedRevision: row.revision,
          reason: values.reason,
        };
      }
      await api(path, { method: "POST", data });
      setAction(null);
      await expenses.reload();
      await report.reload();
      await valuation.reload();
      notify("Financial record updated.");
    } catch (f) {
      setError(f.message);
    } finally {
      setBusy(false);
    }
  }
  const summary = report.data?.summary;
  return (
    <section className="v26-panel">
      <div className="panel-heading">
        <div>
          <h2>Expenses & operating result</h2>
          <p>
            Track approved operating costs, actual expense payments and recipe
            consumption values. Supplier purchases become inventory; supplier
            settlement is kept separate.
          </p>
        </div>
        <Button
          onClick={() => {
            setTab("expenses");
            open("create");
          }}
        >
          Request operating expense
        </Button>
      </div>
      <div className="page-tabs">
        {[
          ["report", "Operating result"],
          ["expenses", "Expense records"],
          ["valuation", "Ingredient valuation"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab !== "valuation" && (
        <form
          className="commerce-form commerce-card"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ ...dates });
          }}
        >
          <div className="commerce-two">
            <label>
              From date
              <input
                aria-label="Finance from date"
                type="date"
                required
                value={dates.start}
                onChange={(e) => setDates({ ...dates, start: e.target.value })}
              />
            </label>
            <label>
              Through date
              <input
                aria-label="Finance through date"
                type="date"
                required
                min={dates.start}
                value={dates.end}
                onChange={(e) => setDates({ ...dates, end: e.target.value })}
              />
            </label>
          </div>
          <Button type="submit">Apply finance dates</Button>
        </form>
      )}
      {tab === "report" &&
        (report.error ? (
          <ErrorMessage onRetry={report.reload}>
            {report.error.message}
          </ErrorMessage>
        ) : report.loading ? (
          <Loading />
        ) : (
          summary && (
            <>
              <p
                className={
                  summary.costCoverageComplete
                    ? "commerce-note"
                    : "error-message"
                }
              >
                {summary.costCoverageComplete
                  ? "Recipe costs are recorded for the settled bills in this range."
                  : "Estimate: " +
                    summary.missingBills +
                    " settled bill(s), " +
                    summary.missingLosses +
                    " stock loss record(s) and " +
                    summary.missingReturns +
                    " supplier return(s) have incomplete historical costs."}
              </p>
              <div className="v25-metrics">
                {[
                  ["Revenue excluding VAT", summary.salesMinor],
                  ["Food refunds excluding VAT", summary.refundMinor],
                  ["Net revenue", summary.netRevenueMinor],
                  ["Recipe cost of settled sales", summary.costMinor],
                  ["Waste / stock shortages", summary.wasteMinor],
                  ["Approved operating expenses", summary.expenseMinor],
                  [
                    "Supplier return valuation adjustment",
                    summary.valuationAdjustmentMinor,
                  ],
                  ["Operating result / estimate", summary.operatingResultMinor],
                ].map(([label, value]) => (
                  <div key={label}>
                    <small>{label}</small>
                    <strong>{money(value / 100)}</strong>
                  </div>
                ))}
              </div>
              <p className="commerce-note">{report.data.policy}</p>
              <p className="commerce-note">
                Recorded preparation costs for sources outside this range's
                settled sales: {money(summary.preparedOutsideSalesMinor / 100)}.
                These are shown separately.
              </p>
              <div className="commerce-table-scroll">
                <table className="v25-table">
                  <thead>
                    <tr>
                      <th>Operating expense category</th>
                      <th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.byCategory.map((r) => (
                      <tr key={r.category}>
                        <td>{r.category}</td>
                        <td>{money(r.amountMinor / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <a
                className="button button-secondary"
                href={"/api/staff/finance/profit.csv?" + query}
              >
                Export operating result CSV
              </a>
            </>
          )
        ))}
      {tab === "expenses" &&
        (expenses.error ? (
          <ErrorMessage onRetry={expenses.reload}>
            {expenses.error.message}
          </ErrorMessage>
        ) : expenses.loading ? (
          <Loading />
        ) : (
          <>
            <p className="commerce-note">
              Showing up to 200 expenses by incurred date. Approval includes the
              full expense in that date's report; paying it updates the payment
              ledger and cash drawer.
            </p>
            <div className="commerce-staff-grid">
              {expenses.data?.expenses.map((row) => (
                <article className="commerce-card" key={row.id}>
                  <div className="commerce-section-heading">
                    <h3>{row.code}</h3>
                    <span className="management-status">{row.status}</span>
                  </div>
                  <p>
                    {row.payee} · {row.category}
                  </p>
                  <p>
                    Incurred {row.incurredOn}
                    {row.dueOn ? " · Due " + row.dueOn : ""}
                  </p>
                  <p>
                    Total <strong>{money(row.amountMinor / 100)}</strong> · Paid{" "}
                    {money(row.paidMinor / 100)}
                    <br />
                    Outstanding {money(row.balanceMinor / 100)}
                  </p>
                  <p className="commerce-note">
                    {row.notes}
                    <br />
                    {row.reference}
                  </p>
                  <div className="commerce-inline-actions">
                    {admin && row.status === "requested" && (
                      <>
                        <Button onClick={() => open("approve", row)}>
                          Approve expense
                        </Button>
                        <Button secondary onClick={() => open("reject", row)}>
                          Reject expense
                        </Button>
                      </>
                    )}
                    {row.status === "approved" && row.balanceMinor > 0 && (
                      <Button onClick={() => open("pay", row)}>
                        Record expense payment
                      </Button>
                    )}
                    {admin &&
                      ["requested", "approved"].includes(row.status) &&
                      row.paidMinor === 0 && (
                        <Button secondary onClick={() => open("cancel", row)}>
                          Cancel unpaid expense
                        </Button>
                      )}
                  </div>
                  {row.payments.length > 0 && (
                    <details className="v25-details">
                      <summary>Actual payment history</summary>
                      {row.payments.map((p) => (
                        <p className="commerce-note" key={p.id}>
                          {money(p.amountMinor / 100)} · {p.method} ·{" "}
                          {p.reference}
                          <br />
                          {dhakaTime(p.at)} · {p.by}
                          <br />
                          {p.reason}
                        </p>
                      ))}
                    </details>
                  )}
                </article>
              ))}
            </div>
            {!expenses.data?.expenses.length && (
              <p>No operating expenses match these dates.</p>
            )}
          </>
        ))}
      {tab === "valuation" &&
        (valuation.error ? (
          <ErrorMessage onRetry={valuation.reload}>
            {valuation.error.message}
          </ErrorMessage>
        ) : valuation.loading ? (
          <Loading />
        ) : (
          <>
            <p className="commerce-note">
              Available inventory uses weighted-average recorded value.
              Historical stock starts without a known cost. Record its supported
              opening value; future received purchase costs then contribute
              automatically. Existing reserved order costs keep their original
              snapshots.
            </p>
            <div className="commerce-staff-grid">
              {valuation.data?.ingredients.map((row) => (
                <article className="commerce-card" key={row.id}>
                  <h3>{row.name}</h3>
                  <p>
                    Available stock: {row.stock} {row.unit}
                  </p>
                  <p>
                    Recorded value:{" "}
                    <strong>{money(row.inventoryValueMinor / 100)}</strong>
                  </p>
                  <p className="commerce-note">
                    {row.costComplete
                      ? "Current available stock has a recorded valuation."
                      : "Cost history is incomplete; record a supported opening valuation."}
                  </p>
                  {admin && (
                    <Button secondary onClick={() => open("valuation", row)}>
                      Record valuation for {row.name}
                    </Button>
                  )}
                </article>
              ))}
            </div>
          </>
        ))}
      {action && (
        <Modal
          open
          title={
            action.type === "valuation"
              ? "Record supported inventory valuation"
              : action.type === "create"
                ? "Request operating expense"
                : action.type === "pay"
                  ? "Record actual expense payment"
                  : action.type === "approve"
                    ? "Approve operating expense"
                    : action.type === "reject"
                      ? "Reject operating expense"
                      : "Cancel unpaid expense"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
          className="management-dialog"
        >
          <form className="commerce-form" onSubmit={submit}>
            {action.type === "create" && (
              <>
                <label>
                  Expense category
                  <select
                    aria-label="Expense category"
                    value={values.category}
                    onChange={(e) =>
                      setValues({ ...values, category: e.target.value })
                    }
                  >
                    {[
                      "salary",
                      "rent",
                      "utilities",
                      "maintenance",
                      "transport",
                      "supplies",
                      "other",
                    ].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Payee
                  <input
                    aria-label="Expense payee"
                    required
                    minLength={2}
                    maxLength={100}
                    value={values.payee}
                    onChange={(e) =>
                      setValues({ ...values, payee: e.target.value })
                    }
                  />
                </label>
                <label>
                  Total expense (BDT)
                  <input
                    aria-label="Expense total"
                    required
                    inputMode="decimal"
                    value={values.amount}
                    onChange={(e) =>
                      setValues({ ...values, amount: e.target.value })
                    }
                  />
                </label>
                <div className="commerce-two">
                  <label>
                    Incurred date
                    <input
                      aria-label="Expense incurred date"
                      type="date"
                      required
                      value={values.incurredOn}
                      onChange={(e) =>
                        setValues({ ...values, incurredOn: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Due date (optional)
                    <input
                      type="date"
                      value={values.dueOn}
                      onChange={(e) =>
                        setValues({ ...values, dueOn: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  Invoice / reference (optional)
                  <input
                    maxLength={80}
                    value={values.reference}
                    onChange={(e) =>
                      setValues({ ...values, reference: e.target.value })
                    }
                  />
                </label>
                <label>
                  Description
                  <textarea
                    aria-label="Expense description"
                    required
                    minLength={3}
                    maxLength={240}
                    value={values.notes}
                    onChange={(e) =>
                      setValues({ ...values, notes: e.target.value })
                    }
                  />
                </label>
              </>
            )}
            {action.type === "valuation" && (
              <>
                <p>
                  {action.row.name} · {action.row.stock} {action.row.unit}{" "}
                  available
                </p>
                <label>
                  Supported price (BDT)
                  <input
                    aria-label="Valuation price"
                    inputMode="decimal"
                    required
                    value={values.price}
                    onChange={(e) =>
                      setValues({ ...values, price: e.target.value })
                    }
                  />
                </label>
                <label>
                  Price applies to how many {action.row.unit}?
                  <input
                    aria-label="Valuation price units"
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    required
                    value={values.per}
                    onChange={(e) =>
                      setValues({ ...values, per: e.target.value })
                    }
                  />
                </label>
                <p className="commerce-note">
                  Use an invoice or other supported valuation for current
                  available stock. This records inventory value and changes
                  future costing; it does not record a supplier payment or alter
                  old order costs.
                </p>
              </>
            )}
            {action.type === "pay" && (
              <>
                <p>
                  {action.row.code} · Outstanding{" "}
                  {money(action.row.balanceMinor / 100)}
                </p>
                <label>
                  Amount actually paid (BDT)
                  <input
                    aria-label="Expense payment amount"
                    inputMode="decimal"
                    required
                    value={values.amount}
                    onChange={(e) =>
                      setValues({ ...values, amount: e.target.value })
                    }
                  />
                </label>
                <label>
                  Payment channel
                  <select
                    aria-label="Expense payment channel"
                    value={values.method}
                    onChange={(e) =>
                      setValues({ ...values, method: e.target.value })
                    }
                  >
                    {["bank", "cash", "bkash", "nagad", "card"].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Payment reference
                  {values.method === "cash" ? " (optional)" : ""}
                  <input
                    aria-label="Expense payment reference"
                    required={values.method !== "cash"}
                    maxLength={100}
                    value={values.reference}
                    onChange={(e) =>
                      setValues({ ...values, reference: e.target.value })
                    }
                  />
                </label>
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    required
                    checked={values.verified}
                    onChange={(e) =>
                      setValues({ ...values, verified: e.target.checked })
                    }
                  />
                  <span>
                    I verified this expense payment actually happened.
                  </span>
                </label>
              </>
            )}
            {action.type !== "create" && (
              <label>
                Reason
                <textarea
                  aria-label="Finance action reason"
                  required
                  minLength={3}
                  maxLength={160}
                  value={values.reason}
                  onChange={(e) =>
                    setValues({ ...values, reason: e.target.value })
                  }
                />
              </label>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={busy || (action.type === "pay" && !values.verified)}
            >
              {action.type === "create"
                ? "Submit expense request"
                : action.type === "valuation"
                  ? "Save supported valuation"
                  : action.type === "pay"
                    ? "Record verified expense payment"
                    : action.type === "approve"
                      ? "Confirm expense approval"
                      : action.type === "reject"
                        ? "Confirm expense rejection"
                        : "Confirm unpaid cancellation"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
