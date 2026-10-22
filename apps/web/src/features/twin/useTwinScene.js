import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../shared/api/client.js";

export const TWIN_DAYS = 7;

export function scenePath({ city, rainfall, attendance, eventLat, eventLng, day }) {
  const params = new URLSearchParams({ city, days: String(TWIN_DAYS), rainfall_mm: String(rainfall) });
  // `day` only selects which horizon day the scenario-scaled queue metric describes.
  if (day > 0) params.set("day", String(day));
  if (attendance > 0) {
    params.set("event_attendance", String(attendance));
    if (eventLat != null && eventLng != null) {
      params.set("event_lat", String(eventLat));
      params.set("event_lng", String(eventLng));
    }
  }
  return `/twin/scene?${params}`;
}

/**
 * Fetch the twin scene for a city + scenario. Scenario edits are debounced;
 * the previous scene stays in `scene` while a refetch is in flight so the map
 * never blanks between scenarios.
 */
export function useTwinScene(request, { debounceMs = 450 } = {}) {
  const url = scenePath(request);
  const [state, setState] = useState({ scene: null, loading: true, error: null, url: null });
  const [attempt, setAttempt] = useState(0);
  const hasScene = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    const timer = setTimeout(
      async () => {
        try {
          const response = await apiFetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const scene = await response.json();
          hasScene.current = true;
          setState({ scene, loading: false, error: null, url });
        } catch (error) {
          if (error.name === "AbortError") return;
          setState((current) => ({ ...current, loading: false, error: error.message || String(error) }));
        }
      },
      hasScene.current ? debounceMs : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, attempt, debounceMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry, settled: !state.loading && state.url === url };
}
