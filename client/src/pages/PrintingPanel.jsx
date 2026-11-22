import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, dhakaTime, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
import { Receipt } from "./Receipt";
export default function PrintingPanel({ user }) {
  const { notify } = useApp(),
    resource = useResource("/staff/printing", { interval: 5000 });
  const [action, setAction] = useState(null),
    [reason, setReason] = useState(""),
    [verified, setVerified] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [password, setPassword] = useState(""),
    [enabled, setEnabled] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (action) {
        await api("/staff/printing/jobs/" + action.job.id + "/" + action.type, {
          method: "POST",
          data: {
            reason,
            ...(action.type === "confirm"
              ? { verified }
              : action.type === "reprint"
                ? { requestKey: action.key }
                : {}),
          },
        });
        setAction(null);
      } else {
        await api("/staff/printing/settings", {
          method: "POST",
          data: {
            autoEnabled: enabled ?? resource.data.autoEnabled,
            currentPassword: password,
          },
        });
        setPassword("");
        setEnabled(null);
      }
      await resource.reload();
      notify("Printing record updated.");
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
          <h2>Kitchen tickets & receipt printing</h2>
          <p>
            Kitchen acceptance creates a ticket automatically; approved changes
            and cancellations create a separate revision. Confirm physical paper
            output before marking it printed.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh print queue
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !action && <ErrorMessage>{error}</ErrorMessage>}
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          {user.role === "admin" && (
            <form className="commerce-form commerce-card" onSubmit={submit}>
              <h3>Automatic kitchen printer</h3>
              <p className="commerce-note">
                {resource.data?.configured
                  ? "The operator-configured network printer is ready for an acceptance test."
                  : "Configure a compatible TCP printer on the server to enable automatic sending. Browser thermal print is available now."}
              </p>
              <p className="commerce-note">
                Raw profile: English ASCII ESC/POS, {resource.data?.columns}{" "}
                columns. Use browser print for Bengali / Unicode notes and a
                system-configured printer. Select 80 mm paper and 100% scale in
                the print dialog.
              </p>
              <label className="commerce-checkbox">
                <input
                  type="checkbox"
                  aria-label="Automatic kitchen printer enabled"
                  disabled={!resource.data?.configured}
                  checked={enabled ?? resource.data?.autoEnabled ?? false}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>
                  Send newly created kitchen tickets automatically to the
                  configured printer
                </span>
              </label>
              <label>
                Administrator password
                <input
                  aria-label="Administrator password for printer"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={busy}>
                Save printer preference
              </Button>
              <p className="commerce-note">
                Disabling stops automatic pending jobs. Already sent bytes
                cannot be recalled. Uncertain transmissions require a physical
                check and an explicitly marked copy.
              </p>
            </form>
          )}
          <div className="commerce-staff-grid">
            {resource.data?.jobs.map((job) => (
              <article className="commerce-card" key={job.id}>
                <div className="commerce-section-heading">
                  <h3>{job.sourceCode}</h3>
                  <span className="management-status">
                    {job.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p>
                  {job.title} · {job.event}
                </p>
                <p className="commerce-note">
                  {dhakaTime(job.createdAt)} · {job.by}
                  {job.copyOf && (
                    <>
                      <br />
                      Marked reprint / copy
                    </>
                  )}
                </p>
                <p>{job.message}</p>
                <div className="commerce-inline-actions">
                  <a
                    className="button button-secondary button-small"
                    target="_blank"
                    rel="noreferrer"
                    href={"/staff/print/" + job.id}
                  >
                    Open thermal print preview
                  </a>
                  {["ready", "failed", "browser_required"].includes(
                    job.status,
                  ) &&
                    resource.data.configured && (
                      <Button
                        secondary
                        className="button-small"
                        onClick={() => {
                          setAction({ type: "send", job });
                          setReason("");
                          setError("");
                        }}
                      >
                        Send to configured printer
                      </Button>
                    )}
                  {job.status !== "printed" &&
                    !["sending", "superseded"].includes(job.status) && (
                      <Button
                        secondary
                        className="button-small"
                        onClick={() => {
                          setAction({ type: "confirm", job });
                          setReason("");
                          setVerified(false);
                          setError("");
                        }}
                      >
                        Confirm physical print
                      </Button>
                    )}
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => {
                      setAction({ type: "reprint", job, key: requestKey() });
                      setReason("");
                      setError("");
                    }}
                  >
                    Request marked reprint
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!resource.data?.jobs.length && (
            <p>
              No kitchen or receipt print jobs yet. The counter's receipt view
              includes an 80 mm thermal preview.
            </p>
          )}
        </>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "confirm"
              ? "Confirm physical paper output"
              : action.type === "send"
                ? "Send this job to the printer"
                : "Create a marked reprint"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            <p>{action.job.sourceCode}</p>
            {action.type === "reprint" && (
              <p className="commerce-note">
                Check existing physical output first. A new ticket explicitly
                marked REPRINT / COPY will be created.
              </p>
            )}
            <label>
              Reason
              <textarea
                aria-label="Printer action reason"
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {action.type === "confirm" && (
              <label className="commerce-checkbox">
                <input
                  type="checkbox"
                  required
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                <span>I checked the physical printed output.</span>
              </label>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={busy || (action.type === "confirm" && !verified)}
            >
              {action.type === "confirm"
                ? "Record verified paper output"
                : action.type === "send"
                  ? "Queue this printer transmission"
                  : "Create separate marked copy"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
export function PrintJobPreview() {
  const { id } = useParams(),
    resource = useResource("/staff/printing/jobs/" + id),
    job = resource.data?.job;
  return (
    <main className="v26-print-preview">
      {resource.error ? (
        <ErrorMessage>{resource.error.message}</ErrorMessage>
      ) : !job ? (
        <Loading />
      ) : (
        <>
          <div className="v26-no-print">
            <Button
              disabled={job.status === "superseded"}
              onClick={() => window.print()}
            >
              Print this ticket
            </Button>
            <p>
              Choose the system printer, 80 mm paper and 100% scale. Cancel the
              dialog if the preview is incomplete. Confirm physical output from
              the staff print queue.
            </p>
            <a href="/staff">Return to staff workspace</a>
          </div>
          <article className="v26-thermal-ticket">
            <h1>{job.title}</h1>
            {job.status === "superseded" && (
              <strong>SUPERSEDED — USE THE LATEST TICKET</strong>
            )}
            <p>{dhakaTime(job.createdAt)}</p>
            {job.lines.map((line, index) => (
              <p key={index}>{line || " "}</p>
            ))}
          </article>
        </>
      )}
    </main>
  );
}
export function ThermalReceipt() {
  const { id } = useParams(),
    navigate = useNavigate(),
    resource = useResource("/staff/bills/" + id),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="v26-thermal-receipt">
      {resource.error ? (
        <ErrorMessage>{resource.error.message}</ErrorMessage>
      ) : !resource.data?.bill ? (
        <Loading />
      ) : (
        <>
          <div className="v26-no-print">
            <p>
              Select 80 mm paper and 100% scale in your system print dialog.
              Unicode text is preserved by browser printing.
            </p>
            <Button
              secondary
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api("/staff/printing/receipts/" + id, {
                    method: "POST",
                    data: { requestKey: requestKey() },
                  });
                  navigate("/staff/print/" + result.job.id);
                } catch (f) {
                  setError(f.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create network-printer receipt job
            </Button>
            {error && <ErrorMessage>{error}</ErrorMessage>}
          </div>
          <Receipt staff thermal bill={resource.data.bill} />
        </>
      )}
    </main>
  );
}
