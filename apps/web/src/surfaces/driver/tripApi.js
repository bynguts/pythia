// Shared plumbing of the driver trip screens (route, stop proof, TPA, weigh
// ticket): the queue-aware POST, photo shrinking with translated errors, and
// the arrival geotag. Moved out of DriverApp.jsx unchanged in behaviour.
import { useEffect, useMemo, useState } from "react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { apiErrorText, responseError } from "../../shared/api/errorText.js";
import { translate } from "../../shared/i18n/index.jsx";
import { markDriverSynced } from "./DriverOutbox.js";
import { announceSessionExpired } from "./DriverPanels.jsx";
import { shrinkPhoto } from "./photo.js";

const PHOTO_ERROR_KEYS = {
  photo_too_big: "drv6_photo_too_big",
  photo_unreadable: "drv6_photo_unreadable",
  photo_read_failed: "drv_photo_read_failed",
};

// The provider keeps <html lang> in step with the chosen language (English default).
export function currentLang() {
  return document.documentElement.lang === "id" ? "id" : "en";
}

// Audit gap 1: every evidence photo is shrunk on the phone (longest side
// 1280 px, JPEG 0.7) before it is queued or uploaded; the size is shown.
export async function readPhoto(file) {
  try {
    return await shrinkPhoto(file);
  } catch (err) {
    throw new Error(translate(currentLang(), PHOTO_ERROR_KEYS[err?.code] || "drv_photo_read_failed"));
  }
}

