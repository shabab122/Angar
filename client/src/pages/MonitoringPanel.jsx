import { useState } from "react";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function MonitoringPanel({ user }) {
  const resource = useResource("/monitoring", { interval: 15000 }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(null),
    [password, setPassword] = useState(""),
    [verified, setVerified] = useState(false),
    data = resource.data,
    canManage = user.platformCapabilities?.["monitoring.manage"];
  async function run(event) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (action.type === "settings")
        await api("/monitoring/settings", {
          method: "PATCH",
          data: {
            emailEnabled: !data.settings.emailEnabled,
            currentPassword: password,
          },
        });
      else
        await api(
          "/monitoring/deliveries/" + encodeURIComponent(action.id) + "/retry",
          {
            method: "POST",
            data: {
              currentPassword: password,
              duplicateRiskAccepted: verified,
            },
          },
        );
      setPassword("");
      setAction(null);
      await resource.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  return (
    <section className="v28-panel">
      <div className="panel-heading">
        <div>
          <h2>Technical incidents & monitoring</h2>
          <p>
            API failures, background jobs and worker heartbeats across branches.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh incidents
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !action && <ErrorMessage>{error}</ErrorMessage>}
      {data && (
        <>
          <article className="commerce-card">
            <h3>Technical email alerts</h3>
            <p>
              {data.settings.emailEnabled ? "Enabled" : "Disabled"} ·{" "}
              {data.settings.recipientCount} configured recipients ·{" "}
              {data.settings.emailReady
                ? "Mail delivery configured"
                : "SMTP and recipients required"}
            </p>
            {canManage && (
              <Button
                secondary
                disabled={
                  !data.settings.emailEnabled && !data.settings.emailReady
                }
                onClick={() => {
                  setError("");
                  setPassword("");
                  setAction({ type: "settings" });
                }}
              >
                {data.settings.emailEnabled
                  ? "Disable technical emails"
                  : "Enable technical emails"}
              </Button>
            )}
            <p className="commerce-note">
              Downtime alerts require the independent{" "}
              <code>npm run monitor:watch</code> process. Run it outside the
              application host to detect host or network outages. Setup is in
              MONITORING.md.
            </p>
          </article>
          <h3>Service heartbeats</h3>
          {!data.instances.length && (
            <p>
              No monitoring process heartbeat is available. Start the
              application with npm start.
            </p>
          )}
          <div className="commerce-staff-grid">
            {data.instances.map((instance) => (
              <article className="commerce-card" key={instance._id}>
                <p>Last heartbeat: {dhakaTime(instance.at)}</p>
                <p>
                  {instance.requests} API requests · {instance.failures} server
                  errors · {instance.slow} slow requests since process start
                </p>
                {instance.workers.map((worker) => (
                  <p
                    className="commerce-note"
                    key={worker.branchId + worker.name}
                  >
                    {worker.branchId} / {worker.name} ·{" "}
                    {worker.ok ? "OK" : "Needs review"} · {dhakaTime(worker.at)}
                  </p>
                ))}
              </article>
            ))}
          </div>
          <h3>Incidents</h3>
          {!data.incidents.length && <p>No technical incidents recorded.</p>}
          <div className="commerce-staff-grid">
            {data.incidents.map((row) => (
              <article className="commerce-card" key={row._id}>
                <div className="v27-inline">
                  <h4>{row.title}</h4>
                  <span className="soft-badge">{row.status}</span>
                </div>
                <p>
                  {row.branchId} · {row.occurrences} occurrence(s) ·{" "}
                  {dhakaTime(row.lastSeenAt)}
                </p>
                {row.acknowledgedAt ? (
                  <p className="commerce-note">
                    Acknowledged by {row.acknowledgedBy}
                  </p>
                ) : (
                  canManage &&
                  row.status === "open" && (
                    <Button
                      secondary
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api(
                            "/monitoring/incidents/" + row._id + "/acknowledge",
                            { method: "POST", data: {} },
                          );
                          await resource.reload();
                        } catch (failure) {
                          setError(failure.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Acknowledge incident
                    </Button>
                  )
                )}
              </article>
            ))}
          </div>
          <h3>Alert delivery history</h3>
          <div className="v28-table-wrap">
            <table className="v28-table">
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Event</th>
                  <th>Delivery</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((row) => (
                  <tr key={row._id}>
                    <td>{row.title}</td>
                    <td>{row.event}</td>
                    <td>{row.status}</td>
                    <td>
                      {row.status === "uncertain" && canManage && (
                        <Button
                          secondary
                          onClick={() => {
                            setPassword("");
                            setVerified(false);
                            setError("");
                            setAction({ type: "retry", id: row._id });
                          }}
                        >
                          Review alert retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "settings"
              ? "Change technical emails"
              : "Review uncertain alert"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={run}>
            {action.type === "retry" && (
              <label className="check-line">
                <input
                  required
                  type="checkbox"
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                I checked mail delivery and accept a possible duplicate alert.
              </label>
            )}
            <label>
              Administrator password
              <input
                aria-label="Monitoring administrator password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save monitoring action"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
