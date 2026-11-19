import { useState } from "react";
import { ReceiptText, RotateCcw, RefreshCw } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Loading,
  Modal,
} from "../components/UI";
import { Receipt } from "./Receipt";

export function RefundsPanel({ user }) {
  const { money, notify } = useApp();
  const [search, setSearch] = useState(""),
    [receipt, setReceipt] = useState("");
  const resource = useResource(
    "/staff/refunds" +
      (receipt ? "?receipt=" + encodeURIComponent(receipt) : ""),
    { interval: 5000 },
  );
  const [action, setAction] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [values, setValues] = useState({
    paymentId: "",
    amount: "",
    reason: "",
    reference: "",
    verified: false,
  });
  function open(type, row) {
    setAction({ type, row, key: crypto.randomUUID().replaceAll("-", "") });
    setError("");
    const payment = row.payments?.find(
      (payment) => payment.refundableMinor > 0,
    );
    setValues({
      paymentId: payment?.id || "",
      amount: payment ? (payment.refundableMinor / 100).toFixed(2) : "",
      reason: "",
      reference: "",
      verified: false,
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { type, row } = action;
      const endpoint =
        type === "request"
          ? "/staff/bills/" + row.id + "/refunds"
          : "/staff/refunds/" +
            row.id +
            (type === "approve" || type === "reject"
              ? "/decision"
              : type === "reconcile"
                ? "/reconcile"
                : "/execute");
      const data =
        type === "request"
          ? {
              paymentId: values.paymentId,
              amountMinor: Math.round(Number(values.amount) * 100),
              reason: values.reason,
              requestKey: action.key,
            }
          : ["approve", "reject"].includes(type)
            ? { decision: type, reason: values.reason }
            : type === "reconcile"
              ? {}
              : { verified: values.verified, reference: values.reference };
      await api(endpoint, { method: "POST", data });
      setAction(null);
      await resource.reload();
      notify("Refund record updated.");
    } catch (failure) {
      setError(failure.message);
      await resource.reload();
    } finally {
      setBusy(false);
    }
  }
  if (!resource.data && !resource.error) return <Loading />;
  const selectedPayment = action?.row.payments?.find(
    (payment) => payment.id === values.paymentId,
  );
  return (
    <section className="refunds-panel">
      <div className="panel-heading">
        <div>
          <h2>Refunds & credit notes</h2>
          <p>
            Request a refund against a settled receipt. An administrator
            approves it before money is returned.
          </p>
        </div>
        <Button secondary className="button-small" onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </div>
      <form
        className="commerce-card commerce-form"
        onSubmit={(event) => {
          event.preventDefault();
          setReceipt(search.trim().toUpperCase());
        }}
      >
        <label>
          Receipt number (optional)
          <input
            placeholder="AK-…"
            maxLength={40}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <Button type="submit" className="button-small">
          Find receipt / refunds
        </Button>
      </form>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      <h3>Settled bills</h3>
      <div className="commerce-staff-grid">
        {resource.data?.bills.map((bill) => (
          <article className="commerce-card" key={bill.id}>
            <h3>
              {bill.receiptNo} · {bill.tableNumber}
            </h3>
            <p className="commerce-note">
              Original {money(bill.total)} · Refunded{" "}
              {money(bill.refundedMinor / 100)} · Retained{" "}
              {money(bill.netCollectedMinor / 100)}
            </p>
            <div className="commerce-inline-actions">
              <Button
                secondary
                className="button-small"
                disabled={
                  !bill.payments.some((payment) => payment.refundableMinor > 0)
                }
                onClick={() => open("request", bill)}
              >
                <RotateCcw size={14} />
                Request refund
              </Button>
              <Button
                secondary
                className="button-small"
                onClick={() => open("receipt", bill)}
              >
                Original receipt
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!resource.data?.bills.length && (
        <EmptyState
          title="No settled bills found"
          text="Finalize and settle a table bill, or search its exact receipt number."
        />
      )}
      <h3 className="management-section-title">Refund requests</h3>
      <div className="commerce-staff-grid">
        {resource.data?.refunds.map((refund) => (
          <article className="commerce-card" key={refund.id}>
            <div className="commerce-section-heading">
              <h3>{refund.receiptNo}</h3>
              <span className="management-status">
                {refund.status.replaceAll("_", " ")}
              </span>
            </div>
            <strong>{money(refund.amountMinor / 100)}</strong>
            <p className="commerce-note">
              {refund.method} · {refund.id}
              <br />
              {dhakaTime(refund.createdAt)}
              <br />
              Requested by {refund.requestedBy}
            </p>
            <p>{refund.reason}</p>
            {refund.approvedBy && (
              <p className="commerce-note">
                Decision by {refund.approvedBy}: {refund.decisionReason}
              </p>
            )}
            {refund.message && (
              <p className="commerce-note">{refund.message}</p>
            )}
            <div className="commerce-inline-actions">
              {refund.status === "requested" && user.role === "admin" && (
                <>
                  <Button
                    className="button-small"
                    onClick={() => open("approve", refund)}
                  >
                    Approve refund
                  </Button>
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => open("reject", refund)}
                  >
                    Reject request
                  </Button>
                </>
              )}
              {refund.status === "approved" && (
                <Button
                  className="button-small"
                  onClick={() => open("execute", refund)}
                >
                  {refund.method === "sslcommerz"
                    ? "Submit to SSLCOMMERZ"
                    : "Record money returned"}
                </Button>
              )}
              {["processing", "unknown"].includes(refund.status) && (
                <Button
                  secondary
                  className="button-small"
                  onClick={() =>
                    open(
                      refund.providerReference ? "reconcile" : "execute",
                      refund,
                    )
                  }
                >
                  {refund.providerReference
                    ? "Recheck provider"
                    : "Recover same refund attempt"}
                </Button>
              )}
              {refund.creditNote && (
                <Button
                  secondary
                  className="button-small"
                  onClick={() => open("credit", refund)}
                >
                  <ReceiptText size={14} />
                  View credit note
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!resource.data?.refunds.length && (
        <p className="commerce-note">No refund requests yet.</p>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "receipt"
              ? "Original receipt"
              : action.type === "credit"
                ? "Credit note"
                : action.type === "request"
                  ? "Request a refund"
                  : action.type === "approve"
                    ? "Approve refund"
                    : action.type === "reject"
                      ? "Reject refund"
                      : "Confirm refund action"
          }
          className="management-dialog"
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          {action.type === "receipt" ? (
            <Receipt staff bill={action.row} />
          ) : action.type === "credit" ? (
            <article className="credit-note">
              <h2>{action.row.creditNote.number}</h2>
              {action.row.creditNote.invoice && (
                <div className="invoice-business">
                  <strong>{action.row.creditNote.invoice.businessName}</strong>
                  <p>{action.row.creditNote.invoice.address}</p>
                  {action.row.creditNote.invoice.taxRegistration && (
                    <p>
                      Tax registration:{" "}
                      {action.row.creditNote.invoice.taxRegistration}
                    </p>
                  )}
                </div>
              )}
              <p>Original receipt: {action.row.receiptNo}</p>
              <p>{dhakaTime(action.row.refundedAt)}</p>
              <dl className="receipt-totals">
                <div>
                  <dt>Food credit</dt>
                  <dd>{money(action.row.creditNote.foodMinor / 100)}</dd>
                </div>
                <div>
                  <dt>Service charge credit</dt>
                  <dd>{money(action.row.creditNote.chargeMinor / 100)}</dd>
                </div>
                <div>
                  <dt>Tax credit</dt>
                  <dd>{money(action.row.creditNote.taxMinor / 100)}</dd>
                </div>
                <div>
                  <dt>Refunded</dt>
                  <dd>{money(action.row.amountMinor / 100)}</dd>
                </div>
              </dl>
              <p>Method: {action.row.method}</p>
              <p>
                Reference: {action.row.reference || "Cash return confirmed"}
              </p>
              <p>{action.row.reason}</p>
              <p className="commerce-note">
                This credit note records a confirmed refund. The original
                invoice remains unchanged.
              </p>
              <Button secondary onClick={() => window.print()}>
                Print credit note
              </Button>
            </article>
          ) : (
            <form className="commerce-form" onSubmit={submit}>
              <p>
                {action.row.receiptNo} ·{" "}
                {action.type !== "request" &&
                  money(action.row.amountMinor / 100)}
              </p>
              {action.type === "request" ? (
                <>
                  <label>
                    Original payment
                    <select
                      aria-label="Original payment"
                      value={values.paymentId}
                      onChange={(event) => {
                        const payment = action.row.payments.find(
                          (payment) => payment.id === event.target.value,
                        );
                        setValues({
                          ...values,
                          paymentId: payment.id,
                          amount: (payment.refundableMinor / 100).toFixed(2),
                        });
                      }}
                    >
                      {action.row.payments
                        .filter((payment) => payment.refundableMinor > 0)
                        .map((payment) => (
                          <option key={payment.id} value={payment.id}>
                            {payment.method} ·{" "}
                            {money(payment.refundableMinor / 100)} refundable
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Refund amount (BDT)
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      max={(selectedPayment?.refundableMinor || 0) / 100}
                      required
                      value={values.amount}
                      onChange={(event) =>
                        setValues({ ...values, amount: event.target.value })
                      }
                    />
                  </label>
                </>
              ) : null}
              {["request", "approve", "reject"].includes(action.type) && (
                <label>
                  Reason
                  <textarea
                    minLength={3}
                    maxLength={200}
                    required
                    value={values.reason}
                    onChange={(event) =>
                      setValues({ ...values, reason: event.target.value })
                    }
                  />
                </label>
              )}
              {action.type === "execute" && (
                <>
                  {action.row.method === "sslcommerz" ? (
                    <p className="commerce-note">
                      This submits the approved refund to the original payment
                      provider. A pending result is not a completed refund.
                      Recovery uses the same refund ID.
                    </p>
                  ) : (
                    <label>
                      Return-payment reference
                      <input
                        required={action.row.method !== "cash"}
                        minLength={action.row.method !== "cash" ? 3 : undefined}
                        maxLength={100}
                        value={values.reference}
                        onChange={(event) =>
                          setValues({
                            ...values,
                            reference: event.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  <label className="commerce-checkbox">
                    <input
                      type="checkbox"
                      required
                      checked={values.verified}
                      onChange={(event) =>
                        setValues({ ...values, verified: event.target.checked })
                      }
                    />
                    {action.row.method === "sslcommerz"
                      ? "I authorize the approved refund through SSLCOMMERZ."
                      : "I verified this money has been returned to the customer."}
                  </label>
                </>
              )}
              {action.type === "reconcile" && (
                <p>
                  Check the provider’s authoritative refund status. Only a
                  confirmed refund adjusts the bill and loyalty ledger.
                </p>
              )}
              {error && <ErrorMessage>{error}</ErrorMessage>}
              <Button type="submit" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : action.type === "request"
                    ? "Submit refund request"
                    : action.type === "approve"
                      ? "Confirm approval"
                      : action.type === "reject"
                        ? "Confirm rejection"
                        : "Confirm refund action"}
              </Button>
            </form>
          )}
        </Modal>
      )}
    </section>
  );
}
