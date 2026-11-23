const StaffPermissions = lazy(() => import("./StaffPermissions"));
import { lazy, Suspense, useState } from "react";
import { LockKeyhole, UserPlus, UsersRound } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Logo, Modal } from "../components/UI";
import { MfaResetDialog } from "./MfaPanel";

export function StaffPassword({ required = false, onSignedOut }) {
  const { notify } = useApp();
  const [values, setValues] = useState({
    currentPassword: "",
    newPassword: "",
    confirmation: "",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    if (values.newPassword !== values.confirmation) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/staff/password", {
        method: "POST",
        data: {
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        },
      });
      setValues({ currentPassword: "", newPassword: "", confirmation: "" });
      notify("Password updated. Sign in again with your new password.");
      onSignedOut();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const form = (
    <article className="commerce-card staff-access-card">
      <h2>
        <LockKeyhole size={22} />
        {required ? "Set your own staff password" : "My access"}
      </h2>
      <p className="commerce-note">
        {required
          ? "Your administrator provided a temporary password. Choose a personal password before opening your workspace."
          : "Changing your password signs out every device using this staff account."}
      </p>
      <form className="commerce-form" onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={values.currentPassword}
            onChange={(event) =>
              setValues({ ...values, currentPassword: event.target.value })
            }
          />
        </label>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={values.newPassword}
            onChange={(event) =>
              setValues({ ...values, newPassword: event.target.value })
            }
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={values.confirmation}
            onChange={(event) =>
              setValues({ ...values, confirmation: event.target.value })
            }
          />
        </label>
        <small>
          Use at least 12 characters. Choose a password different from your
          current one.
        </small>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <Button type="submit" disabled={busy}>
          {busy ? "Updating…" : "Update my password"}
        </Button>
        {required && (
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
        )}
      </form>
    </article>
  );
  return required ? (
    <main className="staff-required-password">
      <Logo />
      {form}
    </main>
  ) : (
    form
  );
}

