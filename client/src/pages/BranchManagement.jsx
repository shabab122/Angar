import { useState } from "react";
import { useApp } from "../lib/AppContext";
import { api, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { currentBranch, selectBranch } from "../lib/branch";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function BranchManagement() {
  const { notify } = useApp(),
    resource = useResource("/branches/manage"),
    [edit, setEdit] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const empty = {
    id: "",
    name: "",
    address: "",
    tables: 6,
    copyMenu: true,
    currentPassword: "",
    reason: "",
    requestKey: requestKey(),
  };
  const [values, setValues] = useState(empty);
  function open(row) {
    setError("");
    setEdit(
      row?.state === "provisioning"
        ? { ...row, create: true }
        : row || { create: true },
    );
    setValues({
      ...empty,
      ...(row
        ? {
            id: row.id,
            name: row.name,
            address: row.address,
            ...row.provisioning,
          }
        : {}),
      requestKey: row?.provisioning?.requestKey || requestKey(),
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/branches" + (edit.create ? "" : "/" + edit.id), {
        method: edit.create ? "POST" : "PATCH",
        data: edit.create
          ? {
              id: values.id,
              name: values.name,
              address: values.address,
              tables: Number(values.tables),
              copyMenu: values.copyMenu,
              currentPassword: values.currentPassword,
              requestKey: values.requestKey,
            }
          : {
              name: values.name,
              address: values.address,
              currentPassword: values.currentPassword,
              reason: values.reason,
            },
      });
      setEdit(null);
      setValues(empty);
      await resource.reload();
      window.dispatchEvent(new Event("angar:refresh"));
      notify(
        "Branch saved. Select it to manage its own menu, staff, stock and accounts.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Restaurant branches</h2>
          <p>
            Each branch has its own menu, customers, stock, purchases, cash
            drawer and reports. Staff sign-in and access assignments are shared.
          </p>
        </div>
        <Button onClick={() => open(null)}>Add branch</Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      <div className="commerce-staff-grid">
        {resource.data?.branches.map((row) => (
          <article className="commerce-card" key={row.id}>
            <h3>{row.name}</h3>
            <p>{row.address || "Address not set"}</p>
            <p className="commerce-note">
              {row.id} · {row.state}
              {row.id === currentBranch() ? " · Current branch" : ""}
            </p>
            {row.state === "ready" ? (
              <div className="commerce-inline-actions">
                <Button secondary onClick={() => open(row)}>
                  Edit branch
                </Button>
                <Button
                  secondary
                  disabled={row.id === currentBranch() || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await selectBranch(row.id);
                    } catch (failure) {
                      setError(failure.message);
                      setBusy(false);
                    }
                  }}
                >
                  Open branch
                </Button>
              </div>
            ) : (
              <div>
                {row.state === "provisioning" && (
                  <Button secondary onClick={() => open(row)}>
                    Resume branch setup
                  </Button>
                )}
                <p>
                  Provisioning or recovery needs operator attention. Retry the
                  original creation request if interrupted; restored branches
                  must be bound to their restored database.
                </p>
              </div>
            )}
          </article>
        ))}
      </div>
      {error && !edit && <ErrorMessage>{error}</ErrorMessage>}
      {edit && (
        <Modal
          open
          title={edit.create ? "Add restaurant branch" : "Edit branch details"}
          onClose={() => {
            if (!busy) setEdit(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            {edit.create && (
              <label>
                Branch code
                <input
                  aria-label="Branch code"
                  required
                  minLength={2}
                  maxLength={24}
                  pattern="[a-z][a-z0-9-]{1,23}"
                  value={values.id}
                  onChange={(e) => setValues({ ...values, id: e.target.value })}
                />
                <small>Permanent lowercase code, for example uttara.</small>
              </label>
            )}
            <label>
              Branch name
              <input
                aria-label="Branch name"
                required
                minLength={2}
                maxLength={80}
                value={values.name}
                onChange={(e) => setValues({ ...values, name: e.target.value })}
              />
            </label>
            <label>
              Branch address
              <textarea
                aria-label="Branch address"
                maxLength={240}
                value={values.address}
                onChange={(e) =>
                  setValues({ ...values, address: e.target.value })
                }
              />
            </label>
            {edit.create && (
              <>
                <label>
                  Tables
                  <input
                    aria-label="Tables in new branch"
                    type="number"
                    min={1}
                    max={50}
                    required
                    value={values.tables}
                    onChange={(e) =>
                      setValues({ ...values, tables: e.target.value })
                    }
                  />
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={values.copyMenu}
                    onChange={(e) =>
                      setValues({ ...values, copyMenu: e.target.checked })
                    }
                  />
                  Start with a copy of the main branch menu
                </label>
                <p className="commerce-note">
                  Ordering starts paused and tables closed. Add stock, staff
                  assignments, invoice settings and ordering settings in the new
                  branch before enabling service.
                </p>
              </>
            )}
            {!edit.create && (
              <label>
                Reason
                <input
                  required
                  minLength={3}
                  maxLength={160}
                  value={values.reason}
                  onChange={(e) =>
                    setValues({ ...values, reason: e.target.value })
                  }
                />
              </label>
            )}
            <label>
              Administrator password
              <input
                aria-label="Branch administrator password"
                autoComplete="current-password"
                type="password"
                required
                value={values.currentPassword}
                onChange={(e) =>
                  setValues({ ...values, currentPassword: e.target.value })
                }
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving branch…" : "Save branch"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
