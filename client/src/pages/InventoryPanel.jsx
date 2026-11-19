import { useState } from "react";
import { AlertTriangle, PackagePlus, Plus, Trash2 } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Loading,
  Modal,
} from "../components/UI";

export function InventoryPanel({ user }) {
  const { notify } = useApp();
  const resource = useResource("/staff/inventory", { interval: 5000 });
  const [tab, setTab] = useState("stock"),
    [action, setAction] = useState(null),
    [values, setValues] = useState({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const admin = user.role === "admin";
  function open(type, row) {
    setAction({ type, row, key: crypto.randomUUID().replaceAll("-", "") });
    setError("");
    setValues(
      type === "recipe"
        ? {
            enabled: row.recipe?.enabled || false,
            base: row.recipe?.base || [],
            variants: row.recipe?.variants || [],
            addons: row.recipe?.addons || [],
            reason: "",
          }
        : {
            name: row?.name || "",
            unit: row?.unit || "g",
            initialStock: "0",
            reorderLevel: String(row?.reorderLevel || 0),
            kind: admin ? "receive" : "waste",
            quantity: "",
            reason: "",
            reference: "",
          },
    );
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { type, row } = action;
      const endpoint =
        type === "ingredient"
          ? "/staff/inventory/ingredients"
          : type === "recipe"
            ? "/staff/inventory/recipes/" + row.id
            : "/staff/inventory/ingredients/" +
              row.id +
              (type === "stock" ? "/stock" : "");
      const data =
        type === "ingredient"
          ? {
              name: values.name,
              unit: values.unit,
              initialStock: Number(values.initialStock),
              reorderLevel: Number(values.reorderLevel),
            }
          : type === "metadata"
            ? {
                name: values.name,
                reorderLevel: Number(values.reorderLevel),
                expectedRevision: row.revision,
                reason: values.reason,
              }
            : type === "recipe"
              ? { ...values, expectedRevision: row.recipe?.revision || 0 }
              : {
                  kind: values.kind,
                  quantity: Number(values.quantity),
                  reason: values.reason,
                  reference: values.reference,
                  requestKey: action.key,
                };
      await api(endpoint, {
        method: type === "metadata" ? "PATCH" : "POST",
        data,
      });
      setAction(null);
      await resource.reload();
      notify("Inventory updated.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const ingredients = resource.data?.ingredients || [],
    dishes = resource.data?.dishes || [];
  if (!resource.data && !resource.error) return <Loading />;
  function recipeGroup(kind, option) {
    const title =
      kind === "base"
        ? "Base recipe · every portion"
        : (kind === "variants" ? "Size extra · " : "Add-on extra · ") +
          option.name;
    const rows =
      kind === "base"
        ? values.base
        : values[kind].find((group) => group.optionId === option.id)
            ?.ingredients || [];
    const change = (next) =>
      setValues((previous) => ({
        ...previous,
        [kind]:
          kind === "base"
            ? next
            : [
                ...previous[kind].filter(
                  (group) => group.optionId !== option.id,
                ),
                { optionId: option.id, ingredients: next },
              ],
      }));
    return (
      <RecipeGroup
        key={kind + (option?.id || "")}
        title={title}
        rows={rows}
        ingredients={ingredients}
        onChange={change}
      />
    );
  }
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Ingredient inventory</h2>
          <p>
            Whole base units: grams, millilitres or pieces. Recipes apply to new
            kitchen acceptances.
          </p>
        </div>
        {admin && (
          <Button className="button-small" onClick={() => open("ingredient")}>
            <PackagePlus size={16} />
            Add ingredient
          </Button>
        )}
      </div>
      <div className="commerce-tabs management-tabs">
        {[
          ["stock", "Stock & alerts"],
          ["recipes", "Dish recipes"],
          ["ledger", "Stock movements"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {tab === "stock" && (
        <>
          <p className="commerce-note">
            {ingredients.filter((row) => row.low).length} low-stock ingredients.
            Available stock already excludes quantities committed to queued
            orders. Refunds do not automatically return cooked food to stock.
          </p>
          <div className="commerce-staff-grid">
            {ingredients.map((row) => (
              <article className="commerce-card" key={row.id}>
                <div className="commerce-section-heading">
                  <h3>{row.name}</h3>
                  {row.low && (
                    <span className="management-warning">
                      <AlertTriangle size={14} />
                      Low stock
                    </span>
                  )}
                </div>
                <strong className="stock-amount">
                  {row.stock.toLocaleString()} <small>{row.unit}</small>
                </strong>
                <p className="commerce-note">
                  Alert at {row.reorderLevel.toLocaleString()} {row.unit}
                </p>
                <div className="commerce-inline-actions">
                  <Button
                    className="button-small"
                    secondary
                    onClick={() => open("stock", row)}
                  >
                    {admin ? "Receive / adjust / waste" : "Record waste"}
                  </Button>
                  {admin && (
                    <Button
                      secondary
                      className="button-small"
                      onClick={() => open("metadata", row)}
                    >
                      Edit details
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!ingredients.length && (
            <EmptyState
              title="No ingredients yet"
              text="An administrator can add ingredients and then connect dish recipes. Existing menu ordering continues as before."
            />
          )}
        </>
      )}
      {tab === "recipes" && (
        <>
          <p className="commerce-note">
            The base recipe is used for each portion. Size and add-on recipes
            add extra quantities. Queued orders keep the recipe recorded when
            they were sent; editing a recipe affects future acceptances.
          </p>
          <div className="commerce-staff-grid">
            {dishes.map((dish) => (
              <article className="commerce-card" key={dish.id}>
                <div className="commerce-section-heading">
                  <h3>{dish.name}</h3>
                  <span className="management-status">
                    {dish.recipe?.enabled ? "Tracking enabled" : "Not tracked"}
                  </span>
                </div>
                <p className="commerce-note">
                  {dish.recipe?.base?.length || 0} base ingredients ·{" "}
                  {dish.recipe?.variants?.length || 0} size recipes ·{" "}
                  {dish.recipe?.addons?.length || 0} add-on recipes
                </p>
                {admin && (
                  <Button
                    secondary
                    className="button-small"
                    disabled={!ingredients.length}
                    onClick={() => open("recipe", dish)}
                  >
                    Edit recipe
                  </Button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {tab === "ledger" && (
        <div className="commerce-card commerce-table-scroll">
          <table>
            <thead>
              <tr>
                <th>When / ingredient</th>
                <th>Change</th>
                <th>Balance</th>
                <th>Reason / source</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.movements.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.ingredientName}
                    <small className="management-muted">
                      {dhakaTime(row.at)}
                    </small>
                  </td>
                  <td>
                    {row.delta > 0 ? "+" : ""}
                    {row.delta} {row.unit}
                  </td>
                  <td>
                    {row.balance} {row.unit}
                  </td>
                  <td>
                    {row.kind.replaceAll("_", " ")} · {row.by}
                    <small className="management-muted">
                      {row.orderCode || row.reason || "Opening balance"}
                      {row.reference && " · " + row.reference}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!resource.data?.movements.length && (
            <p className="commerce-note">No stock movements yet.</p>
          )}
        </div>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "recipe"
              ? "Recipe · " + action.row.name
              : action.type === "ingredient"
                ? "Add ingredient"
                : action.type === "metadata"
                  ? "Ingredient details"
                  : "Stock movement · " + action.row.name
          }
          className="management-dialog"
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            {["ingredient", "metadata"].includes(action.type) && (
              <>
                <label>
                  Ingredient name
                  <input
                    minLength={2}
                    maxLength={80}
                    required
                    value={values.name}
                    onChange={(event) =>
                      setValues({ ...values, name: event.target.value })
                    }
                  />
                </label>
                {action.type === "ingredient" ? (
                  <>
                    <label>
                      Base unit
                      <select
                        aria-label="Base unit"
                        value={values.unit}
                        onChange={(event) =>
                          setValues({ ...values, unit: event.target.value })
                        }
                      >
                        <option value="g">Grams (g)</option>
                        <option value="ml">Millilitres (ml)</option>
                        <option value="pcs">Pieces (pcs)</option>
                      </select>
                    </label>
                    <label>
                      Opening stock
                      <input
                        type="number"
                        min="0"
                        max="1000000000"
                        step="1"
                        required
                        value={values.initialStock}
                        onChange={(event) =>
                          setValues({
                            ...values,
                            initialStock: event.target.value,
                          })
                        }
                      />
                    </label>
                    <small>
                      The base unit stays fixed. Convert kg to g and litres to
                      ml before entering quantities.
                    </small>
                  </>
                ) : (
                  <p>
                    Base unit: {action.row.unit}. Use stock movements to change
                    quantities.
                  </p>
                )}
                <label>
                  Low-stock alert level
                  <input
                    type="number"
                    min="0"
                    max="1000000000"
                    step="1"
                    required
                    value={values.reorderLevel}
                    onChange={(event) =>
                      setValues({ ...values, reorderLevel: event.target.value })
                    }
                  />
                </label>
              </>
            )}
            {action.type === "stock" && (
              <>
                <p>
                  Available: {action.row.stock} {action.row.unit}
                </p>
                <label>
                  Movement type
                  <select
                    aria-label="Movement type"
                    value={values.kind}
                    onChange={(event) =>
                      setValues({ ...values, kind: event.target.value })
                    }
                  >
                    {admin && <option value="receive">Stock received</option>}
                    <option value="waste">Waste / spoilage</option>
                    {admin && (
                      <option value="correction">
                        Signed correction (+ / −)
                      </option>
                    )}
                  </select>
                </label>
                <label>
                  Quantity ({action.row.unit})
                  <input
                    type="number"
                    step="1"
                    min={values.kind === "correction" ? "-1000000000" : "1"}
                    max="1000000000"
                    required
                    value={values.quantity}
                    onChange={(event) =>
                      setValues({ ...values, quantity: event.target.value })
                    }
                  />
                </label>
                <label>
                  Supplier / movement reference (optional)
                  <input
                    maxLength={80}
                    value={values.reference}
                    onChange={(event) =>
                      setValues({ ...values, reference: event.target.value })
                    }
                  />
                </label>
              </>
            )}
            {action.type === "recipe" && (
              <>
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    checked={values.enabled}
                    onChange={(event) =>
                      setValues({ ...values, enabled: event.target.checked })
                    }
                  />
                  Enable stock tracking for this dish
                </label>
                {recipeGroup("base")}
                {action.row.variants.map((option) =>
                  recipeGroup("variants", option),
                )}
                {action.row.addons.map((option) =>
                  recipeGroup("addons", option),
                )}
              </>
            )}
            {action.type !== "ingredient" && (
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
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : action.type === "recipe"
                  ? "Save recipe"
                  : action.type === "stock"
                    ? "Record stock movement"
                    : "Save ingredient"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
function RecipeGroup({ title, rows, ingredients, onChange }) {
  return (
    <section className="recipe-group">
      <h3>{title}</h3>
      {rows.map((row, index) => (
        <div className="recipe-ingredient-row" key={index}>
          <label>
            Ingredient
            <select
              aria-label={title + " ingredient " + (index + 1)}
              required
              value={row.ingredientId}
              onChange={(event) =>
                onChange(
                  rows.map((line, i) =>
                    i === index
                      ? { ...line, ingredientId: event.target.value }
                      : line,
                  ),
                )
              }
            >
              {ingredients.map((ingredient) => (
                <option key={ingredient.id} value={ingredient.id}>
                  {ingredient.name} ({ingredient.unit})
                </option>
              ))}
            </select>
          </label>
          <label>
            Per portion
            <input
              aria-label={title + " quantity " + (index + 1)}
              type="number"
              min="1"
              max="1000000000"
              step="1"
              required
              value={row.quantity}
              onChange={(event) =>
                onChange(
                  rows.map((line, i) =>
                    i === index
                      ? { ...line, quantity: Number(event.target.value) }
                      : line,
                  ),
                )
              }
            />
          </label>
          <button
            className="icon-button"
            type="button"
            aria-label={"Remove " + title + " ingredient " + (index + 1)}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <Button
        secondary
        className="button-small"
        disabled={!ingredients.length || rows.length >= 30}
        onClick={() =>
          onChange([
            ...rows,
            {
              ingredientId:
                ingredients.find(
                  (ingredient) =>
                    !rows.some((row) => row.ingredientId === ingredient.id),
                )?.id || ingredients[0].id,
              quantity: 1,
            },
          ])
        }
      >
        <Plus size={13} />
        Add ingredient to {title}
      </Button>
    </section>
  );
}
