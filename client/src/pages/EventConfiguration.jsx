import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { Button, ErrorMessage, Loading } from "../components/UI";
const blankSpace = () => ({
  id: "",
  name: "",
  capacity: 20,
  minGuests: 8,
  description: "",
  resourceIds: ["dining-room"],
  blocksDining: true,
  active: true,
});
const blankPackage = () => ({
  id: "",
  name: "",
  description: "",
  perGuest: 550,
  hallFee: 0,
  depositPercent: 0,
  active: true,
});
export default function EventConfiguration() {
  const resource = useResource("/staff/event-config"),
    [value, setValue] = useState(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    { notify } = useApp();
  useEffect(() => {
    if (resource.data && !value)
      setValue(structuredClone(resource.data.configuration));
  }, [resource.data, value]);
  const edit = (group, index, key, next) =>
    setValue((old) => ({
      ...old,
      [group]: old[group].map((row, i) =>
        i === index ? { ...row, [key]: next } : row,
      ),
    }));
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/staff/event-config", {
        method: "PUT",
        data: {
          spaces: value.spaces,
          packages: value.packages,
          expectedRevision: value.revision,
          reason,
        },
      });
      setValue(result.configuration);
      setReason("");
      notify(
        "Event spaces and packages saved. Existing quotes keep their agreed prices.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading || (!value && !resource.error)) return <Loading />;
  if (resource.error && !value)
    return (
      <ErrorMessage onRetry={resource.reload}>
        {resource.error.message}
      </ErrorMessage>
    );
  return (
    <form className="commerce-form v27-event-config" onSubmit={save}>
      <div className="panel-heading">
        <div>
          <h2>Event spaces & package prices</h2>
          <p>
            Prices below guide new requests and quotes. Previously issued quotes
            keep their own price snapshots.
          </p>
        </div>
        <Button
          secondary
          onClick={async () => {
            const next = await resource.reload();
            if (next) setValue(structuredClone(next.configuration));
          }}
        >
          Reload configuration
        </Button>
      </div>
      <h3>Event spaces</h3>
      <p>
        Spaces sharing a resource code cannot be booked at the same time.
        “Blocks table reservations” reserves the restaurant dining floor.
        Archive a space to stop new requests.
      </p>
      {value.spaces.map((row, index) => (
        <article className="commerce-card" key={index}>
          <div className="commerce-two">
            <label>
              Space code
              <input
                aria-label={"Space code " + (index + 1)}
                pattern="[a-z][a-z0-9-]{1,39}"
                required
                maxLength={40}
                value={row.id}
                onChange={(e) => edit("spaces", index, "id", e.target.value)}
              />
            </label>
            <label>
              Space name
              <input
                aria-label={"Space name " + (index + 1)}
                required
                minLength={2}
                maxLength={80}
                value={row.name}
                onChange={(e) => edit("spaces", index, "name", e.target.value)}
              />
            </label>
            <label>
              Capacity
              <input
                aria-label={"Space capacity " + (index + 1)}
                type="number"
                required
                min="1"
                max="500"
                value={row.capacity}
                onChange={(e) =>
                  edit("spaces", index, "capacity", Number(e.target.value))
                }
              />
            </label>
            <label>
              Minimum guests
              <input
                aria-label={"Minimum guests " + (index + 1)}
                type="number"
                required
                min="1"
                max={row.capacity}
                value={row.minGuests}
                onChange={(e) =>
                  edit("spaces", index, "minGuests", Number(e.target.value))
                }
              />
            </label>
          </div>
          <label>
            Description
            <textarea
              required
              maxLength={300}
              value={row.description}
              onChange={(e) =>
                edit("spaces", index, "description", e.target.value)
              }
            />
          </label>
          <label>
            Shared resource codes (comma separated)
            <input
              required
              value={row.resourceIds.join(", ")}
              onChange={(e) =>
                edit(
                  "spaces",
                  index,
                  "resourceIds",
                  e.target.value.split(",").map((v) => v.trim()),
                )
              }
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={row.blocksDining}
              onChange={(e) =>
                edit("spaces", index, "blocksDining", e.target.checked)
              }
            />
            Blocks table reservations
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={row.active}
              onChange={(e) =>
                edit("spaces", index, "active", e.target.checked)
              }
            />
            Available for new requests
          </label>
        </article>
      ))}
      <Button
        secondary
        disabled={value.spaces.length >= 12}
        onClick={() =>
          setValue({ ...value, spaces: [...value.spaces, blankSpace()] })
        }
      >
        Add event space
      </Button>
      <h3>Packages</h3>
      {value.packages.map((row, index) => (
        <article className="commerce-card" key={index}>
          <div className="commerce-two">
            <label>
              Package code
              <input
                aria-label={"Package code " + (index + 1)}
                pattern="[a-z][a-z0-9-]{1,39}"
                required
                maxLength={40}
                value={row.id}
                onChange={(e) => edit("packages", index, "id", e.target.value)}
              />
            </label>
            <label>
              Package name
              <input
                required
                minLength={2}
                maxLength={80}
                value={row.name}
                onChange={(e) =>
                  edit("packages", index, "name", e.target.value)
                }
              />
            </label>
            <label>
              Price per guest (৳)
              <input
                aria-label={"Package price " + (index + 1)}
                type="number"
                min="0"
                max="10000"
                step="1"
                placeholder="Personal quote"
                value={row.perGuest ?? ""}
                onChange={(e) =>
                  edit(
                    "packages",
                    index,
                    "perGuest",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            </label>
            <label>
              Suggested hall fee (৳)
              <input
                type="number"
                required
                min="0"
                max="500000"
                value={row.hallFee}
                onChange={(e) =>
                  edit("packages", index, "hallFee", Number(e.target.value))
                }
              />
            </label>
            <label>
              Suggested deposit (%)
              <input
                type="number"
                required
                min="0"
                max="100"
                value={row.depositPercent}
                onChange={(e) =>
                  edit(
                    "packages",
                    index,
                    "depositPercent",
                    Number(e.target.value),
                  )
                }
              />
            </label>
          </div>
          <label>
            Description / menu inspiration
            <textarea
              maxLength={500}
              value={row.description}
              onChange={(e) =>
                edit("packages", index, "description", e.target.value)
              }
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={row.active}
              onChange={(e) =>
                edit("packages", index, "active", e.target.checked)
              }
            />
            Available for new requests
          </label>
        </article>
      ))}
      <Button
        secondary
        disabled={value.packages.length >= 12}
        onClick={() =>
          setValue({ ...value, packages: [...value.packages, blankPackage()] })
        }
      >
        Add event package
      </Button>
      <label>
        Reason for configuration change
        <input
          aria-label="Event configuration reason"
          required
          minLength={3}
          maxLength={160}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving event options…" : "Save event configuration"}
      </Button>
    </form>
  );
}
