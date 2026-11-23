import { useState } from "react";
import { api, parseMinor } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function StaffPermissions({ target, onClose, onDone }) {
  const catalog = useResource("/staff/access-catalog"),
    [scope, setScope] = useState("default"),
    [role, setRole] = useState(target.role),
    [inherit, setInherit] = useState(false),
    [branches, setBranches] = useState(target.branchIds || ["main"]),
    [denied, setDenied] = useState(target.denied || []),
    [limits, setLimits] = useState(
      Object.fromEntries(
        [
          "refundApproval",
          "purchaseApproval",
          "purchasePayment",
          "expenseApproval",
        ].map((key) => [
          key,
          target.limitsMinor?.[key] == null
            ? ""
            : String(target.limitsMinor[key] / 100),
        ]),
      ),
    ),
    [password, setPassword] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const labels = {
    refundApproval: "Guest refund approval",
    purchaseApproval: "Purchase order approval",
    purchasePayment: "Supplier payment",
    expenseApproval: "Expense approval",
  };
  function changeScope(value) {
    setScope(value);
    const profile = target.branchAccess?.[value],
      access = profile?.access || {
        denied: target.denied,
        limitsMinor: target.limitsMinor,
      };
    setRole(profile?.role || target.role);
    setInherit(value !== "default" && !profile);
    setDenied(access.denied || []);
    setLimits(
      Object.fromEntries(
        Object.keys(labels).map((key) => [
          key,
          access.limitsMinor?.[key] == null
            ? ""
            : String(access.limitsMinor[key] / 100),
        ]),
      ),
    );
    setError("");
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const limitsMinor = {};
      for (const [key, value] of Object.entries(limits))
        limitsMinor[key] = value.trim() === "" ? null : parseMinor(value);
      await api(
        "/staff/team/" +
          target.id +
          (scope === "default" ? "/access" : "/branch-access"),
        {
          method: "PATCH",
          data: {
            ...(scope === "default"
              ? { branchIds: branches, denied, limitsMinor }
              : {
                  branchId: scope,
                  profile: inherit ? null : { role, denied, limitsMinor },
                }),
            expectedAuthVersion: target.authVersion || 0,
            currentPassword: password,
            reason,
          },
        },
      );
      setPassword("");
      onDone();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={"Permissions · " + target.username}
      className="management-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {catalog.loading ? (
        <Loading />
      ) : catalog.error ? (
        <ErrorMessage onRetry={catalog.reload}>
          {catalog.error.message}
        </ErrorMessage>
      ) : (
        <form className="commerce-form" onSubmit={save}>
          <label>
            Permissions scope
            <select
              aria-label="Permissions scope"
              value={scope}
              onChange={(event) => changeScope(event.target.value)}
            >
              <option value="default">Default role & branch assignments</option>
              {catalog.data.branches
                .filter(
                  (branch) =>
                    target.platformAdmin ||
                    (target.branchIds || ["main"]).includes(branch.id),
                )
                .map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} · Branch role
                  </option>
                ))}
            </select>
          </label>
          {scope !== "default" && (
            <>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={inherit}
                  onChange={(event) => setInherit(event.target.checked)}
                />
                Use the default role, permissions and limits in this branch
              </label>
              {!inherit && (
                <label>
                  Branch role
                  <select
                    aria-label="Staff branch role"
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  >
                    {["admin", "kitchen", "waiter", "cashier"].map((value) => (
                      <option value={value} key={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="commerce-note">
                A branch role applies only after the staff member is assigned to
                that branch. Default administrator status controls
                installation-wide management.
              </p>
            </>
          )}
          <p>
            Allow or restrict actions within the assigned {target.role} role.
            Change the base role from Edit access when another staff station is
            needed.
          </p>
          {scope === "default" && (
            <fieldset>
              <legend>Assigned branches</legend>
              {catalog.data.branches.map((branch) => (
                <label className="check-line" key={branch.id}>
                  <input
                    type="checkbox"
                    checked={branches.includes(branch.id)}
                    onChange={(e) =>
                      setBranches(
                        e.target.checked
                          ? [...branches, branch.id]
                          : branches.filter((id) => id !== branch.id),
                      )
                    }
                  />
                  {branch.name}
                </label>
              ))}
            </fieldset>
          )}
          <fieldset disabled={scope !== "default" && inherit}>
            <legend>Allowed actions</legend>
            {catalog.data.permissions
              .filter((permission) => permission.roles.includes(role))
              .filter(
                (permission) =>
                  scope === "default" ||
                  ![
                    "branches.manage",
                    "branches.dashboard",
                    "monitoring.view",
                    "monitoring.manage",
                  ].includes(permission.key),
              )
              .map((permission) => (
                <label className="check-line" key={permission.key}>
                  <input
                    type="checkbox"
                    checked={!denied.includes(permission.key)}
                    onChange={(e) =>
                      setDenied(
                        e.target.checked
                          ? denied.filter((key) => key !== permission.key)
                          : [...denied, permission.key],
                      )
                    }
                  />
                  {permission.label}
                </label>
              ))}
          </fieldset>
          <fieldset disabled={scope !== "default" && inherit}>
            <legend>Per-action amount limits (৳)</legend>
            <p>
              Leave empty for no amount limit; 0 prevents approval of positive
              amounts.
            </p>
            {Object.entries(labels).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  aria-label={label + " limit"}
                  type="number"
                  min="0"
                  step="0.01"
                  max="100000000"
                  value={limits[key]}
                  onChange={(e) =>
                    setLimits({ ...limits, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </fieldset>
          <label>
            Reason
            <input
              required
              minLength={3}
              maxLength={160}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            Administrator password
            <input
              aria-label="Permissions administrator password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p>
            Saving signs this staff member out on every device and branch. They
            must sign in again.
          </p>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <Button type="submit" disabled={busy || !branches.length}>
            {busy
              ? "Saving permissions…"
              : scope === "default"
                ? "Save permissions & limits"
                : "Save branch role & limits"}
          </Button>
        </form>
      )}
    </Modal>
  );
}
