import { useEffect, useState } from "react";
import { FileText, ReceiptText } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { api } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading } from "../components/UI";

export function InvoiceSettings() {
  const { notify, money } = useApp();
  const resource = useResource("/staff/invoice-settings");
  const [values, setValues] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (resource.data && !values)
      setValues({
        tax: resource.data.tax,
        invoice: resource.data.invoice,
        expectedRevision: resource.data.revision,
        reason: "",
      });
  }, [resource.data, values]);
  function tax(field, value) {
    setValues((previous) => ({
      ...previous,
      tax: { ...previous.tax, [field]: value },
    }));
  }
  function invoice(field, value) {
    setValues((previous) => ({
      ...previous,
      invoice: { ...previous.invoice, [field]: value },
    }));
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/invoice-settings", { method: "POST", data: values });
      await resource.reload();
      setValues(null);
      notify("Tax and invoice settings saved for future bills.");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (!values)
    return resource.error ? (
      <ErrorMessage onRetry={resource.reload}>
        {resource.error.message}
      </ErrorMessage>
    ) : (
      <Loading />
    );
  const example = resource.data.example;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>Tax / VAT & invoice settings</h2>
          <p>
            Saved settings apply when a new bill is finalized. Existing invoices
            and credit notes keep their original values.
          </p>
        </div>
      </div>
      <form className="commerce-form invoice-settings-form" onSubmit={submit}>
        <div className="commerce-settings-grid">
          <article className="commerce-card commerce-form">
            <h2>
              <ReceiptText size={21} />
              Tax / VAT
            </h2>
            <p className="commerce-note">
              No legal rate is assumed. Enter the rate and tax base applicable
              to your restaurant. Service charge is managed in Restaurant
              settings.
            </p>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                checked={values.tax.enabled}
                onChange={(event) => tax("enabled", event.target.checked)}
              />
              Enable tax calculation
            </label>
            <label>
              Tax label
              <input
                required
                maxLength={30}
                value={values.tax.label}
                onChange={(event) => tax("label", event.target.value)}
              />
            </label>
            <label>
              Tax rate (%)
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                required
                value={values.tax.rateBps / 100}
                onChange={(event) =>
                  tax("rateBps", Math.round(Number(event.target.value) * 100))
                }
              />
            </label>
            <label>
              Price treatment
              <select
                aria-label="Price treatment"
                value={values.tax.mode}
                onChange={(event) => tax("mode", event.target.value)}
              >
                <option value="exclusive">Add tax to the bill</option>
                <option value="inclusive">
                  Tax is included in listed prices
                </option>
              </select>
            </label>
            <label>
              Taxable base
              <select
                aria-label="Taxable base"
                value={values.tax.base}
                onChange={(event) => tax("base", event.target.value)}
              >
                <option value="food">Food after discounts</option>
                <option value="food_and_service">
                  Food after discounts + service charge
                </option>
              </select>
            </label>
            <p className="commerce-note">
              Inclusive mode extracts tax for reporting without adding it again.
              Coupon/points discounts are applied before the tax calculation.
            </p>
          </article>
          <article className="commerce-card commerce-form">
            <h2>
              <FileText size={21} />
              Invoice identity
            </h2>
            {[
              ["businessName", "Business / legal name", 100],
              ["address", "Business address", 240],
              ["phone", "Invoice phone", 40],
              ["email", "Invoice email", 254],
              ["taxRegistration", "Tax registration / BIN", 80],
            ].map(([field, label, max]) => (
              <label key={field}>
                {label}
                <input
                  type={field === "email" ? "email" : "text"}
                  maxLength={max}
                  value={values.invoice[field]}
                  onChange={(event) => invoice(field, event.target.value)}
                />
              </label>
            ))}
            <label>
              Receipt prefix
              <input
                minLength={2}
                maxLength={8}
                pattern="[A-Z0-9]{2,8}"
                required
                value={values.invoice.prefix}
                onChange={(event) =>
                  invoice("prefix", event.target.value.toUpperCase())
                }
              />
            </label>
            <label>
              Numbering
              <select
                aria-label="Numbering"
                value={values.invoice.numbering}
                onChange={(event) => invoice("numbering", event.target.value)}
              >
                <option value="random">Existing unique receipt numbers</option>
                <option value="sequential">
                  Sequential per prefix and year
                </option>
              </select>
            </label>
            <label>
              Invoice footer
              <textarea
                maxLength={200}
                value={values.invoice.footer}
                onChange={(event) => invoice("footer", event.target.value)}
              />
            </label>
          </article>
        </div>
        <article className="commerce-card">
          <h3>Saved-settings example</h3>
          <p className="commerce-note">
            For {money(1000)} food after discounts and the current{" "}
            {resource.data.serviceChargeBps / 100}% service charge. Save changes
            to refresh this example.
          </p>
          <div className="commerce-bill-summary">
            <div>
              <span>Service charge</span>
              <strong>{money(example.chargeMinor / 100)}</strong>
            </div>
            <div>
              <span>
                {resource.data.tax.label}
                {example.taxIncluded ? " (included)" : ""}
              </span>
              <strong>{money(example.taxMinor / 100)}</strong>
            </div>
            <div className="commerce-grand">
              <span>Final total</span>
              <strong>{money(example.totalMinor / 100)}</strong>
            </div>
          </div>
        </article>
        <label>
          Reason for configuration change
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
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <div className="commerce-inline-actions">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save tax & invoice settings"}
          </Button>
          <Button
            secondary
            disabled={busy}
            onClick={async () => {
              await resource.reload();
              setValues(null);
              setError("");
            }}
          >
            Reload saved settings
          </Button>
        </div>
      </form>
    </section>
  );
}
