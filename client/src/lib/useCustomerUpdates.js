import { useEffect, useState } from "react";
import { useApp } from "./AppContext";
import { currentBranch } from "./branch";
export function useCustomerUpdates() {
  const { customer, reloadCustomer } = useApp(),
    [status, setStatus] = useState("connecting"),
    [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!window.EventSource) {
      setStatus("fallback");
      return;
    }
    const stream = new EventSource(
      "/api/customer/live?branch=" + encodeURIComponent(currentBranch()),
    );
    let active = true;
    const refresh = () => {
      if (active)
        window.dispatchEvent(
          new CustomEvent("angar:refresh", {
            detail: { topics: ["customer"] },
          }),
        );
    };
    stream.addEventListener("ready", (event) => {
      try {
        setStatus(
          JSON.parse(event.data).connected ? "connected" : "connecting",
        );
      } catch {
        setStatus("connecting");
      }
      refresh();
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
      setStatus("reconnecting");
      void reloadCustomer()
        .catch(() => {})
        .finally(() => setEpoch((value) => value + 1));
      refresh();
    });
    stream.onerror = () =>
      setStatus(navigator.onLine ? "reconnecting" : "offline");
    return () => {
      active = false;
      stream.close();
    };
  }, [customer?.id, customer?.identityRevision, epoch, reloadCustomer]);
  return status;
}