// H1: a failed or missing GPS fix falls back to the stop's own coordinates,
// flagged approx, and the screen says so; it is never shown as GPS.
export function getPosition(stop) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ lat: stop.lat, lng: stop.lng, approx: true });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        }),
      () => resolve({ lat: stop.lat, lng: stop.lng, approx: true }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

// #45: a network-level failure (fetch rejected / no response) is queueable;
// an HTTP error response is a permanent failure the driver must act on. The
// message comes from the catalog, never the raw server detail alone; a 401
// means the backend no longer knows this session.
export async function post(path, data) {
  const res = await apiFetch(path, { method: "POST", body: data, tokenKey: FIELD_TOKEN_KEY });
  if (!res.ok) {
    const lang = currentLang();
    if (res.status === 401) {
      announceSessionExpired();
      const expired = new Error(translate(lang, "drv6_session_expired"));
      expired.status = 401;
      throw expired;
    }
    const body = await res.json().catch(() => ({}));
    const base = translate(lang, "drv6_request_failed").replace("{code}", res.status);
    // Backend detail is English: a coded refusal is translated, plain text shows in English only.
    const reason = apiErrorText(lang, responseError(res.status, body), "");
    const error = new Error(reason ? `${base}: ${reason}` : base);
    error.status = res.status;
    throw error;
  }
  markDriverSynced();
  return res.json();
}

// #45: post() variant whose failures carry a `network` flag so callers can
// route them to the durable outbox instead of surfacing a dead error.
export async function postQueueable(path, data) {
  try {
    return await post(path, data);
  } catch (err) {
    // post() only throws with a parsed message for HTTP responses; a raw
    // TypeError comes from fetch itself (offline / unreachable backend).
    if (err instanceof TypeError || !err.message) {
      const wrapped = new Error(err.message || "network");
      wrapped.network = true;
      throw wrapped;
    }
    throw err;
  }
}

function hasCoord(p) {
  return (
    p && p.lat !== null && p.lng !== null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
  );
}

export function haversineKm(a, b) {
  if (!hasCoord(a) || !hasCoord(b)) return null;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// The backend's straight-line fallback (app/fleet/osrm.py): 22 km/h, never
// under 8 min. Labelled as an estimate wherever it is shown, never as a road ETA.
const FALLBACK_SPEED_KMH = 22;
const FALLBACK_MIN_MINUTES = 8;

export function straightLineEta(from, to) {
  const km = haversineKm(from, to);
  if (km === null) return null;
  return {
    km,
    minutes: Math.max(FALLBACK_MIN_MINUTES, Math.round((km / FALLBACK_SPEED_KMH) * 60)),
    source: "fallback_estimate",
  };
}

// GET /driver/trip/{truck}: road ETA from the phone's own position,
// the gate slot, the plan's tons per stop, the modelled gate queue and the
// dispatch phone. Each figure keeps its source; a missing one stays null and
// the screens fall back to their labelled estimates. The position is rounded
// to ~100 m before it leaves the phone, and a payload older than
// TRIP_STALE_MS (offline) no longer gives drive times.
const TRIP_POLL_MS = 60000;
const TRIP_STALE_MS = 5 * 60000;
const NO_TRIP = Object.freeze({
  stopEta: null,
  tpaEta: null,
  gateSlot: null,
  stopTons: {},
  queue: null,
  dispatchTel: null,
});

function driveFrom(leg, extra = {}) {
  if (!leg || !Number.isFinite(leg.eta_minutes)) return null;
  return {
    minutes: leg.eta_minutes,
    km: Number.isFinite(leg.distance_km) ? leg.distance_km : null,
    source: leg.eta_source || "fallback_estimate",
    ...extra,
  };
}

function mapTrip(body, fresh) {
  if (!body) return NO_TRIP;
  const stopTons = {};
  for (const stop of body.stops || []) {
    if (Number.isFinite(stop?.expected_tons)) stopTons[stop.index] = stop.expected_tons;
  }
  const slot = body.gate_slot;
  const queue = body.queue_ahead;
  return {
    stopEta: fresh ? driveFrom(body.next_stop, { index: body.next_stop?.index }) : null,
    tpaEta: fresh ? driveFrom(body.to_tpa) : null,
    gateSlot: slot?.start
      ? {
          start: slot.start,
          end: slot.end || null,
          // "HH:MM", or "YYYY-MM-DD HH:MM" when the departure is the day before.
          departAt: slot.depart_at ? String(slot.depart_at).split(" ").pop() : null,
          classification: slot.classification || null,
        }
      : null,
    stopTons,
    queue: queue?.slots?.length ? { slots: queue.slots, classification: queue.classification } : null,
    dispatchTel: body.dispatch_contact?.tel || null,
  };
}

function roundedPosition(position) {
  return hasCoord(position) ? `${Number(position.lat).toFixed(3)},${Number(position.lng).toFixed(3)}` : "";
}

export function useDriverTrip(truckCode, position) {
  const [state, setState] = useState({ body: null, at: 0 });
  const [now, setNow] = useState(() => Date.now());
  const where = roundedPosition(position);
  useEffect(() => {
    if (!truckCode) return undefined;
    let cancelled = false;
    const load = async () => {
      const query = where ? `?lat=${where.split(",")[0]}&lng=${where.split(",")[1]}` : "";
      try {
        const res = await apiFetch(`/driver/trip/${encodeURIComponent(truckCode)}${query}`, {
          tokenKey: FIELD_TOKEN_KEY,
        });
        if (cancelled) return;
        // An older backend (404) or a refused truck: the labelled fallbacks stay.
        setState(res.ok ? { body: await res.json(), at: Date.now() } : { body: null, at: 0 });
      } catch {
        // Offline: keep the last payload; its drive times expire below.
      }
      if (!cancelled) setNow(Date.now());
    };
    load();
    const id = setInterval(load, TRIP_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [truckCode, where]);
  const fresh = state.at > 0 && now - state.at < TRIP_STALE_MS;
  return useMemo(() => mapTrip(state.body, fresh), [state.body, fresh]);
}

// Hover/screen-reader wording per eta_source; a road ETA is never worded as a
// straight-line guess and vice versa.
export function etaLabelKey(source) {
  if (source === "osrm_duration") return "d2_eta_road_label";
  if (source === "simulated") return "d2_eta_simulated_label";
  return "d2_eta_fallback_label";
}

export { hasCoord };
