import { useState } from "react";
import { api, dhakaTime, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { minorAmount } from "../components/Financial";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function SupplierReturnsPanel({ user }) {
  const { money, notify } = useApp(),
    admin = user.role === "admin",
    resource = useResource("/staff/supplier-returns", { interval: 5000 }),
    purchases = useResource("/staff/purchases", { enabled: admin });
  const [action, setAction] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(null);
  const source = useResource("/staff/purchases/" + (values.purchaseId || ""), {
      enabled: action?.type === "create" && !!values.purchaseId,
    }),
    receipt = source.data?.receipts.find((r) => r.id === values.receiptId);
  function open(type, row) {
    setAction({ type, row, key: requestKey() });
    setValues({
      purchaseId: "",
      receiptId: "",
      quantities: {},
      reason: "",
      reference: "",
      verified: false,
      amount: row ? (row.creditMinor / 100).toFixed(2) : "",
      method: "bank",
    });
    setError("");
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let path, data;
      if (action.type === "create") {
        path = "/staff/supplier-returns";
        const items =
          receipt?.items
            .filter((i) => Number(values.quantities[i.ingredientId]) > 0)
            .map((i) => ({
              ingredientId: i.ingredientId,
              quantity: Number(values.quantities[i.ingredientId]),
            })) || [];
        if (!items.length)
          throw Error("Enter at least one quantity being returned.");
        data = {
          receiptId: values.receiptId,
          items,
          reason: values.reason,
          requestKey: action.key,
        };
      } else if (action.type === "refund") {
        path = "/staff/purchases/" + action.row.id + "/supplier-refunds";
        const amount = minorAmount(values.amount);
        if (!amount) throw Error("Enter a positive exact refund amount.");
        data = {
          amountMinor: amount,
          method: values.method,
          reference: values.reference,
          reason: values.reason,
          verified: values.verified,
          requestKey: action.key,
        };
      } else {
        path =
          "/staff/supplier-returns/" +
          action.row.id +
          (action.type === "confirm" ? "/confirm" : "/decision");
        data = {
          expectedRevision: action.row.revision,
          reason: values.reason,
          ...(action.type === "confirm"
            ? {
                verified: values.verified,
                reference: values.reference,
                requestKey: action.key,
              }
            : { decision: action.type }),
        };
      }
      await api(path, { method: "POST", data });
      setAction(null);
      await resource.reload();
      await purchases.reload();
      notify("Supplier return / credit updated.");
    } catch (f) {
      setError(f.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="v26-panel">
      <div className="panel-heading">
        <div>
          <h2>Supplier returns & credit notes</h2>
          <p>
            Review original deliveries, approve returns and confirm physical
            handover. A credit reduces the payable; actual money received back
            is recorded separately.
          </p>
        </div>
        {admin && (
          <Button onClick={() => open("create")}>
            Request supplier return
          </Button>
        )}
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          <h3>Supplier credit available</h3>
          <div className="commerce-staff-grid">
            {resource.data?.credits.map((c) => (
              <article className="commerce-card" key={c.id}>
                <h3>{c.code}</h3>
                <p>{c.supplierName}</p>
                <p>
                  Credit: <strong>{money(c.creditMinor / 100)}</strong>
                </p>
                <Button secondary onClick={() => open("refund", c)}>
                  Record supplier refund received
                </Button>
              </article>
            ))}
          </div>
          {!resource.data?.credits.length && (
            <p className="commerce-note">
              No overpaid supplier credit is waiting to be received.
            </p>
          )}
          <h3>Return records</h3>
          <div className="commerce-staff-grid">
            {resource.data?.returns.map((r) => (
              <article className="commerce-card" key={r.id}>
                <div className="commerce-section-heading">
                  <h3>{r.code}</h3>
                  <span className="management-status">{r.status}</span>
                </div>
                <p>
                  {r.supplierName} · {r.purchaseCode}
                </p>
                <p className="commerce-note">
                  Original delivery: {r.receiptReference}
                  <br />
                  {dhakaTime(r.createdAt)} · {r.createdBy}
                </p>
                {r.items.map((i) => (
                  <p key={i.ingredientId}>
                    {i.name}: {i.quantity} {i.unit}
                  </p>
                ))}
                <p>{r.reason}</p>
                <div className="commerce-inline-actions">
                  {admin && r.status === "requested" && (
                    <Button onClick={() => open("approve", r)}>
                      Approve supplier return
                    </Button>
                  )}
                  {admin && ["requested", "approved"].includes(r.status) && (
                    <Button secondary onClick={() => open("reject", r)}>
                      Reject / withdraw return
                    </Button>
                  )}
                  {admin && r.status === "approved" && (
                    <Button onClick={() => open("confirm", r)}>
                      Confirm goods handed back
                    </Button>
                  )}
                  {r.creditNote && (
                    <Button secondary onClick={() => setNote(r)}>
                      View supplier credit note
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
          <h3>Refunds actually received</h3>
          {resource.data?.refunds.map((r) => (
            <article className="commerce-card v26-ledger" key={r.id}>
              <strong>
                {r.purchaseCode} · {money(r.amountMinor / 100)}
              </strong>
              <p>
                {r.method} · {r.reference} · {dhakaTime(r.at)} · {r.by}
              </p>
              <p>{r.reason}</p>
            </article>
          ))}
        </>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "create"
              ? "Request supplier return"
              : action.type === "refund"
                ? "Record supplier refund received"
                : action.type === "confirm"
                  ? "Confirm supplier handover"
                  : action.type === "approve"
                    ? "Approve supplier return"
                    : "Reject / withdraw supplier return"
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
                  Original purchase
                  <select
                    aria-label="Return purchase"
                    required
                    value={values.purchaseId}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        purchaseId: e.target.value,
                        receiptId: "",
                        quantities: {},
                      })
                    }
                  >
                    <option value="">Choose purchase</option>
                    {purchases.data?.purchases
                      .filter((p) => p.receivedMinor > 0)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.code} · {p.supplierName}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Original delivery receipt
                  <select
                    aria-label="Return delivery receipt"
                    required
                    value={values.receiptId}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        receiptId: e.target.value,
                        quantities: {},
                      })
                    }
                  >
                    <option value="">Choose counted delivery</option>
                    {source.data?.receipts.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.reference} · {dhakaTime(r.at)}
                      </option>
                    ))}
                  </select>
                </label>
                {receipt?.items.map((i) => (
                  <label key={i.ingredientId}>
                    {i.ingredientName} · originally received {i.quantity}{" "}
                    {i.unit}
                    <input
                      aria-label={"Return quantity " + i.ingredientName}
                      type="number"
                      min="0"
                      max={i.quantity}
                      step="1"
                      value={values.quantities[i.ingredientId] || ""}
                      onChange={(e) =>
                        setValues({
                          ...values,
                          quantities: {
                            ...values.quantities,
                            [i.ingredientId]: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
                <p className="commerce-note">
                  Pending and approved requests also reserve the original
                  receipt quantity. Only unallocated stock from the original
                  recorded lot can be handed back.
                </p>
                {source.error && (
                  <ErrorMessage>{source.error.message}</ErrorMessage>
                )}
              </>
            )}
            {action.row && (
              <p>
                {action.row.code} · {action.row.supplierName}
              </p>
            )}
            {action.type === "refund" && (
              <>
                <p>
                  Available supplier credit:{" "}
                  {money(action.row.creditMinor / 100)}
                </p>
                <label>
                  Amount received back (BDT)
                  <input
                    aria-label="Supplier refund amount"
                    required
                    inputMode="decimal"
                    value={values.amount}
                    onChange={(e) =>
                      setValues({ ...values, amount: e.target.value })
                    }
                  />
                </label>
                <label>
                  Refund channel
                  <select
                    aria-label="Supplier refund channel"
                    value={values.method}
                    onChange={(e) =>
                      setValues({ ...values, method: e.target.value })
                    }
                  >
                    {["bank", "cash", "bkash", "nagad", "card"].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="commerce-note">
                  Record a refund only after the supplier actually returns the
                  money. This does not initiate a transfer.
                </p>
              </>
            )}
            {["confirm", "refund"].includes(action.type) && (
              <>
                <label>
                  Handover / payment reference
                  <input
                    aria-label="Supplier return reference"
                    required
                    minLength={2}
                    maxLength={80}
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
                    {action.type === "confirm"
                      ? "I verified these goods were physically handed back to the supplier."
                      : "I verified the refund was actually received from the supplier."}
                  </span>
                </label>
              </>
            )}
            <label>
              Reason
              <textarea
                aria-label="Supplier return reason"
                required
                minLength={3}
                maxLength={160}
                value={values.reason}
                onChange={(e) =>
                  setValues({ ...values, reason: e.target.value })
                }
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={
                busy ||
                (["confirm", "refund"].includes(action.type) &&
                  !values.verified)
              }
            >
              {action.type === "create"
                ? "Submit supplier return request"
                : action.type === "refund"
                  ? "Record verified supplier refund"
                  : action.type === "confirm"
                    ? "Record handover & credit note"
                    : action.type === "approve"
                      ? "Confirm return approval"
                      : "Confirm return rejection"}
            </Button>
          </form>
        </Modal>
      )}
      {note && (
        <Modal
          open
          title="Supplier credit note"
          onClose={() => setNote(null)}
          className="management-dialog"
        >
          <article className="v26-credit-note">
            <h2>{note.creditNote.number}</h2>
            <p>
              {note.supplierName} · {note.purchaseCode}
            </p>
            <p>Original delivery: {note.receiptReference}</p>
            <div className="commerce-table-scroll">
              <table className="v25-table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Returned</th>
                    <th>Supplier credit</th>
                  </tr>
                </thead>
                <tbody>
                  {note.creditNote.lines.map((i) => (
                    <tr key={i.ingredientId}>
                      <td>
                        {i.name}
                        {i.batches.map((b) => (
                          <small key={b.batchId}>{b.code}</small>
                        ))}
                      </td>
                      <td>
                        {i.quantity} {i.unit}
                      </td>
                      <td>{money(i.creditMinor / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Total supplier credit:{" "}
              <strong>{money(note.creditNote.amountMinor / 100)}</strong>
            </p>
            <p>
              {note.creditNote.reference} · {dhakaTime(note.creditNote.at)}
            </p>
            <p>{note.creditNote.reason}</p>
            <p className="commerce-note">
              This records returned goods and payable credit. A money refund is
              a separate verified receipt.
            </p>
          </article>
        </Modal>
      )}
    </section>
  );
}
