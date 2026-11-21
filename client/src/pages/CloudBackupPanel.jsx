import { useState } from "react";
import { CloudUpload, ShieldCheck } from "lucide-react";
import { api, dhakaTime } from "../lib/api";
import { useApp } from "../lib/AppContext";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";

export function CloudBackupPanel() {
  const { notify } = useApp(),
    resource = useResource("/staff/backup-cloud", { interval: 5000 }),
    backups = useResource("/staff/backups", { interval: 5000 });
  const [enabled, setEnabled] = useState(null),
    [password, setPassword] = useState(""),
    [backupId, setBackupId] = useState(""),
    [retry, setRetry] = useState(null),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(path, data, message) {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST", data });
      setPassword("");
      setEnabled(null);
      setRetry(null);
      await resource.reload();
      notify(message);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (!resource.data && !resource.error) return <Loading />;
  const sources =
    backups.data?.jobs.filter(
      (job) => job.type === "create" && job.status === "completed",
    ) || [];
  return (
    <section className="cloud-backup-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <CloudUpload size={23} />
            Off-site backup copies
          </h2>
          <p>
            Copy encrypted backup bundles to your private cloud bucket. A copy
            is verified only after its bytes are downloaded and checked.
          </p>
        </div>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !retry && <ErrorMessage>{error}</ErrorMessage>}
      {!resource.data?.configured && (
        <p className="commerce-note">
          The server operator needs to configure an S3-compatible private bucket
          and credentials using the v2.5 guide. Then automatic copies can be
          enabled here.
        </p>
      )}
      {resource.data?.destination && (
        <p className="commerce-note">
          Destination: <strong>{resource.data.destination.bucket}</strong> ·{" "}
          {resource.data.destination.region} ·{" "}
          {resource.data.destination.prefix}
        </p>
      )}
      <form
        className="commerce-card commerce-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            "/staff/backup-cloud/settings",
            {
              enabled: enabled ?? resource.data.enabled,
              currentPassword: password,
            },
            "Cloud-copy preference saved.",
          );
        }}
      >
        <h3>Automatic cloud synchronization</h3>
        <label className="commerce-checkbox">
          <input
            type="checkbox"
            aria-label="Enable automatic cloud backup copies"
            checked={enabled ?? resource.data?.enabled ?? false}
            disabled={!resource.data?.configured || busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            Automatically copy completed encrypted backups to this bucket
          </span>
        </label>
        <label>
          Your administrator password
          <input
            aria-label="Administrator password for cloud copies"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !resource.data}>
          Save cloud-copy preference
        </Button>
        <p className="commerce-note">
          Enabling also queues existing local completed backups. In-flight or
          previously queued copies may finish after automatic copying is
          disabled. Local retention keeps a source until its cloud copy is
          verified. Cloud-bucket retention is managed separately by your
          operator.
        </p>
      </form>
      <form
        className="commerce-card commerce-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            "/staff/backup-cloud/" + backupId + "/copy",
            {},
            "Encrypted cloud copy queued.",
          );
        }}
      >
        <h3>Copy an existing backup</h3>
        <label>
          Completed local backup
          <select
            aria-label="Backup for cloud copy"
            required
            value={backupId}
            onChange={(event) => setBackupId(event.target.value)}
          >
            <option value="">Choose a backup</option>
            {sources.map((job) => (
              <option key={job.id} value={job.id}>
                {job.id} · {dhakaTime(job.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          disabled={busy || !backupId || !resource.data?.configured}
        >
          Queue cloud copy
        </Button>
      </form>
      <div className="commerce-staff-grid">
        {resource.data?.jobs.map((job) => (
          <article className="commerce-card" key={job.id}>
            <div className="commerce-section-heading">
              <h3>
                {job.status === "verified" && <ShieldCheck size={16} />}
                Encrypted backup copy
              </h3>
              <span className="management-status">{job.status}</span>
            </div>
            <p className="commerce-note v25-break">
              {job.backupId}
              <br />
              {job.destination.bucket} · {job.destination.prefix}
              <br />
              {dhakaTime(job.createdAt)} · Attempt {job.attempts}
            </p>
            <p>{job.message || "Waiting for the cloud-copy worker."}</p>
            {job.verifiedAt && (
              <p className="commerce-note">
                Verified {dhakaTime(job.verifiedAt)} ·{" "}
                {(job.bytes / 1024).toFixed(1)} KiB
                <br />
                SHA-256: <span className="v25-break">{job.sha256}</span>
              </p>
            )}
            {job.status === "retrying" && (
              <p className="commerce-note">
                Next attempt: {dhakaTime(job.nextAt)}
              </p>
            )}
            {job.status === "failed" && (
              <Button
                secondary
                className="button-small"
                onClick={() => {
                  setRetry(job);
                  setReason("");
                  setError("");
                }}
              >
                Review cloud-copy retry
              </Button>
            )}
          </article>
        ))}
      </div>
      {!resource.data?.jobs.length && (
        <p className="commerce-note">
          No off-site copies have been queued yet.
        </p>
      )}
      <p className="commerce-note">
        Keep the original backup encryption key in separate private recovery
        material. The v2.5 guide includes remote listing, download and isolated
        restore commands.
      </p>
      {retry && (
        <Modal
          open
          title="Retry encrypted cloud copy"
          onClose={() => {
            if (!busy) setRetry(null);
          }}
        >
          <form
            className="commerce-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "/staff/backup-cloud/" + retry.id + "/retry",
                { reason },
                "Cloud-copy retry queued.",
              );
            }}
          >
            <p className="v25-break">{retry.backupId}</p>
            <p className="commerce-note">
              Confirm the original local bundle and cloud destination are
              available. A remote object with different contents will not be
              overwritten.
            </p>
            <label>
              Reason
              <textarea
                aria-label="Cloud-copy retry reason"
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Queue cloud-copy retry
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
