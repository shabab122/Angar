import { useState } from "react";
import { useResource } from "../lib/useResource";
import { api } from "../lib/api";
import { useApp } from "../lib/AppContext";
import { Button, ErrorMessage, Loading } from "../components/UI";

export default function ChatbotPanel() {
  const resource = useResource("/staff/assistant"),
    { notify } = useApp();
  const [password, setPassword] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/assistant", {
        method: "PUT",
        data: {
          enabled: !resource.data.enabled,
          expectedRevision: resource.data.revision,
          currentPassword: password,
          reason,
        },
      });
      setPassword("");
      setReason("");
      await resource.reload();
      notify("Customer assistant settings saved.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  const data = resource.data;
  return (
    <section className="v210-staff-panel">
      <div className="panel-heading">
        <div>
          <h2>Customer AI assistant</h2>
          <p>Grounded menu help, powered by your local Ollama model.</p>
        </div>
        <Button secondary onClick={resource.reload}>
          Check local AI connection
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {data && (
        <>
          <div className="commerce-card v210-ai-status">
            <strong>
              {data.enabled
                ? "Assistant enabled in this branch"
                : "Assistant paused in this branch"}
            </strong>
            <dl>
              <dt>Local model status</dt>
              <dd>{data.health.state}</dd>
              <dt>Model</dt>
              <dd>{data.model}</dd>
              <dt>Operator-configured endpoint</dt>
              <dd>{data.baseUrl}</dd>
              <dt>Maximum simultaneous AI requests</dt>
              <dd>{data.maxConcurrent}</dd>
              <dt>Chat retention</dt>
              <dd>
                {data.retentionHours} hours; last 10 question/answer turns
              </dd>
            </dl>
          </div>
          <p className="commerce-note">
            The assistant uses current branch menu data, approved public guest
            ratings and recent completed-order popularity. Seeded sample reviews
            do not count. It interprets questions with local AI and renders
            facts from the database; it cannot place orders, reserve tables,
            change points, charge money or approve refunds.
          </p>
          {data.health.state !== "ready" && (
            <p className="v210-ai-notice">
              Local AI is not ready. Customers get a clearly labelled basic menu
              guide. Install Ollama on the application server, pull the
              configured local model, and check the connection again. Full
              commands and examples are in UPGRADE_v2.10_BN.md.
            </p>
          )}
          <p className="commerce-note">
            Model and endpoint changes belong in the operator’s .env. No
            customer credentials, private orders or staff data are sent as model
            context. Chat text is private to its customer/account or signed
            guest browser and branch. Chat conversations are excluded from
            application backups. This dashboard does not expose customer
            conversations.
          </p>
          <form className="commerce-form" onSubmit={save}>
            <label>
              Reason
              <input
                aria-label="Assistant setting reason"
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label>
              Administrator password
              <input
                aria-label="Assistant administrator password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              disabled={busy || (!data.enabled && !data.configured)}
            >
              {busy
                ? "Saving…"
                : data.enabled
                  ? "Pause customer assistant"
                  : "Enable customer assistant"}
            </Button>
          </form>
        </>
      )}
    </section>
  );
}
