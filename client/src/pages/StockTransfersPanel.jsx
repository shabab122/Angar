import { useState } from "react";
import { api, requestKey, money, dhakaTime } from "../lib/api";
import { useResource } from "../lib/useResource";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function StockTransfersPanel({ user }) {
  const can = (key) => user.capabilities?.["transfers." + key] === true,
    resource = useResource("/staff/stock-transfers", { interval: 5000 }),
    [destination, setDestination] = useState(""),
    options = useResource(
      "/staff/stock-transfers/options" +
        (destination ? "?to=" + destination : ""),
      { enabled: can("request") },
    ),
    [action, setAction] = useState(null),
    [lines, setLines] = useState([]),
    [reason, setReason] = useState(""),
    [verified, setVerified] = useState(false),
    [quarantine, setQuarantine] = useState(false),
    [counts, setCounts] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [actionKey, setActionKey] = useState("");
  const [password, setPassword] = useState("");
  const current = resource.data?.branchId,
    source = options.data?.source || [],
    target = options.data?.target || [];
  function open(type, row) {
    setAction({ type, row });
    setReason("");
    setVerified(false);
    setQuarantine(false);
    setCounts({});
    setActionKey(requestKey());
    setError("");
    setPassword("");
    if (type === "create") {
      setDestination("");
      setLines([
        { sourceIngredientId: "", targetIngredientId: "", quantity: "" },
      ]);
    }
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (action.type === "create")
        await api("/staff/stock-transfers", {
          method: "POST",
          data: {
            toBranch: destination,
            lines: lines.map((line) => ({
              ...line,
              quantity: Number(line.quantity),
            })),
            reason,
            requestKey: actionKey,
          },
        });
      else if (action.type === "receive") {
        const items = [];
        for (const [index, line] of action.row.lines.entries())
          for (const lot of line.lots) {
            const quantity = Number(counts[index + ":" + lot.key] || 0);
            if (quantity)
              items.push({ lineIndex: index, lotKey: lot.key, quantity });
          }
        if (!items.length)
          throw new Error("Enter at least one physically received quantity.");
        await api("/staff/stock-transfers/" + action.row.id + "/receive", {
          method: "POST",
          data: {
            expectedRevision: action.row.revision,
            requestKey: actionKey,
            reason,
            verified,
            acceptQuarantine: quarantine,
            items,
          },
        });
      } else if (action.type === "recovery")
        await api("/staff/stock-transfers/" + action.row.id + "/recovery", {
          method: "POST",
          data: {
            expectedRevision: action.row.revision,
            sourceVerified: verified,
            destinationVerified: verified,
            currentPassword: password,
            reason,
          },
        });
      else
        await api("/staff/stock-transfers/" + action.row.id + "/action", {
          method: "POST",
          data: {
            action: action.type,
            expectedRevision: action.row.revision,
            reason,
            verified,
          },
        });
      setAction(null);
      await resource.reload();
      if (can("request")) await options.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="v28-panel">
      <div className="panel-heading">
        <div>
          <h2>Inter-branch stock transfers</h2>
          <p>
            Approve, count and dispatch outgoing goods. Receive actual
            quantities at the destination.
          </p>
        </div>
        {can("request") && (
          <Button onClick={() => open("create")}>New stock transfer</Button>
        )}
      </div>
      {resource.loading && <Loading />}
      {resource.error && (
        <ErrorMessage onRetry={resource.reload}>
          {resource.error.message}
        </ErrorMessage>
      )}
      {!resource.loading && !resource.data?.transfers.length && (
        <p>No stock transfers involving this branch yet.</p>
      )}
      <div className="commerce-staff-grid">
        {resource.data?.transfers.map((row) => (
          <article className="commerce-card" key={row.id}>
            <div className="v27-inline">
              <h3>{row.code}</h3>
              <span className="soft-badge">{row.status}</span>
            </div>
            <p>
              {row.fromName} → {row.toName}
            </p>
            <p className="commerce-note">
              {row.reason} · {dhakaTime(row.createdAt)}
            </p>
            {row.lines.map((line, index) => (
              <div key={index}>
                <p>
                  <strong>{line.sourceName}</strong> → {line.targetName} ·{" "}
                  {line.quantity} {line.unit} · Received {line.receivedQuantity}
                </p>
                {line.cost && (
                  <p className="commerce-note">
                    Transfer value {money(line.cost.amountMinor / 100)} ·{" "}
                    {line.cost.complete ? "Cost complete" : "Cost incomplete"}
                  </p>
                )}
                {line.lots.map((lot) => (
                  <p className="commerce-note" key={lot.key}>
                    {lot.code || "Bulk stock"} · Expiry{" "}
                    {lot.expiresOn || "No expiry recorded"} · {lot.received} /{" "}
                    {lot.quantity} received
                  </p>
                ))}
              </div>
            ))}
            {row.needsRecovery ? (
              <div>
                <p className="courier-review">
                  Restored transfer is frozen. An administrator must reconcile
                  both branch journals and physical stock before resuming. See
                  UPGRADE_v2.8_BN.md.
                </p>
                {user.platformAdmin && can("approve") && (
                  <Button secondary onClick={() => open("recovery", row)}>
                    Review transfer recovery
                  </Button>
                )}
              </div>
            ) : (
              <div className="commerce-inline-actions">
                {row.fromBranch === current && (
                  <>
                    {row.status === "requested" && can("approve") && (
                      <>
                        <Button secondary onClick={() => open("approve", row)}>
                          Approve transfer
                        </Button>
                        <Button secondary onClick={() => open("reject", row)}>
                          Reject transfer
                        </Button>
                      </>
                    )}
                    {["requested", "approved"].includes(row.status) &&
                      can("approve") && (
                        <Button secondary onClick={() => open("cancel", row)}>
                          Cancel transfer
                        </Button>
                      )}
                    {row.status === "approved" && can("dispatch") && (
                      <Button onClick={() => open("dispatch", row)}>
                        Count & dispatch
                      </Button>
                    )}
                  </>
                )}
                {row.toBranch === current &&
                  row.status === "dispatched" &&
                  can("receive") && (
                    <Button onClick={() => open("receive", row)}>
                      Count & receive
                    </Button>
                  )}
              </div>
            )}
          </article>
        ))}
      </div>
      {action && (
        <Modal
          open
          className="management-dialog"
          title={
            action.type === "create"
              ? "New stock transfer"
              : action.type === "receive"
                ? "Receive transfer goods"
                : action.type[0].toUpperCase() +
                  action.type.slice(1) +
                  " transfer"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="commerce-form" onSubmit={submit}>
            {action.type === "create" ? (
              <>
                <label>
                  Destination branch
                  <select
                    aria-label="Transfer destination"
                    required
                    value={destination}
                    onChange={(e) => {
                      setDestination(e.target.value);
                      setLines(
                        lines.map((line) => ({
                          ...line,
                          targetIngredientId: "",
                        })),
                      );
                    }}
                  >
                    <option value="">Choose destination</option>
                    {options.data?.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
                {options.error && (
                  <ErrorMessage onRetry={options.reload}>
                    {options.error.message}
                  </ErrorMessage>
                )}
                {lines.map((line, index) => (
                  <div className="v28-transfer-line" key={index}>
                    <label>
                      Source ingredient
                      <select
                        aria-label={"Transfer source ingredient " + (index + 1)}
                        required
                        value={line.sourceIngredientId}
                        onChange={(e) =>
                          setLines(
                            lines.map((row, i) =>
                              i === index
                                ? {
                                    ...row,
                                    sourceIngredientId: e.target.value,
                                    targetIngredientId: "",
                                  }
                                : row,
                            ),
                          )
                        }
                      >
                        <option value="">Choose source</option>
                        {source.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.stock} {item.unit}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Destination ingredient
                      <select
                        aria-label={"Transfer target ingredient " + (index + 1)}
                        required
                        disabled={!destination || options.loading}
                        value={line.targetIngredientId}
                        onChange={(e) =>
                          setLines(
                            lines.map((row, i) =>
                              i === index
                                ? { ...row, targetIngredientId: e.target.value }
                                : row,
                            ),
                          )
                        }
                      >
                        <option value="">Match ingredient</option>
                        {target
                          .filter((item) => {
                            const a = source.find(
                              (i) => i.id === line.sourceIngredientId,
                            );
                            return (
                              a &&
                              a.unit === item.unit &&
                              a.batchTracked === item.batchTracked
                            );
                          })
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {item.unit}
                              {item.batchTracked ? " · Batches" : ""}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Quantity
                      <input
                        aria-label={"Transfer quantity " + (index + 1)}
                        required
                        type="number"
                        min={1}
                        max={1000000000}
                        step={1}
                        value={line.quantity}
                        onChange={(e) =>
                          setLines(
                            lines.map((row, i) =>
                              i === index
                                ? { ...row, quantity: e.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    </label>
                    <Button
                      secondary
                      type="button"
                      disabled={lines.length === 1}
                      onClick={() =>
                        setLines(lines.filter((_, i) => i !== index))
                      }
                    >
                      Remove line
                    </Button>
                  </div>
                ))}
                <Button
                  secondary
                  type="button"
                  disabled={lines.length >= 30}
                  onClick={() =>
                    setLines([
                      ...lines,
                      {
                        sourceIngredientId: "",
                        targetIngredientId: "",
                        quantity: "",
                      },
                    ])
                  }
                >
                  Add transfer line
                </Button>
                <p className="commerce-note">
                  Units and batch tracking must match. Available batches are
                  selected by expiry when goods are dispatched.
                </p>
              </>
            ) : (
              <p>
                {action.row.code} · {action.row.fromName} → {action.row.toName}
              </p>
            )}
            {action.type === "receive" && (
              <>
                {action.row.lines.map((line, index) => (
                  <fieldset key={index}>
                    <legend>
                      {line.targetName} ({line.unit})
                    </legend>
                    {line.lots
                      .filter((lot) => lot.quantity > lot.received)
                      .map((lot) => (
                        <label className="v28-lot" key={lot.key}>
                          <span>
                            {lot.code || "Bulk stock"} · Expires{" "}
                            {lot.expiresOn || "No expiry"} · Remaining{" "}
                            {lot.quantity - lot.received}
                          </span>
                          <input
                            aria-label={
                              "Received quantity " + (index + 1) + " " + lot.key
                            }
                            type="number"
                            min={0}
                            max={lot.quantity - lot.received}
                            step={1}
                            value={counts[index + ":" + lot.key] || ""}
                            onChange={(e) =>
                              setCounts({
                                ...counts,
                                [index + ":" + lot.key]: e.target.value,
                              })
                            }
                          />
                        </label>
                      ))}
                  </fieldset>
                ))}
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={quarantine}
                    onChange={(e) => setQuarantine(e.target.checked)}
                  />
                  Accept expired goods into blocked quarantine for manager
                  review
                </label>
              </>
            )}
            <label>
              Reason
              <input
                aria-label="Stock transfer reason"
                required
                minLength={3}
                maxLength={160}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {action.type === "recovery" && (
              <>
                <p>
                  Only matching source and destination journals can be resumed.
                  Review the physical stock counts in both branches before
                  confirming. This action does not add or remove stock.
                </p>
                <label>
                  Administrator password
                  <input
                    aria-label="Transfer recovery administrator password"
                    required
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </>
            )}
            {["dispatch", "receive", "recovery"].includes(action.type) && (
              <label className="check-line">
                <input
                  aria-label="Transfer physical count verified"
                  type="checkbox"
                  required
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                I physically counted the goods and checked their batch labels.
              </label>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving transfer…" : "Save transfer action"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
