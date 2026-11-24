import { useState } from "react";
import { api, parseMinor, money } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, Loading, ErrorMessage, Modal } from "../components/UI";
import { useApp } from "../lib/AppContext";
export default function PurchaseSuggestions({ user }) {
  const canCreate = user.capabilities?.["purchase.create"] !== false;
  const resource = useResource("/staff/purchase-suggestions", {
      interval: 30000,
    }),
    [edit, setEdit] = useState(null),
    [values, setValues] = useState({}),
    [selected, setSelected] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    { notify } = useApp();
  function open(row) {
    setEdit(row);
    setError("");
    setValues({
      supplierId: row.supplierId,
      targetStock: row.targetStock,
      packQuantity: row.packQuantity,
      minimumQuantity: row.minimumQuantity,
      price:
        row.unitPriceMinor === null ? "" : String(row.unitPriceMinor / 100),
      pricePerQuantity: row.pricePerQuantity,
      enabled: row.enabled,
      reason: "",
    });
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/purchase-suggestions/rules/" + edit.ingredientId, {
        method: "PUT",
        data: {
          supplierId: values.supplierId,
          targetStock: Number(values.targetStock),
          packQuantity: Number(values.packQuantity),
          minimumQuantity: Number(values.minimumQuantity),
          unitPriceMinor: parseMinor(values.price),
          pricePerQuantity: Number(values.pricePerQuantity),
          enabled: values.enabled,
          expectedRevision: edit.ruleRevision,
          reason: values.reason,
        },
      });
      setEdit(null);
      await resource.reload();
      notify("Replenishment rule saved.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  return (
    <section className="v29-panel">
      <div className="panel-heading">
        <div>
          <h2>Purchase suggestions</h2>
          <p>
            Replenish usable stock with supplier drafts, packaging quantities
            and reviewed prices.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          Refresh suggestions
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {error && !edit && <ErrorMessage>{error}</ErrorMessage>}
      {resource.data && (
        <>
          <article className="commerce-card">
            <label className="check-line">
              <input
                aria-label="Automatic purchase drafts"
                type="checkbox"
                checked={resource.data.autoEnabled}
                disabled={busy || !canCreate}
                onChange={async (event) => {
                  setBusy(true);
                  setError("");
                  try {
                    await api("/staff/purchase-suggestions/automation", {
                      method: "PATCH",
                      data: {
                        enabled: event.target.checked,
                        reason:
                          "Manager reviewed replenishment draft automation",
                      },
                    });
                    await resource.reload();
                  } catch (failure) {
                    setError(failure.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              Automatically prepare supplier drafts every five minutes
            </label>
            <p className="commerce-note">
              Automatic drafts never place supplier orders. Review each draft in
              Suppliers & purchases and approve it with the existing amount
              limits.
            </p>
          </article>
          <div className="v29-table-wrap">
            <table className="v29-table">
              <thead>
                <tr>
                  {[
                    "Select",
                    "Ingredient",
                    "Usable / reorder",
                    "Ordered / planned",
                    "Target / suggested",
                    "Supplier & price",
                    "Rule",
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {resource.data.rows.map((row) => (
                  <tr key={row.ingredientId}>
                    <td>
                      <input
                        aria-label={"Select suggestion " + row.name}
                        type="checkbox"
                        disabled={!row.suggestedQuantity}
                        checked={selected.includes(row.ingredientId)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, row.ingredientId]
                              : selected.filter(
                                  (id) => id !== row.ingredientId,
                                ),
                          )
                        }
                      />
                    </td>
                    <th scope="row">
                      {row.name}
                      <small>
                        {row.unit}
                        {row.low ? " · Low stock" : ""}
                      </small>
                    </th>
                    <td>
                      {row.usableStock} / {row.reorderLevel}
                    </td>
                    <td>
                      {row.onOrder} / {row.planned}
                    </td>
                    <td>
                      {row.targetStock} /{" "}
                      <strong>{row.suggestedQuantity}</strong>
                    </td>
                    <td>
                      {row.supplierName || "Supplier not configured"}
                      <small>
                        {row.unitPriceMinor === null
                          ? "Price required"
                          : money(row.unitPriceMinor / 100) +
                            " per " +
                            row.pricePerQuantity +
                            " " +
                            row.unit}
                      </small>
                    </td>
                    <td>
                      <Button secondary onClick={() => open(row)}>
                        Configure rule
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            disabled={busy || !canCreate || !selected.length}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await api("/staff/purchase-suggestions/drafts", {
                  method: "POST",
                  data: { ingredientIds: selected },
                });
                notify(result.message);
                setSelected([]);
                await resource.reload();
              } catch (failure) {
                setError(failure.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create selected purchase drafts
          </Button>
          <p className="commerce-note">{resource.data.policy}</p>
        </>
      )}
      {edit && (
        <Modal
          open
          title={"Replenishment · " + edit.name}
          onClose={() => {
            if (!busy) setEdit(null);
          }}
        >
          <form className="commerce-form" onSubmit={save}>
            <label>
              Supplier
              <select
                aria-label="Suggestion supplier"
                required
                value={values.supplierId}
                onChange={(event) =>
                  setValues({ ...values, supplierId: event.target.value })
                }
              >
                <option value="">Choose active supplier</option>
                {resource.data.suppliers.map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            {[
              ["targetStock", "Target stock"],
              ["packQuantity", "Pack quantity"],
              ["minimumQuantity", "Minimum order quantity"],
              ["pricePerQuantity", "Price per quantity"],
            ].map(([key, label]) => (
              <label key={key}>
                {label} ({edit.unit})
                <input
                  aria-label={label}
                  type="number"
                  min={1}
                  max={1000000000}
                  step={1}
                  required
                  value={values[key]}
                  onChange={(event) =>
                    setValues({ ...values, [key]: event.target.value })
                  }
                />
              </label>
            ))}
            <label>
              Supplier quote (৳)
              <input
                aria-label="Suggestion supplier price"
                required
                type="number"
                min="0"
                step="0.01"
                max="1000000"
                value={values.price}
                onChange={(event) =>
                  setValues({ ...values, price: event.target.value })
                }
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={values.enabled}
                onChange={(event) =>
                  setValues({ ...values, enabled: event.target.checked })
                }
              />
              Enable this replenishment rule
            </label>
            <label>
              Reason
              <input
                required
                minLength={3}
                maxLength={160}
                value={values.reason}
                onChange={(event) =>
                  setValues({ ...values, reason: event.target.value })
                }
              />
            </label>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              Save replenishment rule
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
