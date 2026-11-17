import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function useResource(path, { enabled = true, interval = 0 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled || busy.current) return;
    const version = generation.current;
    busy.current = true;
    try {
      const next = await api(path);
      if (version !== generation.current) return;
      setData((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
      setError(null);
      return next;
    } catch (failure) {
      if (version === generation.current) setError(failure);
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [path, enabled]);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setLoading(true);
    setData(null);
    setError(null);
    void reload();
    const refresh = () => {
      if (!document.hidden) void reload();
    };
    const timer = interval ? setInterval(refresh, interval) : null;
    document.addEventListener("visibilitychange", refresh);
    return () => {
      generation.current += 1;
      busy.current = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload, interval]);
  return { data, error, loading, reload };
}
