import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../shared/api/client.js";

/**
 * "Put this on the table": the twin leads a shared XR session (the public
 * /api/xr/session store the /xr tabletop already uses). Once started, every
 * change of city, rain, event, venue, day or selection on the twin is written
 * to the session, and each joined /xr device follows it by polling. The twin
 * reads the session back only for the table's presence count, the agreement
 * note (kept while the what-if is unchanged) and a district a phone pointed at.
 * The code survives a reload of this tab (sessionStorage), so phones stay joined.
 */

// Same alphabet as the tabletop: no 0/O or 1/I, so a code read aloud is unambiguous.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-Z0-9]{4,8}$/;
const STORE_KEY = "pythia_table_session";
// Slider drags and timeline playback settle before a write goes out.
const PUSH_DEBOUNCE_MS = 250;
// Presence count refresh (the server counts a device for 10 s after its heartbeat).
const POLL_MS = 2000;

export function makeTableCode(length = 6) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** "N devices on the table" in the UI language; `fmt` formats the count. */
export function tablePresenceText(t, count, fmt = String) {
  if (!count) return t("ho_presence_none");
  return count === 1 ? t("ho_presence_one") : t("ho_presence_many").replace("{n}", fmt(count));
}

function storedCode() {
  try {
    const code = sessionStorage.getItem(STORE_KEY) || "";
    return CODE_PATTERN.test(code) ? code : null;
  } catch {
    return null;
  }
}

function storeCode(code) {
  try {
    if (code) sessionStorage.setItem(STORE_KEY, code);
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Private mode: the session simply does not survive a reload.
  }
}

// What a table agreement was about; any change to it withdraws the agreement.
const whatIfKey = (s) =>
  s
    ? [s.city, Number(s.rainfall_mm), s.event_preset, s.venue_id, s.scenario_day, s.scenario_id || ""].join(
        "|",
      )
    : "";

/**
 * `state`: the twin's scenario in the session's shape
 * ({ city, rainfall_mm, event_preset, venue_id, day, scenario_day, selected_id, scenario_id }).
 * Returns { code, status: "idle"|"starting"|"live"|"error", participants, start, stop }.
 */
export function useTableSession(state) {
  const [code, setCode] = useState(storedCode);
  const [status, setStatus] = useState(() => (storedCode() ? "live" : "idle"));
  const [participants, setParticipants] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Newest session state the server returned, and the twin state last written.
  const serverRef = useRef(null);
  const pushedRef = useRef(null);
  const tailRef = useRef(Promise.resolve(true));
  const seqRef = useRef(0);
  // Bumped by stop(): a write still in flight then reports nothing.
  const genRef = useRef(0);

  const write = useCallback(async (target, seq) => {
    if (seq !== seqRef.current) return true; // a newer write carries the whole scenario
    const gen = genRef.current;
    const twin = stateRef.current;
    const server = serverRef.current;
    const lastPushed = pushedRef.current;
    const selectedMoved = !lastPushed || lastPushed.selected_id !== twin.selected_id;
    const body = {
      city: twin.city,
      rainfall_mm: twin.rainfall_mm,
      event_preset: twin.event_preset,
      venue_id: twin.venue_id || null,
      day: twin.day,
      scenario_day: twin.scenario_day,
      // The briefing scenario on the table: an agreement on it reaches Rencana as a note.
      scenario_id: twin.scenario_id || null,
      // An agreement at the table stands only for the what-if it was made on.
      agreed: Boolean(server?.agreed) && whatIfKey(server) === whatIfKey(twin),
      // The twin's pick wins when it changed; otherwise keep the one a phone made.
      selected_id: selectedMoved
        ? twin.selected_id || null
        : server?.city === twin.city
          ? server?.selected_id || null
          : null,
    };
    try {
      const res = await apiFetch(`/xr/session/${target}`, { method: "PUT", auth: false, body });
      if (!res.ok) throw new Error(String(res.status));
      const saved = await res.json();
      if (gen !== genRef.current) return false;
      serverRef.current = saved;
      pushedRef.current = { ...twin };
      if (Number.isInteger(serverRef.current.participants)) setParticipants(serverRef.current.participants);
      setStatus("live");
      return true;
    } catch {
      if (gen === genRef.current) setStatus("error");
      return false;
    }
  }, []);

  // Writes are serialized: one PUT in flight, and a queued one that a newer
  // change overtook is skipped, so the session never ends on an older scenario.
  const push = useCallback(
    (target) => {
      seqRef.current += 1;
      const seq = seqRef.current;
      const run = tailRef.current.then(() => write(target, seq));
      tailRef.current = run;
      return run;
    },
    [write],
  );

  const startingRef = useRef(false);
  const start = useCallback(async () => {
    if (code) return push(code);
    if (startingRef.current) return false;
    startingRef.current = true;
    const next = makeTableCode();
    setStatus("starting");
    serverRef.current = null;
    pushedRef.current = null;
    const ok = await push(next);
    startingRef.current = false;
    if (ok) {
      storeCode(next);
      setCode(next);
    }
    return ok;
  }, [code, push]);

  const stop = useCallback(() => {
    seqRef.current += 1;
    genRef.current += 1;
    storeCode(null);
    setCode(null);
    setStatus("idle");
    setParticipants(0);
    serverRef.current = null;
    pushedRef.current = null;
  }, []);

  // Twin change → the session (debounced). Also the first write after a reload.
  const key = JSON.stringify(state);
  useEffect(() => {
    if (!code) return undefined;
    const timer = setTimeout(() => push(code), PUSH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [code, key, push]);

  // The session → the presence count (and what the table agreed or pointed at).
  useEffect(() => {
    if (!code) return undefined;
    let alive = true;
    let timer = null;
    let inFlight = false;
    const hidden = () => document.visibilityState === "hidden";
    async function poll() {
      timer = null;
      inFlight = true;
      try {
        const res = await apiFetch(`/xr/session/${code}`, { auth: false });
        if (!alive) return;
        if (res.status === 404) {
          // Expired on the server (12 h idle): write the twin's scenario again under the same code.
          push(code);
        } else if (res.ok) {
          const body = await res.json();
          if (!alive) return;
          serverRef.current = body;
          if (Number.isInteger(body.participants)) setParticipants(body.participants);
        }
      } catch {
        // A missed poll only delays the count; writes report their own errors.
      } finally {
        inFlight = false;
        if (alive && !hidden()) timer = setTimeout(poll, POLL_MS);
      }
    }
    const onVisibility = () => {
      if (!hidden() && !timer && !inFlight) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [code, push]);

  return { code, status, participants, start, stop };
}
