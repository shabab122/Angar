import { useState } from "react";
import { Copy, KeyRound, ShieldCheck } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Logo, Modal } from "../components/UI";

export function MfaPanel({
  required = false,
  onIdentityUpdated = () => {},
  onSignedOut = () => {},
}) {
  const { notify } = useApp(),
    resource = useResource("/staff/mfa");
  const [password, setPassword] = useState(""),
    [enrollment, setEnrollment] = useState(null),
    [code, setCode] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [action, setAction] = useState(null),
    [recovery, setRecovery] = useState(null),
    [saved, setSaved] = useState(false);
  async function begin(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setEnrollment(
        await api("/staff/mfa/begin", {
          method: "POST",
          data: { currentPassword: password },
        }),
      );
      setPassword("");
      setCode("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function showCodes(result) {
    setRecovery(result);
    setSaved(false);
    setEnrollment(null);
    setAction(null);
    setPassword("");
    setCode("");
    void resource.reload();
  }
  async function enable(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      showCodes(
        await api("/staff/mfa/enable", { method: "POST", data: { code } }),
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function manage(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/staff/mfa/" + action, {
        method: "POST",
        data: { currentPassword: password, code },
      });
      if (result.recoveryCodes) showCodes(result);
      else {
        setAction(null);
        setPassword("");
        setCode("");
        await resource.reload();
        onIdentityUpdated(result.staff);
        notify("Two-factor settings updated. Other sessions were signed out.");
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const finish = () => {
    if (!saved) return;
    const identity = recovery.staff;
    setRecovery(null);
    onIdentityUpdated(identity);
    notify("Recovery codes acknowledged. Keep them somewhere private.");
  };
  const panel = (
    <section className="commerce-card mfa-panel">
      <h2>
        <ShieldCheck size={23} />
        {required
          ? "Secure administrator access"
          : "Staff two-factor authentication"}
      </h2>
      <p className="commerce-note">
        Use an authenticator app for staff sign-in. A password is followed by a
        fresh code or one unused recovery code.
      </p>
      {required && (
        <p className="commerce-note">
          Your administrator account must finish authenticator setup before
          using the workspace.
        </p>
      )}
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !action && <ErrorMessage>{error}</ErrorMessage>}
      {resource.loading ? (
        <Loading />
      ) : (
        resource.data && (
          <>
            {!resource.data.configured && (
              <ErrorMessage>
                The server operator must prepare the private MFA encryption key
                before a new authenticator can be enrolled. Follow the v2.5
                setup guide.
              </ErrorMessage>
            )}
            {resource.data.enabled ? (
              <>
                <p className="soft-badge">Authenticator enabled</p>
                <p>
                  {resource.data.recoveryCodesRemaining} unused recovery codes
                  {resource.data.enrolledAt
                    ? " · Enrolled " + dhakaTime(resource.data.enrolledAt)
                    : ""}
                </p>
                <div className="commerce-inline-actions">
                  <Button
                    secondary
                    onClick={() => {
                      setAction("recovery-codes");
                      setPassword("");
                      setCode("");
                      setError("");
                    }}
                  >
                    <KeyRound size={15} />
                    Generate new recovery codes
                  </Button>
                  <Button
                    secondary
                    onClick={() => {
                      setAction("disable");
                      setPassword("");
                      setCode("");
                      setError("");
                    }}
                  >
                    Disable authenticator
                  </Button>
                </div>
                <p className="commerce-note">
                  Changing a factor requires your password and a fresh
                  authenticator or unused recovery code. Other staff sessions
                  for this account are signed out after a change.
                </p>
              </>
            ) : enrollment ? (
              <form className="commerce-form" onSubmit={enable}>
                <h3>Scan with your authenticator</h3>
                <img
                  className="mfa-qr"
                  src={enrollment.qr}
                  alt="Authenticator setup QR code"
                  width="240"
                  height="240"
                />
                <p className="commerce-note">
                  This setup expires in {enrollment.expiresInMinutes} minutes.
                  Keep the QR code and setup key private.
                </p>
                <details>
                  <summary>Enter the setup key manually</summary>
                  <code className="mfa-secret">{enrollment.secret}</code>
                </details>
                <label>
                  Code from the new authenticator
                  <input
                    aria-label="New authenticator code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, ""))
                    }
                  />
                </label>
                <Button type="submit" disabled={busy || code.length !== 6}>
                  Confirm & enable authenticator
                </Button>
                <Button
                  secondary
                  disabled={busy}
                  onClick={() => {
                    setEnrollment(null);
                    setCode("");
                  }}
                >
                  Start a fresh setup
                </Button>
              </form>
            ) : (
              <form className="commerce-form" onSubmit={begin}>
                <label>
                  Your current staff password
                  <input
                    aria-label="Password for authenticator setup"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  disabled={busy || !resource.data.configured}
                >
                  Set up authenticator
                </Button>
              </form>
            )}
          </>
        )
      )}
      {action && (
        <Modal
          open
          title={
            action === "disable"
              ? "Disable staff authenticator"
              : "Replace recovery codes"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={manage}>
            <p className="commerce-note">
              {action === "disable"
                ? "Your next sign-in will use your password. If administrator two-factor setup is required, you must enroll again before business access."
                : "All previous recovery codes become invalid. Save the new set before leaving this page."}
            </p>
            <label>
              Current staff password
              <input
                aria-label="Password for two-factor change"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              Authenticator or unused recovery code
              <input
                aria-label="Code for two-factor change"
                autoComplete="one-time-code"
                required
                minLength={6}
                maxLength={80}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {action === "disable"
                ? "Confirm authenticator removal"
                : "Create replacement recovery codes"}
            </Button>
          </form>
        </Modal>
      )}
      {recovery && (
        <Modal
          open
          title="Save your recovery codes"
          className="management-dialog"
          onClose={finish}
        >
          <p className="commerce-note">
            These ten codes are shown once. Each can replace an authenticator
            code for one sign-in. Store them privately, away from this browser.
            After setup, wait for the next authenticator code before another
            sign-in.
          </p>
          <div className="mfa-recovery-list">
            {recovery.recoveryCodes.map((value) => (
              <code key={value}>{value}</code>
            ))}
          </div>
          <Button
            secondary
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  recovery.recoveryCodes.join("\n"),
                );
                notify("Recovery codes copied. Store them privately.");
              } catch {
                notify(
                  "Select and copy the displayed recovery codes manually.",
                );
              }
            }}
          >
            <Copy size={15} />
            Copy recovery codes
          </Button>
          <label className="commerce-checkbox">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            <span>I saved these recovery codes somewhere private.</span>
          </label>
          <Button disabled={!saved} onClick={finish}>
            Finish authenticator setup
          </Button>
        </Modal>
      )}
    </section>
  );
  return required ? (
    <main className="staff-required-password">
      <Logo />
      {panel}
      <Button
        secondary
        disabled={busy}
        onClick={async () => {
          try {
            await api("/staff/logout", { method: "POST", data: {} });
            onSignedOut();
          } catch (failure) {
            setError(failure.message);
          }
        }}
      >
        Return to staff sign in
      </Button>
    </main>
  ) : (
    panel
  );
}

