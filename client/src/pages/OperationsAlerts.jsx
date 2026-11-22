import { useState } from "react";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function OperationsAlerts({ user }) {
  const { notify } = useApp(),
    [history, setHistory] = useState(false),
    resource = useResource(
      "/staff/operations-alerts" + (history ? "?history=true" : ""),
      { interval: 15000 },
    );
  const [days, setDays] = useState(null),
    [email, setEmail] = useState(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(null),
    [reason, setReason] = useState(""),
    [verified, setVerified] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/operations-alerts/settings", {
        method: "POST",
        data: {
          leadDays: Number(days ?? resource.data.settings.leadDays),
          emailEnabled: email ?? resource.data.settings.emailEnabled,
          currentPassword: password,
        },
      });
      setPassword("");
      setDays(null);
      setEmail(null);
      await resource.reload();
      notify("Staff alert preferences saved.");
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
          <h2>Stock, expiry & supplier alerts</h2>
          <p>
            Conditions are checked automatically while the server runs. Kitchen
            staff see stock/expiry alerts; counter staff see overdue supplier
            balances.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh operations alerts
        </Button>
      </div>
      <label className="commerce-checkbox">
        <input
          type="checkbox"
          checked={history}
          onChange={(e) => setHistory(e.target.checked)}
        />
        <span>Include recently resolved conditions</span>
      </label>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !retry && <ErrorMessage>{error}</ErrorMessage>}
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          <div className="commerce-staff-grid">
            {resource.data?.alerts.map((a) => (
              <article className="commerce-card" key={a.id}>
                <div className="commerce-section-heading">
                  <h3>{a.title}</h3>
                  <span className="management-status">
                    {a.active
                      ? a.acknowledged
                        ? "Acknowledged"
                        : "Needs review"
                      : "Resolved"}
                  </span>
                </div>
                <p>{a.detail}</p>
                <p className="commerce-note">
                  Last seen {dhakaTime(a.lastSeenAt)}
                  {a.resolvedAt && !a.active && (
                    <>
                      <br />
                      Resolved {dhakaTime(a.resolvedAt)}
                    </>
                  )}
                </p>
                {a.active && !a.acknowledged && (
                  <Button
                    secondary
                    onClick={async () => {
                      try {
                        await api(
                          "/staff/operations-alerts/" +
                            encodeURIComponent(a.id) +
                            "/acknowledge",
                          { method: "POST", data: {} },
                        );
                        await resource.reload();
                        notify("Alert acknowledged for your account.");
                      } catch (f) {
                        setError(f.message);
                      }
                    }}
                  >
                    Acknowledge this alert
                  </Button>
                )}
              </article>
            ))}
          </div>
          {!resource.data?.alerts.length && (
            <p>
              No current conditions need attention. The next automatic scan
              checks stock, lot expiry and supplier due dates.
            </p>
          )}
          {user.role === "admin" && (
            <>
              <form className="commerce-card commerce-form" onSubmit={save}>
                <h3>Staff alert policy</h3>
                <label>
                  Upcoming expiry window (days)
                  <input
                    aria-label="Staff expiry alert days"
                    type="number"
                    min="1"
                    max="30"
                    step="1"
                    required
                    value={days ?? resource.data?.settings.leadDays ?? 7}
                    onChange={(e) => setDays(e.target.value)}
                  />
                </label>
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    aria-label="Enable daily staff email digest"
                    disabled={!resource.data?.settings.emailConfigured}
                    checked={
                      email ?? resource.data?.settings.emailEnabled ?? false
                    }
                    onChange={(e) => setEmail(e.target.checked)}
                  />
                  <span>
                    Send one daily stock/expiry/supplier digest to the
                    configured staff recipients
                  </span>
                </label>
                <p className="commerce-note">
                  {resource.data?.settings.emailConfigured
                    ? "Configured staff recipients: " +
                      resource.data.settings.emailTargets.join(", ")
                    : "Set operator-approved STAFF_ALERT_EMAIL_TO recipients and existing mail transport settings to enable email. In-app alerts work without email."}
                </p>
                <label>
                  Administrator password
                  <input
                    aria-label="Administrator password for staff alerts"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  Save staff alert policy
                </Button>
                <p className="commerce-note">
                  Acknowledgement is personal and does not resolve a stock or
                  payment condition. Restocking, lot review or verified payment
                  resolves the underlying alert on the next scan.
                </p>
              </form>
              <h3>Staff digest delivery</h3>
              {resource.data?.deliveries.map((d) => (
                <article className="commerce-card" key={d.id}>
                  <strong>
                    {d.day} · {d.status}
                  </strong>
                  <p>{d.message}</p>
                  {d.status === "uncertain" && (
                    <Button
                      secondary
                      onClick={() => {
                        setRetry(d);
                        setReason("");
                        setVerified(false);
                        setError("");
                      }}
                    >
                      Review uncertain staff digest
                    </Button>
                  )}
                </article>
              ))}
            </>
          )}
        </>
      )}
      {retry && (
        <Modal
          open
          title="Review staff digest retry"
          onClose={() => {
            if (!busy) setRetry(null);
          }}
        >
          <form
            className="commerce-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(
                  "/staff/operations-alerts/deliveries/" + retry.id + "/retry",
                  {
                    method: "POST",
                    data: { reason, confirmDuplicateRisk: verified },
                  },
                );
                setRetry(null);
                await resource.reload();
              } catch (f) {
                setError(f.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              Check the configured mailbox before retrying. An uncertain send
              may already have arrived.
            </p>
            <label>
              Reason
              <textarea
                aria-label="Staff digest retry reason"
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                required
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />
              <span>
                I checked delivery and accept that this retry may send another
                copy.
              </span>
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy || !verified}>
              Queue reviewed staff digest retry
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
