import { useState } from "react";
import { api, parseMinor } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function StaffPermissions({ target, onClose, onDone }) {
  const catalog = useResource("/staff/access-catalog"),
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
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const limitsMinor = {};
      for (const [key, value] of Object.entries(limits))
        limitsMinor[key] = value.trim() === "" ? null : parseMinor(value);
      await api("/staff/team/" + target.id + "/access", {
        method: "PATCH",
        data: {
          branchIds: branches,
          denied,
          limitsMinor,
          expectedAuthVersion: target.authVersion || 0,
          currentPassword: password,
          reason,
        },
      });
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
          <p>
            Allow or restrict actions within the assigned {target.role} role.
            Change the base role from Edit access when another staff station is
            needed.
          </p>
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
          <fieldset>
            <legend>Allowed actions</legend>
            {catalog.data.permissions
              .filter((permission) => permission.roles.includes(target.role))
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
          <fieldset>
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
            {busy ? "Saving permissions…" : "Save permissions & limits"}
          </Button>
        </form>
      )}
    </Modal>
  );
}
