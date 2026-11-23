import { useEffect, useState } from "react";
import { currentBranch } from "./branch";
export function useLiveUpdates({ enabled = true, onAccessChanged } = {}) {
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    if (!enabled) {
      setStatus("paused");
      return;
    }
    if (!window.EventSource) {
      setStatus("fallback");
      return;
    }
    const stream = new EventSource(
      "/api/staff/live?branch=" + encodeURIComponent(currentBranch()),
    );
    let alive = true;
    const refresh = (event) => {
      if (alive) {
        let value = { topics: [] };
        try {
          value = JSON.parse(event.data);
        } catch {}
        window.dispatchEvent(
          new CustomEvent("angar:refresh", { detail: value }),
        );
      }
    };
    stream.addEventListener("ready", (event) => {
      setStatus("connected");
      refresh(event);
    });
    stream.addEventListener("refresh", refresh);
    stream.addEventListener("state", (event) => {
      try {
        setStatus(
          JSON.parse(event.data).state === "connected"
            ? "connected"
            : "fallback",
        );
      } catch {
        setStatus("fallback");
      }
    });
    stream.addEventListener("access", () => {
      stream.close();
      setStatus("access-changed");
      onAccessChanged?.();
    });
    stream.onerror = () =>
      setStatus(navigator.onLine ? "reconnecting" : "offline");
    return () => {
      alive = false;
      stream.close();
    };
  }, [enabled, onAccessChanged]);
  return status;
}
