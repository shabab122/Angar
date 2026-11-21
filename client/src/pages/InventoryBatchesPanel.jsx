import { useState } from "react";
import { PackageCheck, Plus, RefreshCw } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";

export const emptyBatch = () => ({ code: "", expiresOn: "", noExpiry: false });
export const batchPayload = (value) => ({
  code: value.code.trim(),
  expiresOn: value.noExpiry ? null : value.expiresOn,
  noExpiry: Boolean(value.noExpiry),
});
export function BatchDetailsFields({
  value,
  onChange,
  prefix = "",
  includeCode = true,
}) {
  const change = (field) => (event) =>
    onChange({ ...value, [field]: event.target.value });
  return (
    <fieldset className="v25-batch-fields">
      <legend>{prefix}Batch details</legend>
      {includeCode && (
        <label>
          Batch / lot code
          <input
            aria-label={prefix + "Batch code"}
            minLength={2}
            maxLength={60}
            required
            value={value.code || ""}
            onChange={change("code")}
          />
        </label>
      )}
      <label>
        Expiry date (last usable day, Bangladesh)
        <input
          aria-label={prefix + "Expiry date"}
          type="date"
          required={!value.noExpiry}
          disabled={value.noExpiry}
          value={value.expiresOn || ""}
          onChange={change("expiresOn")}
        />
      </label>
      <label className="commerce-checkbox">
        <input
          type="checkbox"
          checked={Boolean(value.noExpiry)}
          onChange={(event) =>
            onChange({
              ...value,
              noExpiry: event.target.checked,
              ...(event.target.checked ? { expiresOn: "" } : {}),
            })
          }
        />
        <span>{prefix}Non-perishable; no expiry date applies</span>
      </label>
    </fieldset>
  );
}

