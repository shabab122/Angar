import { useState } from "react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Modal } from "../components/UI";

export function ExternalRefundSources({ user, onRequested }) {
  const { money, notify } = useApp(),
    resource = useResource("/staff/refund-sources", { interval: 5000 });
  const [source, setSource] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function request(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/refund-sources/" + source.source + "/" + source.id, {
        method: "POST",
        data: {
          amountMinor: Math.round(Number(values.amount) * 100),
          reason: values.reason,
          requestKey: values.key,
          cancelEvent: values.cancelEvent,
          ...(source.source === "event" ? { returnMethod: values.method } : {}),
        },
      });
      setSource(null);
      await resource.reload();
      await onRequested();
      notify(
        "Refund requested. An administrator must approve it before money is returned.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="external-refund-sources">
      <h3>Event deposits & excess online payments</h3>
      <p className="commerce-note">
        These funds have their own refund balance. Returning them does not
        reduce a food invoice or reverse food loyalty points.
      </p>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      <div className="commerce-staff-grid">
        {resource.data?.sources.map((row) => (
          <article className="commerce-card" key={row.source + row.id}>
            <h3>{row.code}</h3>
            <p className="commerce-note">
              {row.source === "event"
                ? "Event deposit"
                : "Verified excess payment"}{" "}
              · {row.status}
              {row.startsAt && (
                <>
                  <br />
                  {dhakaTime(row.startsAt)}
                </>
              )}
            </p>
            <p>
              Received {money(row.originalMinor / 100)} · Returned{" "}
              {money(row.refundedMinor / 100)} · Pending{" "}
              {money(row.heldMinor / 100)}
            </p>
            <p className="commerce-note">Reference: {row.reference}</p>
            <Button
              secondary
              className="button-small"
              disabled={row.refundableMinor <= 0}
              onClick={() => {
                setSource(row);
                setError("");
                setValues({
                  amount: (row.refundableMinor / 100).toFixed(2),
                  reason: "",
                  method: "cash",
                  cancelEvent: false,
                  key: crypto.randomUUID().replaceAll("-", ""),
                });
              }}
            >
              Request source refund
            </Button>
          </article>
        ))}
      </div>
      {!resource.data?.sources.length && (
        <p className="commerce-note">
          No received event deposits or verified excess payments yet.
        </p>
      )}
      {source && (
        <Modal
          open
          title="Refund original funds"
          className="management-dialog"
          onClose={() => {
            if (!busy) setSource(null);
          }}
        >
          <form className="commerce-form" onSubmit={request}>
            <p>
              {source.code} · Available {money(source.refundableMinor / 100)}
            </p>
            <label>
              Refund amount (BDT)
              <input
                type="number"
                step="0.01"
                min="0.01"
                max={source.refundableMinor / 100}
                required
                value={values.amount}
                onChange={(event) =>
                  setValues({ ...values, amount: event.target.value })
                }
              />
            </label>
            {source.source === "event" ? (
              <>
                <label>
                  Return channel
                  <select
                    aria-label="Return channel"
                    value={values.method}
                    onChange={(event) =>
                      setValues({ ...values, method: event.target.value })
                    }
                  >
                    {["cash", "bkash", "nagad", "card"].map((method) => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </select>
                </label>
                {source.canCancelEvent && user.role === "admin" && (
                  <label className="commerce-checkbox">
                    <input
                      type="checkbox"
                      checked={values.cancelEvent}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          cancelEvent: event.target.checked,
                        })
                      }
                    />
                    Cancel the future booking and release its venue hold when
                    this request is submitted
                  </label>
                )}
                <p className="commerce-note">
                  A refund request alone keeps the booking active unless the
                  administrator explicitly cancels it. Record the money only
                  after it has actually been returned.
                </p>
              </>
            ) : (
              <p className="commerce-note">
                This refund goes back through the original SSLCOMMERZ
                transaction. A provider-confirmed result is required before it
                is marked refunded.
              </p>
            )}
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
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy ? "Submitting…" : "Submit source refund request"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
