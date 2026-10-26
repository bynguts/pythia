import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../../shared/api/client.js";

// One GET that refreshes on an interval. `data` keeps the last good body; `failed` is true while the
// newest attempt failed (so a screen can say "not available" without throwing away what it showed).
export function useApi(path, { pollMs = 30000, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);

  const reload = useCallback(
    async (signal) => {
      try {
        const body = await apiGet(path, { signal });
        if (!alive.current) return;
        setData(body);
        setFailed(false);
      } catch (error) {
        if (error?.name !== "AbortError" && alive.current) setFailed(true);
      } finally {
        if (alive.current) setLoaded(true);
      }
    },
    [path],
  );

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    const controller = new AbortController();
    reload(controller.signal);
    const id = pollMs ? setInterval(() => reload(controller.signal), pollMs) : null;
    return () => {
      alive.current = false;
      controller.abort();
      if (id) clearInterval(id);
    };
  }, [reload, pollMs, enabled]);

  return { data, failed, loaded, reload: () => reload() };
}
