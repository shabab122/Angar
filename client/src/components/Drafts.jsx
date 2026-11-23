import { useState } from "react";
import { useApp } from "../lib/AppContext";
import {
  readStorage,
  saveStorage,
  requestKey,
  dhakaTime,
  api,
} from "../lib/api";
import { branchStorage, currentBranch } from "../lib/branch";
import { safeDraftLines } from "../lib/draft-data";
import { Button, ErrorMessage } from "./UI";
function saved() {
  const rows = readStorage(branchStorage("angar.drafts.v1"), []);
  return Array.isArray(rows)
    ? rows
        .filter(
          (r) =>
            r &&
            typeof r.id === "string" &&
            r.branchId === currentBranch() &&
            safeDraftLines(r.items).length &&
            Date.now() - Date.parse(r.savedAt) < 30 * 86400000,
        )
        .slice(0, 10)
    : [];
}
export function Drafts() {
  const app = useApp(),
    [rows, setRows] = useState(saved),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const persist = (next) => {
    saveStorage(branchStorage("angar.drafts.v1"), next);
    setRows(next);
  };
  function save() {
    setError("");
    const items = safeDraftLines(app.cart);
    if (!items.length) return;
    const row = {
      id: requestKey(),
      branchId: currentBranch(),
      savedAt: new Date().toISOString(),
      items,
      note: typeof app.note === "string" ? app.note.slice(0, 200) : "",
    };
    persist([row, ...saved()].slice(0, 10));
    app.notify(
      app.t(
        "Cart draft saved on this device.",
        "এই ডিভাইসে কার্টের খসড়া সেভ হয়েছে।",
      ),
    );
  }
  async function resume(row) {
    setBusy(true);
    setError("");
    try {
      if (!navigator.onLine) {
        app.replaceCart(safeDraftLines(row.items), row.note || "");
        app.notify(
          "Draft opened offline. Reconnect and review the current menu before ordering.",
        );
        return;
      }
      const { dishes } = await api("/menu");
      await app.reloadMenu();
      await app.reloadContext();
      const missing = safeDraftLines(row.items).some((line) => {
        const dish = dishes.find((d) => d._id === line.dishId);
        return (
          !dish?.available ||
          (line.variantId &&
            !dish.variants?.some((v) => v.id === line.variantId)) ||
          line.addonIds.some((id) => !dish.addons?.some((a) => a.id === id))
        );
      });
      app.replaceCart(safeDraftLines(row.items), row.note || "");
      app.notify(
        missing
          ? "Draft restored. Some items or options are unavailable; update them before checkout."
          : "Draft restored with current menu prices. Review your table and total before ordering.",
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="cart-drafts" aria-label="Saved cart drafts">
      <div className="v27-inline">
        <strong>{app.t("Cart drafts", "কার্টের খসড়া")}</strong>
        <Button
          secondary
          className="button-small"
          disabled={!app.cart.length || busy}
          onClick={save}
        >
          {app.t("Save cart draft", "খসড়া সেভ করুন")}
        </Button>
      </div>
      <p>
        Saved on this device for this branch for 30 days. Prices and table
        visits are checked again online.
      </p>
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {rows.map((row, index) => (
        <div className="draft-row" key={row.id}>
          <span>
            {index + 1}.{" "}
            {safeDraftLines(row.items).reduce((s, l) => s + l.quantity, 0)}{" "}
            portions · {dhakaTime(row.savedAt)}
          </span>
          <Button
            secondary
            className="button-small"
            disabled={busy}
            onClick={() => resume(row)}
          >
            Open draft
          </Button>
          <button
            type="button"
            disabled={busy}
            onClick={() => persist(rows.filter((r) => r.id !== row.id))}
            aria-label={"Delete draft " + (index + 1)}
          >
            Delete
          </button>
        </div>
      ))}
    </section>
  );
}
