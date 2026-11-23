import { useState } from "react";
import { useResource } from "../lib/useResource";
import { currentBranch, selectBranch } from "../lib/branch";
export function BranchSelector({ staff = false }) {
  const resource = useResource("/branches"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!resource.data || resource.data.branches.length < 2) return null;
  return (
    <div className={"branch-picker" + (staff ? " staff-branch-picker" : "")}>
      <label>
        Restaurant branch
        <select
          aria-label="Restaurant branch"
          value={currentBranch()}
          disabled={busy || !navigator.onLine}
          onChange={async (event) => {
            setBusy(true);
            setError("");
            try {
              await selectBranch(event.target.value);
            } catch (failure) {
              setError(failure.message);
              setBusy(false);
            }
          }}
        >
          {resource.data.branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </label>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
