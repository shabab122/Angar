import { branchUrl } from "../lib/branch";
import { useEffect, useState } from "react";
import { DatabaseBackup, Download, ShieldCheck } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading } from "../components/UI";
import { CloudBackupPanel } from "./CloudBackupPanel";

export function BackupsPanel() {
  const { notify } = useApp(),
    resource = useResource("/staff/backups", { interval: 3000 });
  const [values, setValues] = useState(null),
    [dirty, setDirty] = useState(false),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (resource.data && !dirty) setValues(resource.data.settings);
  }, [resource.data, dirty]);
  async function run(endpoint, data = {}) {
    setBusy(true);
    setError("");
    try {
      await api(endpoint, { method: "POST", data });
      setPassword("");
      setDirty(false);
      await resource.reload();
      notify("Backup operation saved. Its status will update here.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (!values)
    return resource.error ? (
      <ErrorMessage onRetry={resource.reload}>
        {resource.error.message}
      </ErrorMessage>
    ) : (
      <Loading />
    );
  const change = (field, value) => {
    setDirty(true);
    setValues({ ...values, [field]: value });
  };
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Backups & recovery</h2>
          <p>
            Encrypted database snapshots and referenced review photos. Restore
            checks use a separate database and media folder.
          </p>
        </div>
        <Button
          className="button-small"
          disabled={busy || !resource.data.ready}
          onClick={() => run("/staff/backups")}
        >
          <DatabaseBackup size={15} />
          Create backup now
        </Button>
      </div>
      {!resource.data.ready && (
        <ErrorMessage>
          Run setup to generate a backup encryption key. Keep a separate secure
          copy of that key for recovery.
        </ErrorMessage>
      )}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <form
        className="commerce-card commerce-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run("/staff/backups/settings", {
            enabled: values.enabled,
            everyHours: Number(values.everyHours),
            keep: Number(values.keep),
            currentPassword: password,
          });
        }}
      >
        <h2>Automatic schedule</h2>
        <label className="commerce-checkbox">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(event) => change("enabled", event.target.checked)}
          />
          Enable scheduled backups while the server is running
        </label>
        <div className="commerce-two">
          <label>
            Every (hours)
            <input
              type="number"
              min="1"
              max="168"
              step="1"
              required
              value={values.everyHours}
              onChange={(event) => change("everyHours", event.target.value)}
            />
          </label>
          <label>
            Keep latest backups
            <input
              type="number"
              min="1"
              max="30"
              step="1"
              required
              value={values.keep}
              onChange={(event) => change("keep", event.target.value)}
            />
          </label>
        </div>
        <label>
          Your administrator password
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !resource.data.ready}>
          Save backup schedule
        </Button>
        <p className="commerce-note">
          {values.enabled && values.nextAt
            ? "Next scheduled run: " + dhakaTime(values.nextAt)
            : "Automatic backups are currently disabled."}{" "}
          Keep an encrypted copy on separate durable storage. This server cannot
          create a backup while it is shut down.
        </p>
      </form>
      <div className="commerce-staff-grid">
        {resource.data.jobs.map((job) => (
          <article className="commerce-card" key={job.id}>
            <div className="commerce-section-heading">
              <h3>
                {job.type === "verify"
                  ? "Restore verification"
                  : "Encrypted backup"}
              </h3>
              <span className="management-status">{job.status}</span>
            </div>
            <p className="commerce-note">
              {job.id}
              <br />
              {dhakaTime(job.createdAt)}
              {job.bundleId && (
                <>
                  <br />
                  Source: {job.bundleId}
                </>
              )}
            </p>
            <p>{job.message || "Waiting for the background worker."}</p>
            {job.result && (
              <p className="commerce-note">
                {Array.isArray(job.result.collections)
                  ? job.result.collections.length
                  : job.result.collections}{" "}
                collections · {job.result.documents ?? "Verified"} documents ·{" "}
                {job.result.photos} photos
              </p>
            )}
            {job.type === "create" && job.status === "completed" && (
              <div className="commerce-inline-actions">
                <a
                  className="button button-secondary button-small"
                  href={branchUrl("/api/staff/backups/" + job.id + "/download")}
                >
                  <Download size={14} />
                  Download encrypted backup
                </a>
                <Button
                  secondary
                  className="button-small"
                  disabled={busy}
                  onClick={() => run("/staff/backups/" + job.id + "/verify")}
                >
                  <ShieldCheck size={14} />
                  Verify isolated restore
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
      <p className="commerce-note">
        For recovery, use the documented backup:restore command with a new
        database name. Live databases are never overwritten through this page.
        Sessions, recovery links and pending message jobs are cleared in
        restored copies.
      </p>
      <CloudBackupPanel />
    </section>
  );
}
