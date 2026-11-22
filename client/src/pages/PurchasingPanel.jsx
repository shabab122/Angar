import { useState } from "react";
import { PackageCheck, Plus, Truck, Wallet } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api, dhakaTime, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
import { minorAmount } from "../components/Financial";
import {
  BatchDetailsFields,
  batchPayload,
  emptyBatch,
} from "./InventoryBatchesPanel";

const blankSupplier = () => ({
  name: "",
  contact: "",
  phone: "",
  email: "",
  address: "",
  notes: "",
  active: true,
});
const blankLine = () => ({
  ingredientId: "",
  quantity: "",
  price: "",
  per: "1000",
});
function PurchaseDetails({ id, onClose }) {
  const { money } = useApp(),
    resource = useResource("/staff/purchases/" + id, { interval: 5000 }),
    row = resource.data?.purchase;
  return (
    <Modal
      open
      title="Purchase order record"
      className="management-dialog purchase-record"
      onClose={onClose}
    >
      {resource.error ? (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      ) : !row ? (
        <Loading />
      ) : (
        <>
          <h2>{row.code}</h2>
          <p>
            {row.supplierName} · {row.status.replaceAll("_", " ")}
          </p>
          <p className="commerce-note">
            Created {dhakaTime(row.createdAt)} by {row.createdBy}
            {row.dueOn && <> · Payment due {row.dueOn}</>}
          </p>
          <div className="v25-metrics">
            {[
              ["Ordered value", row.orderedMinor],
              ["Goods received", row.receivedMinor],
              ["Paid to supplier", row.paidMinor],
              ["Outstanding", row.balanceMinor],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{money(value / 100)}</strong>
              </div>
            ))}
          </div>
          <div className="commerce-table-scroll">
            <table className="v25-table">
              <thead>
                <tr>
                  <th>Ingredient / price</th>
                  <th>Ordered</th>
                  <th>Received</th>
                  <th>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((line) => (
                  <tr key={line.ingredientId}>
                    <td>
                      {line.ingredientName}
                      <small>
                        {money(line.unitPriceMinor / 100)} per{" "}
                        {line.pricePerQuantity} {line.unit}
                      </small>
                    </td>
                    <td>
                      {line.quantity} {line.unit}
                    </td>
                    <td>
                      {line.receivedQuantity} {line.unit}
                    </td>
                    <td>
                      {line.outstandingQuantity} {line.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {row.notes && <p className="commerce-note">{row.notes}</p>}
          <h3>Delivery receipts</h3>
          {resource.data.receipts.map((receipt) => (
            <article className="v25-ledger-entry" key={receipt.id}>
              <strong>
                {receipt.reference} · {money(receipt.valueMinor / 100)}
              </strong>
              <small>
                {dhakaTime(receipt.at)} · {receipt.by}
              </small>
              {receipt.items.map((item) => (
                <p className="commerce-note" key={item.ingredientId}>
                  {item.ingredientName}: {item.quantity} {item.unit}
                  {item.batches?.map((batch) => (
                    <span key={batch.batchId}>
                      {" "}
                      · {batch.code}
                      {batch.expiresOn
                        ? " (expiry " + batch.expiresOn + ")"
                        : " (non-perishable)"}
                    </span>
                  ))}
                </p>
              ))}
              <p className="commerce-note">{receipt.reason}</p>
            </article>
          ))}
          {!resource.data.receipts.length && (
            <p className="commerce-note">No delivery received yet.</p>
          )}
          <p className="commerce-note">
            Returned goods credit: {money((row.returnedMinor || 0) / 100)} ·
            Supplier refunds received:{" "}
            {money((row.supplierRefundMinor || 0) / 100)}. A negative
            outstanding balance is supplier credit receivable.
          </p>
          <h3>Supplier payment records</h3>
          {resource.data.payments.map((payment) => (
            <article className="v25-ledger-entry" key={payment.id}>
              <strong>
                {money(payment.amountMinor / 100)} · {payment.method}
              </strong>
              <small>
                {payment.reference} · {dhakaTime(payment.at)} · {payment.by}
              </small>
              <p className="commerce-note">{payment.reason}</p>
            </article>
          ))}
          {!resource.data.payments.length && (
            <p className="commerce-note">
              No verified supplier payments recorded.
            </p>
          )}
          <details>
            <summary>Purchase history</summary>
            <ol className="fulfillment-history">
              {row.history.map((entry, index) => (
                <li key={index}>
                  {entry.status.replaceAll("_", " ")} · {dhakaTime(entry.at)} ·{" "}
                  {entry.by}
                  {entry.reason && " · " + entry.reason}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </Modal>
  );
}

export function PurchasingPanel({ user }) {
  const { money, notify } = useApp(),
    admin = user.role === "admin";
  const [tab, setTab] = useState("purchases"),
    [supplierFilter, setSupplierFilter] = useState(""),
    [search, setSearch] = useState(""),
    [codeFilter, setCodeFilter] = useState("");
  const suppliers = useResource("/staff/suppliers", { interval: 10000 }),
    inventory = useResource("/staff/inventory", {
      enabled: admin,
      interval: 10000,
    });
  const purchases = useResource(
    "/staff/purchases?" +
      new URLSearchParams({
        ...(supplierFilter ? { supplier: supplierFilter } : {}),
        ...(codeFilter ? { code: codeFilter } : {}),
      }),
    { interval: 5000 },
  );
  const [action, setAction] = useState(null),
    [details, setDetails] = useState(null),
    [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ingredients = inventory.data?.ingredients || [];
  function open(type, row) {
    setAction({ type, row, key: requestKey() });
    setError("");
    setValues(
      type === "supplier"
        ? { ...(row || blankSupplier()), reason: "" }
        : type === "purchase"
          ? {
              supplierId: supplierFilter || "",
              lines: [blankLine()],
              dueOn: "",
              notes: "",
            }
          : type === "receive"
            ? {
                items: row.lines
                  .filter((line) => line.outstandingQuantity > 0)
                  .map((line) => ({
                    ingredientId: line.ingredientId,
                    quantity: "",
                    batch: emptyBatch(),
                  })),
                reference: "",
                reason: "",
                verified: false,
              }
            : {
                amount: row ? (row.balanceMinor / 100).toFixed(2) : "",
                method: "bank",
                reference: "",
                reason: "",
                verified: false,
              },
    );
  }
  const edit = (field) => (event) =>
    setValues({ ...values, [field]: event.target.value });
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { type, row, key } = action;
      let path,
        data,
        method = "POST";
      if (type === "supplier") {
        path = "/staff/suppliers" + (row ? "/" + row.id : "");
        method = row ? "PATCH" : "POST";
        data = Object.fromEntries(
          [
            "name",
            "contact",
            "phone",
            "email",
            "address",
            "notes",
            "active",
          ].map((field) => [field, values[field]]),
        );
        if (row)
          Object.assign(data, {
            expectedRevision: row.revision,
            reason: values.reason,
          });
      } else if (type === "purchase") {
        path = "/staff/purchases";
        data = {
          supplierId: values.supplierId,
          lines: values.lines.map((line) => ({
            ingredientId: line.ingredientId,
            quantity: Number(line.quantity),
            unitPriceMinor: minorAmount(line.price),
            pricePerQuantity: Number(line.per),
          })),
          dueOn: values.dueOn,
          notes: values.notes,
          requestKey: key,
        };
        if (data.lines.some((line) => line.unitPriceMinor === null))
          throw new Error(
            "Use a valid purchase price with at most two decimal places.",
          );
      } else if (type === "receive") {
        path = "/staff/purchases/" + row.id + "/receive";
        data = {
          expectedRevision: row.revision,
          reference: values.reference,
          reason: values.reason,
          requestKey: key,
          items: values.items
            .filter((item) => Number(item.quantity) > 0)
            .map((item) => ({
              ingredientId: item.ingredientId,
              quantity: Number(item.quantity),
              ...(ingredients.find(
                (ingredient) => ingredient.id === item.ingredientId,
              )?.batchTracked
                ? { batch: batchPayload(item.batch) }
                : {}),
            })),
        };
        if (!data.items.length)
          throw new Error(
            "Enter at least one quantity physically received in this delivery.",
          );
      } else if (type === "pay") {
        path = "/staff/purchases/" + row.id + "/payments";
        data = {
          amountMinor: minorAmount(values.amount),
          method: values.method,
          reference: values.reference,
          reason: values.reason,
          verified: values.verified,
          requestKey: key,
        };
        if (!data.amountMinor)
          throw new Error("Enter a positive exact supplier payment amount.");
      } else {
        path = "/staff/purchases/" + row.id + "/action";
        data = {
          action: type,
          expectedRevision: row.revision,
          reason: values.reason,
        };
      }
      await api(path, { method, data });
      setAction(null);
      await purchases.reload();
      await suppliers.reload();
      if (admin) await inventory.reload();
      notify(
        type === "receive"
          ? "Delivery, stock and supplier balance recorded."
          : type === "pay"
            ? "Verified supplier payment recorded."
            : "Purchasing record saved.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  function lineEdit(index, field, value) {
    setValues((previous) => ({
      ...previous,
      lines: previous.lines.map((line, position) =>
        position === index
          ? {
              ...line,
              [field]: value,
              ...(field === "ingredientId"
                ? {
                    per:
                      ingredients.find((item) => item.id === value)?.unit ===
                      "pcs"
                        ? "1"
                        : "1000",
                  }
                : {}),
            }
          : line,
      ),
    }));
  }
  return (
    <section className="purchasing-panel">
      <div className="panel-heading">
        <div>
          <h2>Suppliers & purchases</h2>
          <p>
            Order ingredients, count deliveries and record actual supplier
            payments. The amount owed grows only as goods are received.
          </p>
        </div>
        <div className="commerce-inline-actions">
          {admin && (
            <>
              <Button secondary onClick={() => open("supplier")}>
                <Plus size={15} />
                Add supplier
              </Button>
              <Button
                onClick={() => open("purchase")}
                disabled={
                  !suppliers.data?.suppliers.some((row) => row.active) ||
                  !ingredients.length
                }
              >
                <Plus size={15} />
                Create purchase order
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="page-tabs">
        <button
          type="button"
          aria-pressed={tab === "purchases"}
          onClick={() => setTab("purchases")}
        >
          Purchase orders
        </button>
        <button
          type="button"
          aria-pressed={tab === "suppliers"}
          onClick={() => setTab("suppliers")}
        >
          Supplier directory
        </button>
      </div>
      {(suppliers.error || purchases.error || (admin && inventory.error)) && (
        <ErrorMessage>
          {suppliers.error?.message ||
            purchases.error?.message ||
            inventory.error?.message}
        </ErrorMessage>
      )}
      {tab === "suppliers" ? (
        suppliers.loading ? (
          <Loading />
        ) : (
          <div className="commerce-staff-grid">
            {suppliers.data?.suppliers.map((row) => (
              <article className="commerce-card" key={row.id}>
                <div className="commerce-section-heading">
                  <h3>{row.name}</h3>
                  <span className="management-status">
                    {row.active ? "Active" : "Archived"}
                  </span>
                </div>
                <p>
                  {row.contact}
                  {row.phone && " · " + row.phone}
                  <br />
                  {row.email}
                </p>
                {row.address && <p className="commerce-note">{row.address}</p>}
                <p>
                  Outstanding: <strong>{money(row.balanceMinor / 100)}</strong>
                </p>
                {row.notes && <p className="commerce-note">{row.notes}</p>}
                <div className="commerce-inline-actions">
                  <Button
                    secondary
                    className="button-small"
                    onClick={() => {
                      setSupplierFilter(row.id);
                      setTab("purchases");
                      setCodeFilter("");
                      setSearch("");
                    }}
                  >
                    View supplier purchases
                  </Button>
                  {admin && (
                    <Button
                      secondary
                      className="button-small"
                      onClick={() => open("supplier", row)}
                    >
                      Edit supplier
                    </Button>
                  )}
                </div>
              </article>
            ))}
            {!suppliers.data?.suppliers.length && (
              <p className="commerce-note">
                Add a supplier before creating a purchase order.
              </p>
            )}
          </div>
        )
      ) : (
        <>
          <form
            className="commerce-form commerce-card"
            onSubmit={(event) => {
              event.preventDefault();
              setCodeFilter(search.trim());
            }}
          >
            <div className="commerce-two">
              <label>
                Supplier filter
                <select
                  aria-label="Purchase supplier filter"
                  value={supplierFilter}
                  onChange={(event) => setSupplierFilter(event.target.value)}
                >
                  <option value="">All suppliers</option>
                  {suppliers.data?.suppliers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Exact purchase reference
                <input
                  aria-label="Purchase reference search"
                  maxLength={40}
                  placeholder="PO-…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            </div>
            <Button type="submit">Find purchase order</Button>
          </form>
          <div className="v25-metrics">
            {[
              ["Ordered value", purchases.data?.totals.orderedMinor],
              ["Goods received", purchases.data?.totals.receivedMinor],
              ["Paid to suppliers", purchases.data?.totals.paidMinor],
              ["Outstanding", purchases.data?.totals.outstandingMinor],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{money((value || 0) / 100)}</strong>
              </div>
            ))}
          </div>
          <p className="commerce-note">
            Totals cover the selected filter. The list shows up to 100 recent
            orders; use an exact reference for older records.
          </p>
          {purchases.loading ? (
            <Loading />
          ) : (
            <div className="commerce-staff-grid">
              {purchases.data?.purchases.map((row) => (
                <article className="commerce-card" key={row.id}>
                  <div className="commerce-section-heading">
                    <h3>{row.code}</h3>
                    <span className="management-status">
                      {row.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p>{row.supplierName}</p>
                  <p className="commerce-note">
                    {dhakaTime(row.createdAt)}
                    {row.dueOn && <> · Due {row.dueOn}</>}
                    {row.overdue && (
                      <>
                        <br />
                        <strong>Payment overdue</strong>
                      </>
                    )}
                  </p>
                  <p>
                    Received {money(row.receivedMinor / 100)} · Paid{" "}
                    {money(row.paidMinor / 100)}
                    <br />
                    Outstanding <strong>{money(row.balanceMinor / 100)}</strong>
                  </p>
                  <div className="commerce-inline-actions">
                    <Button
                      secondary
                      className="button-small"
                      onClick={() => setDetails(row.id)}
                    >
                      View purchase record
                    </Button>
                    {admin && row.status === "draft" && (
                      <Button
                        className="button-small"
                        onClick={() => open("order", row)}
                      >
                        Confirm purchase order
                      </Button>
                    )}
                    {admin &&
                      ["ordered", "partially_received"].includes(
                        row.status,
                      ) && (
                        <Button
                          className="button-small"
                          onClick={() => open("receive", row)}
                        >
                          <Truck size={15} />
                          Receive delivery
                        </Button>
                      )}
                    {row.balanceMinor > 0 && (
                      <Button
                        secondary
                        className="button-small"
                        onClick={() => open("pay", row)}
                      >
                        <Wallet size={15} />
                        Record supplier payment
                      </Button>
                    )}
                    {admin &&
                      ["draft", "ordered", "partially_received"].includes(
                        row.status,
                      ) && (
                        <Button
                          secondary
                          className="button-small"
                          onClick={() => open("cancel", row)}
                        >
                          Cancel remaining delivery
                        </Button>
                      )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {!purchases.loading && !purchases.data?.purchases.length && (
            <p className="commerce-note">No purchase orders match this view.</p>
          )}
        </>
      )}
      {action && (
        <Modal
          open
          className="management-dialog"
          title={
            action.type === "supplier"
              ? action.row
                ? "Edit supplier"
                : "Add supplier"
              : action.type === "purchase"
                ? "Create purchase order"
                : action.type === "receive"
                  ? "Receive supplier delivery"
                  : action.type === "pay"
                    ? "Record supplier payment"
                    : action.type === "order"
                      ? "Confirm purchase order"
                      : "Cancel remaining delivery"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            {action.row?.code && (
              <p>
                {action.row.code} · {action.row.supplierName}
              </p>
            )}
            {action.type === "supplier" && (
              <>
                {[
                  ["name", "Supplier name", 100, true],
                  ["contact", "Contact person", 80, false],
                  ["phone", "Supplier phone", 25, false],
                  ["email", "Supplier email", 254, false],
                  ["address", "Supplier address", 240, false],
                ].map(([field, label, max, required]) => (
                  <label key={field}>
                    {label}
                    <input
                      aria-label={label}
                      type={
                        field === "email"
                          ? "email"
                          : field === "phone"
                            ? "tel"
                            : "text"
                      }
                      minLength={field === "name" ? 2 : undefined}
                      maxLength={max}
                      required={required}
                      value={values[field]}
                      onChange={edit(field)}
                    />
                  </label>
                ))}
                <label>
                  Supplier notes
                  <textarea
                    maxLength={240}
                    value={values.notes}
                    onChange={edit("notes")}
                  />
                </label>
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    checked={values.active}
                    onChange={(event) =>
                      setValues({ ...values, active: event.target.checked })
                    }
                  />
                  <span>Active supplier for new purchase orders</span>
                </label>
              </>
            )}
            {action.type === "purchase" && (
              <>
                <label>
                  Supplier
                  <select
                    aria-label="New purchase supplier"
                    required
                    value={values.supplierId}
                    onChange={edit("supplierId")}
                  >
                    <option value="">Choose supplier</option>
                    {suppliers.data?.suppliers
                      .filter((row) => row.active)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </select>
                </label>
                {values.lines.map((line, index) => {
                  const ingredient = ingredients.find(
                    (row) => row.id === line.ingredientId,
                  );
                  return (
                    <fieldset className="v25-purchase-line" key={index}>
                      <legend>Ingredient {index + 1}</legend>
                      <label>
                        Ingredient
                        <select
                          aria-label={"Purchase ingredient " + (index + 1)}
                          required
                          value={line.ingredientId}
                          onChange={(event) =>
                            lineEdit(index, "ingredientId", event.target.value)
                          }
                        >
                          <option value="">Choose ingredient</option>
                          {ingredients.map((row) => (
                            <option
                              key={row.id}
                              value={row.id}
                              disabled={values.lines.some(
                                (item, position) =>
                                  position !== index &&
                                  item.ingredientId === row.id,
                              )}
                            >
                              {row.name} · {row.unit}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="commerce-two">
                        <label>
                          Quantity ({ingredient?.unit || "base units"})
                          <input
                            aria-label={"Purchase quantity " + (index + 1)}
                            required
                            type="number"
                            step="1"
                            min="1"
                            max="1000000000"
                            value={line.quantity}
                            onChange={(event) =>
                              lineEdit(index, "quantity", event.target.value)
                            }
                          />
                        </label>
                        <label>
                          Price (BDT)
                          <input
                            aria-label={"Purchase price " + (index + 1)}
                            required
                            inputMode="decimal"
                            value={line.price}
                            onChange={(event) =>
                              lineEdit(index, "price", event.target.value)
                            }
                          />
                        </label>
                      </div>
                      <label>
                        Price applies to how many{" "}
                        {ingredient?.unit || "base units"}?
                        <input
                          aria-label={"Purchase price units " + (index + 1)}
                          required
                          type="number"
                          min="1"
                          max="1000000"
                          step="1"
                          value={line.per}
                          onChange={(event) =>
                            lineEdit(index, "per", event.target.value)
                          }
                        />
                      </label>
                      {values.lines.length > 1 && (
                        <Button
                          secondary
                          onClick={() =>
                            setValues({
                              ...values,
                              lines: values.lines.filter(
                                (_, position) => position !== index,
                              ),
                            })
                          }
                        >
                          Remove ingredient {index + 1}
                        </Button>
                      )}
                    </fieldset>
                  );
                })}
                <Button
                  secondary
                  disabled={
                    values.lines.length >= 30 ||
                    values.lines.length >= ingredients.length
                  }
                  onClick={() =>
                    setValues({
                      ...values,
                      lines: [...values.lines, blankLine()],
                    })
                  }
                >
                  <Plus size={15} />
                  Add purchase ingredient
                </Button>
                <label>
                  Supplier payment due date (optional)
                  <input
                    aria-label="Supplier payment due date"
                    type="date"
                    value={values.dueOn}
                    onChange={edit("dueOn")}
                  />
                </label>
                <label>
                  Purchase notes
                  <textarea
                    maxLength={240}
                    value={values.notes}
                    onChange={edit("notes")}
                  />
                </label>
                <p className="commerce-note">
                  Prices use whole inventory base units. Example: a BDT price
                  for 1,000 g is a price per kilogram. Review the saved draft
                  before confirming the order. Creating it does not send a
                  message to the supplier.
                </p>
              </>
            )}
            {action.type === "receive" && (
              <>
                <p className="commerce-note">
                  Enter only quantities counted in this delivery. Unreceived
                  lines remain outstanding. Stock and the amount owed to the
                  supplier are recorded together.
                </p>
                {values.items.map((item, index) => {
                  const line = action.row.lines.find(
                      (row) => row.ingredientId === item.ingredientId,
                    ),
                    ingredient = ingredients.find(
                      (row) => row.id === item.ingredientId,
                    );
                  return (
                    <fieldset
                      className="v25-purchase-line"
                      key={item.ingredientId}
                    >
                      <legend>{line.ingredientName}</legend>
                      <p className="commerce-note">
                        Outstanding {line.outstandingQuantity} {line.unit}
                      </p>
                      <label>
                        Delivered quantity ({line.unit})
                        <input
                          aria-label={"Delivered quantity " + (index + 1)}
                          type="number"
                          min="0"
                          max={line.outstandingQuantity}
                          step="1"
                          value={item.quantity}
                          onChange={(event) =>
                            setValues({
                              ...values,
                              items: values.items.map((row, position) =>
                                position === index
                                  ? { ...row, quantity: event.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </label>
                      {ingredient?.batchTracked &&
                        Number(item.quantity) > 0 && (
                          <BatchDetailsFields
                            prefix={"Delivery line " + (index + 1) + " "}
                            value={item.batch}
                            onChange={(batch) =>
                              setValues({
                                ...values,
                                items: values.items.map((row, position) =>
                                  position === index ? { ...row, batch } : row,
                                ),
                              })
                            }
                          />
                        )}
                    </fieldset>
                  );
                })}
                <label>
                  Delivery note / invoice reference
                  <input
                    aria-label="Supplier delivery reference"
                    required
                    minLength={2}
                    maxLength={80}
                    value={values.reference}
                    onChange={edit("reference")}
                  />
                </label>
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    required
                    checked={values.verified}
                    onChange={(event) =>
                      setValues({ ...values, verified: event.target.checked })
                    }
                  />
                  <span>
                    I counted these delivered quantities and checked the batch
                    details.
                  </span>
                </label>
              </>
            )}
            {action.type === "pay" && (
              <>
                <p>
                  Unpaid received goods:{" "}
                  <strong>{money(action.row.balanceMinor / 100)}</strong>
                </p>
                <label>
                  Amount paid (BDT)
                  <input
                    aria-label="Supplier payment amount"
                    required
                    inputMode="decimal"
                    value={values.amount}
                    onChange={edit("amount")}
                  />
                </label>
                <label>
                  Payment channel
                  <select
                    aria-label="Supplier payment channel"
                    value={values.method}
                    onChange={edit("method")}
                  >
                    {[
                      ["bank", "Bank transfer"],
                      ["cash", "Cash"],
                      ["bkash", "bKash"],
                      ["nagad", "Nagad"],
                      ["card", "Card"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Payment reference
                  {values.method === "cash" ? " (optional)" : ""}
                  <input
                    aria-label="Supplier payment reference"
                    required={values.method !== "cash"}
                    maxLength={100}
                    value={values.reference}
                    onChange={edit("reference")}
                  />
                </label>
                <label className="commerce-checkbox">
                  <input
                    type="checkbox"
                    required
                    checked={values.verified}
                    onChange={(event) =>
                      setValues({ ...values, verified: event.target.checked })
                    }
                  />
                  <span>
                    I verified this payment was actually made to the supplier.
                  </span>
                </label>
                <p className="commerce-note">
                  This records an actual payment. Cash is included in the active
                  shared drawer when a shift is open.
                </p>
              </>
            )}
            {action.type === "order" && (
              <p>
                Ordered value: {money(action.row.orderedMinor / 100)}. Confirm
                after reviewing the ingredient quantities and agreed prices.
              </p>
            )}
            {action.type === "cancel" && (
              <p className="commerce-note">
                This cancels the unreceived delivery balance. Received goods,
                recorded payments and any amount still owed stay in the purchase
                history.
              </p>
            )}
            {(action.type !== "supplier" || action.row) &&
              action.type !== "purchase" && (
                <label>
                  Reason
                  <textarea
                    aria-label="Purchase action reason"
                    required
                    minLength={3}
                    maxLength={160}
                    value={values.reason}
                    onChange={edit("reason")}
                  />
                </label>
              )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={
                busy ||
                (["pay", "receive"].includes(action.type) && !values.verified)
              }
            >
              {action.type === "supplier"
                ? "Save supplier"
                : action.type === "purchase"
                  ? "Save purchase draft"
                  : action.type === "receive"
                    ? "Record counted delivery"
                    : action.type === "pay"
                      ? "Record verified supplier payment"
                      : action.type === "order"
                        ? "Confirm agreed purchase"
                        : "Confirm delivery cancellation"}
            </Button>
          </form>
        </Modal>
      )}
      {details && (
        <PurchaseDetails id={details} onClose={() => setDetails(null)} />
      )}
    </section>
  );
}