export function MfaResetDialog({ target, onClose, onDone }) {
  const resource = useResource("/staff/mfa"),
    [values, setValues] = useState({
      currentPassword: "",
      code: "",
      confirmUsername: "",
      reason: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const edit = (field) => (event) =>
    setValues({ ...values, [field]: event.target.value });
  return (
    <Modal
      open
      title="Recover staff authenticator access"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="management-dialog"
    >
      <form
        className="commerce-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/staff/team/" + target.id + "/mfa-reset", {
              method: "POST",
              data: values,
            });
            onClose();
            onDone();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {target.name} · {target.username}
        </p>
        <p className="commerce-note">
          Verify this staff member's identity before recovery. This disables
          their old factor, signs out their devices and requires a password
          change. It does not reveal their setup key or recovery codes.
        </p>
        <label>
          Your administrator password
          <input
            type="password"
            aria-label="Administrator password for MFA recovery"
            autoComplete="current-password"
            required
            maxLength={128}
            value={values.currentPassword}
            onChange={edit("currentPassword")}
          />
        </label>
        {resource.data?.enabled && (
          <label>
            Your authenticator or unused recovery code
            <input
              aria-label="Administrator MFA recovery approval code"
              required
              minLength={6}
              maxLength={80}
              value={values.code}
              onChange={edit("code")}
            />
          </label>
        )}
        <label>
          Confirm staff username
          <input
            aria-label="Confirm recovered staff username"
            required
            maxLength={32}
            value={values.confirmUsername}
            onChange={edit("confirmUsername")}
          />
        </label>
        <label>
          Recovery reason
          <textarea
            aria-label="MFA recovery reason"
            required
            minLength={3}
            maxLength={160}
            value={values.reason}
            onChange={edit("reason")}
          />
        </label>
        {resource.error && (
          <ErrorMessage onRetry={resource.reload}>
            {resource.error.message}
          </ErrorMessage>
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <Button
          type="submit"
          disabled={
            busy ||
            resource.loading ||
            !!resource.error ||
            values.confirmUsername !== target.username
          }
        >
          Confirm staff MFA recovery
        </Button>
      </form>
    </Modal>
  );
}