export function InventoryBatchesPanel({ user }) {
  const { notify } = useApp(),
    admin = user.role === "admin";
  const [ingredientId, setIngredientId] = useState(""),
    [filter, setFilter] = useState("all"),
    [action, setAction] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const resource = useResource(
    "/staff/inventory/batches?" +
      new URLSearchParams({
        ...(ingredientId ? { ingredient: ingredientId } : {}),
        filter,
      }),
    { interval: 5000 },
  );
  const lots = useResource(
    "/staff/inventory/batches?ingredient=" + (action?.ingredient?.id || ""),
    { enabled: action?.type === "stock", interval: 5000 },
  );
  function open(type, row) {
    setAction({
      type,
      ...(type === "review" ? { batch: row } : { ingredient: row }),
      key: requestKey(),
    });
    setError("");
    setValues({
      reason: "",
      kind: admin ? "receive" : "waste",
      quantity: "",
      reference: "",
      batchId: "",
      batch: emptyBatch(),
      openings: [{ ...emptyBatch(), quantity: String(row.stock || 0) }],
      expiresOn: row.expiresOn || "",
      noExpiry: !row.expiresOn,
      blocked: Boolean(row.blocked),
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let path, data;
      if (action.type === "enable") {
        path = "/staff/inventory/batches/enable";
        data = {
          ingredientId: action.ingredient.id,
          expectedRevision: action.ingredient.revision,
          reason: values.reason,
          batches: values.openings.map((row) => ({
            ...batchPayload(row),
            quantity: Number(row.quantity),
          })),
        };
      } else if (action.type === "review") {
        path = "/staff/inventory/batches/" + action.batch.id + "/status";
        data = {
          expectedRevision: action.batch.revision,
          reason: values.reason,
          blocked: values.blocked,
          expiresOn: values.noExpiry ? null : values.expiresOn,
          noExpiry: values.noExpiry,
        };
      } else {
        path =
          "/staff/inventory/ingredients/" + action.ingredient.id + "/stock";
        data = {
          kind: values.kind,
          quantity: Number(values.quantity),
          reason: values.reason,
          reference: values.reference,
          requestKey: action.key,
          ...(values.kind === "receive" ||
          (values.kind === "correction" && Number(values.quantity) > 0)
            ? { batch: batchPayload(values.batch) }
            : { batchId: values.batchId }),
        };
      }
      await api(path, { method: "POST", data });
      setAction(null);
      await resource.reload();
      notify("Batch inventory updated.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const ingredients = resource.data?.ingredients || [],
    tracked = ingredients.filter((row) => row.batchTracked);
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Ingredient batches & expiry</h2>
          <p>
            Recorded stock includes expired and quarantined batches. Recipe
            allocation uses released, unexpired batches in earliest-expiry
            order.
          </p>
        </div>
        <Button secondary onClick={resource.reload}>
          <RefreshCw size={15} />
          Refresh batches
        </Button>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          <div className="v25-metrics">
            {[
              ["Expired batches", resource.data?.alerts.expired],
              ["Expiring in 7 days", resource.data?.alerts.soon],
              ["Quarantined batches", resource.data?.alerts.quarantined],
            ].map(([label, count]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{count || 0}</strong>
              </div>
            ))}
          </div>
          <div className="commerce-card commerce-form">
            <div className="commerce-two">
              <label>
                Ingredient
                <select
                  aria-label="Batch ingredient filter"
                  value={ingredientId}
                  onChange={(event) => setIngredientId(event.target.value)}
                >
                  <option value="">All ingredients</option>
                  {ingredients.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Batch condition
                <select
                  aria-label="Batch condition filter"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value="all">All recorded batches</option>
                  <option value="soon">Expiry within 7 days</option>
                  <option value="expired">Expired stock</option>
                  <option value="quarantined">Quarantined stock</option>
                </select>
              </label>
            </div>
          </div>
          <div className="commerce-staff-grid">
            {tracked
              .filter((row) => !ingredientId || row.id === ingredientId)
              .map((row) => (
                <article className="commerce-card" key={row.id}>
                  <h3>
                    <PackageCheck size={17} />
                    {row.name}
                  </h3>
                  <p>
                    Recorded unallocated stock:{" "}
                    <strong>
                      {row.stock} {row.unit}
                    </strong>
                    <br />
                    Usable for new orders:{" "}
                    <strong>
                      {row.usableStock} {row.unit}
                    </strong>
                  </p>
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => open("stock", row)}
                  >
                    {admin
                      ? "Receive / adjust batch stock"
                      : "Record batch waste"}
                  </Button>
                </article>
              ))}
          </div>
          {admin && (
            <details className="commerce-card v25-details">
              <summary>Enable batch tracking for an ingredient</summary>
              <p className="commerce-note">
                Count the current stock and divide it into its actual opening
                batches. Quantities must add up exactly. Existing reserved
                orders retain their original inventory snapshots.
              </p>
              <div className="commerce-inline-actions">
                {ingredients
                  .filter((row) => !row.batchTracked)
                  .map((row) => (
                    <Button
                      secondary
                      className="button-small"
                      key={row.id}
                      onClick={() => open("enable", row)}
                    >
                      Track batches: {row.name}
                    </Button>
                  ))}
              </div>
              {ingredients.every((row) => row.batchTracked) && (
                <p className="commerce-note">
                  All current ingredients use batch tracking.
                </p>
              )}
            </details>
          )}
          <div className="commerce-staff-grid">
            {resource.data?.batches.map((row) => (
              <article className="commerce-card" key={row.id}>
                <div className="commerce-section-heading">
                  <h3>
                    {row.ingredientName} · {row.code}
                  </h3>
                  <span className="management-status">
                    {row.blocked
                      ? "Quarantined"
                      : row.expired
                        ? "Expired"
                        : row.expiringSoon
                          ? "Expiring soon"
                          : "Released"}
                  </span>
                </div>
                <p>
                  Remaining:{" "}
                  <strong>
                    {row.remaining} {row.unit}
                  </strong>
                </p>
                <p className="commerce-note">
                  {row.expiresOn
                    ? "Expiry date: " + row.expiresOn
                    : "Non-perishable · no expiry date"}
                  <br />
                  First received: {dhakaTime(row.createdAt)}
                  {row.needsReview && (
                    <>
                      <br />
                      Returned legacy reservation needs provenance review.
                    </>
                  )}
                </p>
                {row.purchaseId && (
                  <p className="commerce-note v25-break">
                    Purchase reference: {row.purchaseId}
                  </p>
                )}
                {admin && (
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => open("review", row)}
                  >
                    Review batch condition
                  </Button>
                )}
              </article>
            ))}
          </div>
          {!resource.data?.batches.length && (
            <p className="commerce-note">No batches match this view.</p>
          )}
          {resource.data?.more && (
            <p className="commerce-note">
              Showing up to 1,000 batches. Filter by ingredient and condition
              for a narrower view.
            </p>
          )}
        </>
      )}
      {action && (
        <Modal
          open
          className="management-dialog"
          title={
            action.type === "enable"
              ? "Set opening batch balances"
              : action.type === "review"
                ? "Review batch condition"
                : "Record batch stock movement"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            <p>
              {action.ingredient?.name || action.batch.ingredientName}
              {action.batch ? " · " + action.batch.code : ""}
            </p>
            {action.type === "enable" && (
              <>
                <p className="commerce-note">
                  Current stock to allocate:{" "}
                  <strong>
                    {action.ingredient.stock} {action.ingredient.unit}
                  </strong>
                  . This enables tracking for future stock changes and order
                  reservations.
                </p>
                {values.openings.map((row, index) => (
                  <div className="v25-opening-batch" key={index}>
                    <BatchDetailsFields
                      value={row}
                      prefix={"Opening batch " + (index + 1) + " "}
                      onChange={(next) =>
                        setValues({
                          ...values,
                          openings: values.openings.map((item, position) =>
                            position === index ? { ...row, ...next } : item,
                          ),
                        })
                      }
                    />
                    <label>
                      Quantity ({action.ingredient.unit})
                      <input
                        aria-label={"Opening batch quantity " + (index + 1)}
                        required
                        type="number"
                        min="0"
                        max="1000000000"
                        step="1"
                        value={row.quantity}
                        onChange={(event) =>
                          setValues({
                            ...values,
                            openings: values.openings.map((item, position) =>
                              position === index
                                ? { ...item, quantity: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    {values.openings.length > 1 && (
                      <Button
                        secondary
                        onClick={() =>
                          setValues({
                            ...values,
                            openings: values.openings.filter(
                              (_, position) => position !== index,
                            ),
                          })
                        }
                      >
                        Remove opening batch {index + 1}
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  secondary
                  disabled={values.openings.length >= 30}
                  onClick={() =>
                    setValues({
                      ...values,
                      openings: [
                        ...values.openings,
                        { ...emptyBatch(), quantity: "0" },
                      ],
                    })
                  }
                >
                  <Plus size={15} />
                  Add opening batch
                </Button>
                <p className="commerce-note">
                  Allocated:{" "}
                  {values.openings.reduce(
                    (sum, row) => sum + Number(row.quantity || 0),
                    0,
                  )}{" "}
                  / {action.ingredient.stock} {action.ingredient.unit}
                </p>
              </>
            )}
            {action.type === "review" && (
              <>
                <BatchDetailsFields
                  value={values}
                  includeCode={false}
                  onChange={(next) => setValues({ ...values, ...next })}
                />
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    checked={values.blocked}
                    onChange={(event) =>
                      setValues({ ...values, blocked: event.target.checked })
                    }
                  />
                  <span>
                    Quarantine this batch; exclude it from new allocations and
                    preparation
                  </span>
                </label>
                <p className="commerce-note">
                  Record the actual lot condition and expiry. Every review keeps
                  a reason in staff activity.
                </p>
              </>
            )}
            {action.type === "stock" && (
              <>
                <label>
                  Movement type
                  <select
                    aria-label="Batch stock movement type"
                    value={values.kind}
                    onChange={(event) =>
                      setValues({ ...values, kind: event.target.value })
                    }
                  >
                    {admin && <option value="receive">Stock received</option>}
                    <option value="waste">Waste / spoilage</option>
                    {admin && (
                      <option value="correction">
                        Signed stock correction
                      </option>
                    )}
                  </select>
                </label>
                <label>
                  Quantity ({action.ingredient.unit})
                  <input
                    aria-label="Batch stock quantity"
                    type="number"
                    required
                    step="1"
                    min={values.kind === "correction" ? "-1000000000" : "1"}
                    max="1000000000"
                    value={values.quantity}
                    onChange={(event) =>
                      setValues({ ...values, quantity: event.target.value })
                    }
                  />
                </label>
                {values.kind === "receive" ||
                (values.kind === "correction" &&
                  Number(values.quantity) >= 0) ? (
                  <BatchDetailsFields
                    value={values.batch}
                    onChange={(batch) => setValues({ ...values, batch })}
                  />
                ) : (
                  <label>
                    Batch being removed
                    <select
                      aria-label="Batch being removed"
                      required
                      value={values.batchId}
                      onChange={(event) =>
                        setValues({ ...values, batchId: event.target.value })
                      }
                    >
                      <option value="">Choose a batch</option>
                      {lots.data?.batches
                        .filter((row) => row.remaining > 0)
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.code} · {row.remaining} {row.unit} ·{" "}
                            {row.expired
                              ? "expired"
                              : row.blocked
                                ? "quarantined"
                                : "released"}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  Reference (optional)
                  <input
                    maxLength={80}
                    value={values.reference}
                    onChange={(event) =>
                      setValues({ ...values, reference: event.target.value })
                    }
                  />
                </label>
                {lots.error && (
                  <ErrorMessage onRetry={lots.reload}>
                    {lots.error.message}
                  </ErrorMessage>
                )}
              </>
            )}
            <label>
              Reason
              <textarea
                aria-label="Batch action reason"
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
            <Button
              type="submit"
              disabled={
                busy ||
                (action.type === "enable" &&
                  values.openings.reduce(
                    (sum, row) => sum + Number(row.quantity || 0),
                    0,
                  ) !== action.ingredient.stock)
              }
            >
              {action.type === "enable"
                ? "Enable batch tracking"
                : action.type === "review"
                  ? "Save batch review"
                  : "Record batch movement"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
