import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { Button, Loading, ErrorMessage } from "../components/UI";
export default function KitchenStations() {
  const resource = useResource("/staff/printing/routing"),
    [stations, setStations] = useState([]),
    [enabled, setEnabled] = useState(false),
    [password, setPassword] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    { notify } = useApp();
  useEffect(() => {
    if (resource.data) {
      setStations(resource.data.stations);
      setEnabled(resource.data.enabled);
    }
  }, [resource.data]);
  const change = (index, key, value) =>
    setStations(
      stations.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
    );
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/staff/printing/routing", {
        method: "PUT",
        data: {
          enabled,
          stations,
          expectedRevision: resource.data.revision,
          currentPassword: password,
          reason,
        },
      });
      setPassword("");
      setReason("");
      await resource.reload();
      notify("Kitchen routing saved for new orders.");
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
          <h2>Kitchen stations & printers</h2>
          <p>
            Route each category or selected dish to its station. Existing orders
            keep their original routing.
          </p>
        </div>
      </div>
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {resource.data && (
        <form className="commerce-form" onSubmit={save}>
          <label className="check-line">
            <input
              aria-label="Station routing enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable kitchen station routing for new orders
          </label>
          <p className="commerce-note">
            Printer destinations are configured by the operator. Unmapped dishes
            go to General kitchen on the default printer. Browser printing
            remains available. Automatic sending is controlled in Kitchen &
            receipt printing.
          </p>
          {stations.map((row, index) => (
            <fieldset className="commerce-card" key={index}>
              <legend>Station {index + 1}</legend>
              <div className="v29-form-grid">
                <label>
                  Station code
                  <input
                    aria-label={"Station code " + (index + 1)}
                    required
                    pattern="[a-z][a-z0-9-]{1,23}"
                    maxLength={24}
                    value={row.id}
                    onChange={(e) => change(index, "id", e.target.value)}
                  />
                </label>
                <label>
                  Station name
                  <input
                    aria-label={"Station name " + (index + 1)}
                    required
                    minLength={2}
                    maxLength={50}
                    value={row.name}
                    onChange={(e) => change(index, "name", e.target.value)}
                  />
                </label>
                <label>
                  Printer
                  <select
                    aria-label={"Station printer " + (index + 1)}
                    value={row.printerId}
                    required
                    onChange={(e) => change(index, "printerId", e.target.value)}
                  >
                    {resource.data.printers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.configured ? "" : " · Browser print only"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset>
                <legend>Menu categories</legend>
                {[
                  ["mains", "Rice & mains"],
                  ["grill", "Grill"],
                  ["drinks", "Drinks"],
                  ["dessert", "Dessert"],
                ].map(([id, label]) => (
                  <label className="check-line" key={id}>
                    <input
                      aria-label={"Station " + (index + 1) + " " + label}
                      type="checkbox"
                      checked={row.categories.includes(id)}
                      onChange={(e) =>
                        change(
                          index,
                          "categories",
                          e.target.checked
                            ? [...row.categories, id]
                            : row.categories.filter((v) => v !== id),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label>
                Specific dish overrides
                <select
                  aria-label={"Station dishes " + (index + 1)}
                  multiple
                  value={row.dishIds}
                  onChange={(e) =>
                    change(
                      index,
                      "dishIds",
                      [...e.target.selectedOptions].map((o) => o.value),
                    )
                  }
                >
                  {resource.data.dishes.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <small>
                  Use Ctrl/Cmd to select more than one dish. Explicit dish
                  assignments take priority over category routing.
                </small>
              </label>
              <Button
                secondary
                type="button"
                onClick={() =>
                  setStations(stations.filter((_, i) => i !== index))
                }
              >
                Remove station
              </Button>
            </fieldset>
          ))}
          <Button
            secondary
            type="button"
            disabled={stations.length >= 8}
            onClick={() =>
              setStations([
                ...stations,
                {
                  id: "",
                  name: "",
                  printerId: "default",
                  categories: [],
                  dishIds: [],
                },
              ])
            }
          >
            Add kitchen station
          </Button>
          <label>
            Reason
            <input
              aria-label="Kitchen routing reason"
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
              aria-label="Kitchen routing administrator password"
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <ErrorMessage>{error}</ErrorMessage>}
          <Button type="submit" disabled={busy}>
            Save kitchen routing
          </Button>
        </form>
      )}
    </section>
  );
}