export function StaffAccounts({ user: currentUser }) {
  const { notify } = useApp();
  const resource = useResource("/staff/team", { interval: 15000 });
  const [permissionTarget, setPermissionTarget] = useState(null);
  const [mfaReset, setMfaReset] = useState(null);
  const [action, setAction] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [values, setValues] = useState({
    username: "",
    name: "",
    role: "waiter",
    active: true,
    password: "",
    currentPassword: "",
    reason: "",
  });
  function open(type, user) {
    setAction({ type, user });
    setError("");
    setValues({
      username: user?.username || "",
      name: user?.name || "",
      role: user?.role || "waiter",
      active: user?.active ?? true,
      password: "",
      currentPassword: "",
      reason: "",
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { type, user } = action;
      await api(
        type === "create"
          ? "/staff/team"
          : "/staff/team/" + user.id + (type === "password" ? "/password" : ""),
        {
          method: type === "edit" ? "PATCH" : "POST",
          data:
            type === "create"
              ? {
                  username: values.username,
                  name: values.name,
                  role: values.role,
                  password: values.password,
                  currentPassword: values.currentPassword,
                }
              : type === "edit"
                ? {
                    name: values.name,
                    role: values.role,
                    active: values.active,
                    reason: values.reason,
                    currentPassword: values.currentPassword,
                  }
                : {
                    newPassword: values.password,
                    currentPassword: values.currentPassword,
                    reason: values.reason,
                  },
        },
      );
      setAction(null);
      setValues({
        username: "",
        name: "",
        role: "waiter",
        active: true,
        password: "",
        currentPassword: "",
        reason: "",
      });
      await resource.reload();
      notify(
        type === "create"
          ? "Staff account created. Share its temporary password privately."
          : "Staff access updated.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (!resource.data && !resource.error) return <Loading />;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Staff accounts</h2>
          <p>
            Give each team member an individual account. Existing station
            accounts remain available.
          </p>
        </div>
        <Button className="button-small" onClick={() => open("create")}>
          <UserPlus size={15} />
          Create staff account
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      <div className="commerce-staff-grid">
        {resource.data?.users.map((user) => (
          <article className="commerce-card" key={user.id}>
            <div className="commerce-section-heading">
              <h3>
                <UsersRound size={16} /> {user.name}
              </h3>
              <span className="management-status">
                {user.active ? "Active" : "Inactive"}
              </span>
            </div>
            <p>
              {user.username} · {user.role}
            </p>
            <p className="commerce-note">
              {user.mustChangePassword &&
                "Personal password required at next sign in. "}
              {user.mfaEnabled
                ? "Authenticator enabled. "
                : "Authenticator not enrolled. "}
              {user.lastLoginAt
                ? "Last sign in: " + dhakaTime(user.lastLoginAt)
                : "No recorded sign in yet."}
            </p>
            <p className="commerce-note">
              Branches: {(user.branchIds || ["main"]).join(", ")} · Restricted
              actions: {user.denied?.length || 0}
            </p>
            <div className="commerce-inline-actions">
              {currentUser?.platformAdmin &&
                user.username !== currentUser.username && (
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => setPermissionTarget(user)}
                  >
                    Permissions & limits
                  </Button>
                )}
              <Button
                secondary
                className="button-small"
                onClick={() => open("edit", user)}
              >
                Edit access
              </Button>
              <Button
                secondary
                className="button-small"
                onClick={() => open("password", user)}
              >
                Reset temporary password
              </Button>
              {user.mfaEnabled && user.username !== currentUser?.username && (
                <Button
                  secondary
                  className="button-small"
                  onClick={() => setMfaReset(user)}
                >
                  Recover authenticator access
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {permissionTarget && (
        <Suspense fallback={<Loading />}>
          <StaffPermissions
            target={permissionTarget}
            onClose={() => setPermissionTarget(null)}
            onDone={() => {
              setPermissionTarget(null);
              void resource.reload();
              notify("Staff permissions saved; old sessions were revoked.");
            }}
          />
        </Suspense>
      )}
      {mfaReset && (
        <MfaResetDialog
          target={mfaReset}
          onClose={() => setMfaReset(null)}
          onDone={() => {
            void resource.reload();
            notify(
              "Staff authenticator access recovered. A password change is required.",
            );
          }}
        />
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "create"
              ? "Create staff account"
              : action.type === "edit"
                ? "Edit staff access"
                : "Reset staff password"
          }
          className="management-dialog"
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            {action.type !== "create" && <p>{action.user.username}</p>}
            {action.type === "create" && (
              <label>
                Username
                <input
                  aria-label="Username"
                  autoComplete="off"
                  minLength={3}
                  maxLength={32}
                  pattern="[a-z0-9_-]{3,32}"
                  required
                  value={values.username}
                  onChange={(event) =>
                    setValues({
                      ...values,
                      username: event.target.value.toLowerCase(),
                    })
                  }
                />
                <small>Lowercase letters, digits, underscore or hyphen.</small>
              </label>
            )}
            {action.type !== "password" && (
              <>
                <label>
                  Full name
                  <input
                    required
                    minLength={2}
                    maxLength={80}
                    value={values.name}
                    onChange={(event) =>
                      setValues({ ...values, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Role
                  <select
                    aria-label="Role"
                    value={values.role}
                    onChange={(event) =>
                      setValues({ ...values, role: event.target.value })
                    }
                  >
                    {(resource.data?.roles || []).map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {action.type === "edit" && (
              <label className="commerce-checkbox">
                <input
                  type="checkbox"
                  checked={values.active}
                  onChange={(event) =>
                    setValues({ ...values, active: event.target.checked })
                  }
                />
                Account active
              </label>
            )}
            {action.type !== "edit" && (
              <label>
                Temporary password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  value={values.password}
                  onChange={(event) =>
                    setValues({ ...values, password: event.target.value })
                  }
                />
                <small>
                  Share privately. The staff member must replace it before using
                  the workspace.
                </small>
              </label>
            )}
            {action.type !== "create" && (
              <label>
                Reason
                <textarea
                  minLength={3}
                  maxLength={160}
                  required
                  value={values.reason}
                  onChange={(event) =>
                    setValues({ ...values, reason: event.target.value })
                  }
                />
              </label>
            )}
            <label>
              Your administrator password
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={values.currentPassword}
                onChange={(event) =>
                  setValues({ ...values, currentPassword: event.target.value })
                }
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : action.type === "create"
                  ? "Create account"
                  : "Save staff access"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
