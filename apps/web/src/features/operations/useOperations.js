import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../../shared/api/client.js";

const FEED_POLL_MS = 30000;
const DAY_POLL_MS = 60000;

// One polled GET: { data, error, at, reload }. `at` is the time of the last good answer
// (for the offline banner); a failed poll keeps the last good data and sets `error`.
export function usePolled(path, intervalMs) {
  const [state, setState] = useState({ data: null, error: null, at: null });
  const controllerRef = useRef(null);

  const reload = useCallback(() => {
    if (!path) return Promise.resolve();
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return apiGet(path, { signal: controller.signal })
      .then((data) => setState({ data, error: null, at: new Date() }))
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setState((current) => ({ ...current, error }));
      });
  }, [path]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, intervalMs);
    return () => {
      clearInterval(id);
      controllerRef.current?.abort();
    };
  }, [reload, intervalMs]);

  return { ...state, reload };
}

// The Operations page's day data: the needs-you feed, the day recap, today's gate board
// and the modelled normal-day queue (the KPI's fallback when no plan has gate slots).
export function useOperationsData() {
  const feed = usePolled("/ops/needs-you", FEED_POLL_MS);
  const recap = usePolled("/recap/daily", DAY_POLL_MS);
  const gate = usePolled("/gate/slots", DAY_POLL_MS);
  const queue = usePolled("/tpa/queue-status", DAY_POLL_MS * 5);
  return { feed, recap, gate, queue };
}

// "HH:MM" in Jakarta, whatever the browser's zone.
export function jakartaTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm || "")
    .split(":")
    .map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

// The gate slot holding `now` (Jakarta clock), or null.
export function slotAt(slots, now) {
  const at = minutesOfDay(jakartaTime(now));
  return (
    (slots || []).find((slot) => {
      const start = minutesOfDay(slot.start);
      const end = minutesOfDay(slot.end);
      return start != null && end != null && at >= start && at < (end === 0 ? 1440 : end);
    }) || null
  );
}
