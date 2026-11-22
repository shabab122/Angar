import { useState } from "react";
import { api, dhakaTime, requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { useApp } from "../lib/AppContext";
import { Button, ErrorMessage, Loading, Modal } from "../components/UI";
export default function StocktakesPanel({ user }) {
  const { notify } = useApp(),
    list = useResource("/staff/stocktakes", { interval: 10000 }),
    inventory = useResource("/staff/inventory");
  const [selected, setSelected] = useState(""),
    record = useResource("/staff/stocktakes/" + selected, {
      enabled: !!selected,
      interval: 5000,
    });
  const [action, setAction] = useState(null),
    [values, setValues] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const row = record.data?.stocktake,
    admin = user.role === "admin";
  function open(type, item) {
    setError("");
    setAction({ type, item, key: requestKey(), revision: row?.revision });
    setValues({
      reason: "",
      selected: [],
      counted: item?.counted === null ? "" : String(item?.counted ?? ""),
      batches:
        item?.batches?.map((b) => ({
          ...b,
          counted: b.counted === undefined ? "" : String(b.counted),
        })) || [],
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let path = "/staff/stocktakes",
        data;
      if (action.type === "create")
        data = {
          ingredientIds: values.selected,
          reason: values.reason,
          requestKey: action.key,
        };
      else {
        path +=
          "/" +
          row.id +
          "/" +
          (action.type === "count"
            ? "count"
            : action.type === "refresh"
              ? "refresh"
              : action.type === "submit"
                ? "submit"
                : "decision");
        data = {
          expectedRevision: action.revision,
          ...(["count", "refresh"].includes(action.type)
            ? { ingredientId: action.item.ingredientId }
            : {}),
          ...(action.type === "count"
            ? action.item.batchTracked
              ? {
                  batches: values.batches.map((b) => ({
                    batchId: b.id,
                    counted: Number(b.counted),
                  })),
                }
              : { counted: Number(values.counted) }
            : action.type === "submit"
              ? {}
              : action.type === "refresh"
                ? { reason: values.reason }
                : {
                    decision: action.type,
                    reason: values.reason,
                    requestKey: action.key,
                  }),
        };
      }
      const result = await api(path, { method: "POST", data });
      if (action.type === "create") setSelected(result.stocktake.id);
      setAction(null);
      await list.reload();
      await record.reload();
      notify("Stock count updated.");
    } catch (f) {
      setError(f.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="v26-panel">
      <div className="panel-heading">
        <div>
          <h2>Physical stock counts</h2>
          <p>
            Count available, unallocated stock. An administrator reviews
            differences before stock changes. New stock activity requires a
            fresh snapshot and recount.
          </p>
        </div>
        <Button onClick={() => open("create")}>Start stock count</Button>
      </div>
      {list.error && (
        <ErrorMessage onRetry={list.reload}>{list.error.message}</ErrorMessage>
      )}
      <div className="commerce-staff-grid">
        {list.data?.stocktakes.map((r) => (
          <article className="commerce-card" key={r.id}>
            <h3>{r.code}</h3>
            <p className="management-status">{r.status}</p>
            <p className="commerce-note">
              {dhakaTime(r.createdAt)} · {r.createdBy}
            </p>
            <p>{r.reason}</p>
            <Button secondary onClick={() => setSelected(r.id)}>
              Open stock count {r.code}
            </Button>
          </article>
        ))}
      </div>
      {list.loading && <Loading />}
      {!list.loading && !list.data?.stocktakes.length && (
        <p>No stock counts yet.</p>
      )}
      {selected && (
        <article className="commerce-card v26-record">
          <div className="commerce-section-heading">
            <h3>Count record</h3>
            <Button secondary onClick={() => setSelected("")}>
              Close count record
            </Button>
          </div>
          {record.error ? (
            <ErrorMessage onRetry={record.reload}>
              {record.error.message}
            </ErrorMessage>
          ) : !row ? (
            <Loading />
          ) : (
            <>
              <h3>
                {row.code} · {row.status}
              </h3>
              <p className="commerce-note">
                The snapshot excludes stock already reserved for orders. Count
                every recorded lot, including expired or quarantined stock.
                Receive an unrecorded lot through the stock receipt form first.
              </p>
              <div className="commerce-table-scroll">
                <table className="v25-table">
                  <thead>
                    <tr>
                      <th>Ingredient</th>
                      <th>Expected</th>
                      <th>Counted / difference</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.items.map((item) => (
                      <tr key={item.ingredientId}>
                        <td>
                          {item.name}
                          <small>
                            {item.batchTracked
                              ? "Count each lot"
                              : "Whole base units"}
                          </small>
                        </td>
                        <td>
                          {item.expected} {item.unit}
                        </td>
                        <td>
                          {item.counted === null
                            ? "Not counted"
                            : item.counted +
                              " " +
                              item.unit +
                              " / " +
                              (item.counted - item.expected)}
                          {item.countedBy && (
                            <small>Counted by {item.countedBy}</small>
                          )}
                        </td>
                        <td>
                          <div className="commerce-inline-actions">
                            {row.status === "counting" && (
                              <Button
                                secondary
                                className="button-small"
                                onClick={() => open("count", item)}
                              >
                                Count {item.name}
                              </Button>
                            )}
                            {["counting", "submitted"].includes(row.status) && (
                              <Button
                                secondary
                                className="button-small"
                                onClick={() => open("refresh", item)}
                              >
                                Refresh & recount {item.name}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="commerce-inline-actions">
                {row.status === "counting" && (
                  <Button
                    disabled={row.items.some((i) => i.counted === null)}
                    onClick={() => open("submit")}
                  >
                    Submit count for review
                  </Button>
                )}
                {admin && row.status === "submitted" && (
                  <>
                    <Button onClick={() => open("approve")}>
                      Approve stock differences
                    </Button>
                    <Button secondary onClick={() => open("reject")}>
                      Reject stock count
                    </Button>
                  </>
                )}
              </div>
              {row.reviewReason && (
                <p>
                  Reviewed by {row.reviewedBy}: {row.reviewReason}
                </p>
              )}
            </>
          )}
        </article>
      )}
      {action && (
        <Modal
          open
          title={
            action.type === "create"
              ? "Start physical stock count"
              : action.type === "count"
                ? "Record physical quantity"
                : action.type === "refresh"
                  ? "Refresh snapshot & recount"
                  : action.type === "submit"
                    ? "Submit count for review"
                    : action.type === "approve"
                      ? "Approve stock differences"
                      : "Reject stock count"
          }
          onClose={() => {
            if (!busy) setAction(null);
          }}
          className="management-dialog"
        >
          <form className="commerce-form" onSubmit={submit}>
            {action.type === "create" && (
              <>
                <p>
                  Select up to 30 ingredients. Quantities must exclude stock
                  already reserved for orders.
                </p>
                <div className="v26-checkbox-list">
                  {inventory.data?.ingredients.map((i) => (
                    <label className="commerce-checkbox" key={i.id}>
                      <input
                        type="checkbox"
                        checked={values.selected.includes(i.id)}
                        onChange={(e) =>
                          setValues({
                            ...values,
                            selected: e.target.checked
                              ? [...values.selected, i.id]
                              : values.selected.filter((id) => id !== i.id),
                          })
                        }
                      />
                      <span>
                        {i.name} · {i.stock} {i.unit}
                      </span>
                    </label>
                  ))}
                </div>
                {inventory.error && (
                  <ErrorMessage>{inventory.error.message}</ErrorMessage>
                )}
              </>
            )}
            {action.type === "count" && (
              <>
                <h3>{action.item.name}</h3>
                {action.item.batchTracked ? (
                  values.batches.map((b, index) => (
                    <label key={b.id}>
                      {b.code} · expected {b.expected} {action.item.unit}
                      <input
                        aria-label={"Physical batch count " + b.code}
                        type="number"
                        min="0"
                        max="1000000000"
                        step="1"
                        required
                        value={b.counted}
                        onChange={(e) =>
                          setValues({
                            ...values,
                            batches: values.batches.map((r, p) =>
                              p === index
                                ? { ...r, counted: e.target.value }
                                : r,
                            ),
                          })
                        }
                      />
                    </label>
                  ))
                ) : (
                  <label>
                    Available stock counted ({action.item.unit})
                    <input
                      aria-label="Physical quantity counted"
                      type="number"
                      min="0"
                      max="1000000000"
                      step="1"
                      required
                      value={values.counted}
                      onChange={(e) =>
                        setValues({ ...values, counted: e.target.value })
                      }
                    />
                  </label>
                )}
              </>
            )}
            {action.type === "refresh" && (
              <p>
                This replaces the snapshot for {action.item.name}, clears its
                old count and returns the record to counting. Physically count
                again after stock activity settles.
              </p>
            )}
            {action.type === "submit" && (
              <p>
                Every ingredient has a recorded count. Submit these differences
                for administrator review; stock changes only after approval.
              </p>
            )}
            {action.type === "approve" && (
              <p>
                Review each difference against the physical count. Approval
                applies all differences together; a stale snapshot prevents the
                entire adjustment.
              </p>
            )}
            {!["count", "submit"].includes(action.type) && (
              <label>
                Reason
                <textarea
                  aria-label="Stock count reason"
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
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button
              type="submit"
              disabled={
                busy ||
                (action.type === "create" &&
                  (!values.selected.length || values.selected.length > 30))
              }
            >
              {" "}
              {action.type === "create"
                ? "Create count snapshot"
                : action.type === "count"
                  ? "Save physical count"
                  : action.type === "refresh"
                    ? "Replace snapshot for recount"
                    : action.type === "submit"
                      ? "Submit verified counts"
                      : action.type === "approve"
                        ? "Confirm stock approval"
                        : "Confirm rejection"}
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}
