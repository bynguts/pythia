import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ClipboardList,
  Cloud,
  CloudOff,
  Hourglass,
  MessageSquareWarning,
  RefreshCw,
} from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { dispatchBody, safetyNote } from "./driverText.js";
import { enqueueDriverOperation, markDriverSynced, OutboxStorageFullError } from "./DriverOutbox.js";
import { clockTime, pendingInstructions, queuedDispatchIds, safetyNotices } from "./driverHelpers.js";

export const SESSION_EXPIRED_EVENT = "pythia-driver-session-expired";

export function announceSessionExpired() {
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

function formatHours(hours, lang) {
  return Number(hours).toLocaleString(lang === "en" ? "en-GB" : "id-ID", { maximumFractionDigits: 1 });
}

// ── Safety (duty hours and gate wait) ─────────────────────────────────────────

const SAFETY_POLL_MS = 60000;

// Polls GET /api/safety/driver/{truck} every 60 s. Any failure (404 before the
// endpoint ships, offline, 401) yields null and the banner hides.
export function useDriverSafety(truckCode) {
  const [safety, setSafety] = useState(null);
  useEffect(() => {
    if (!truckCode) return undefined;
    let cancelled = false;
    const load = () =>
      apiFetch(`/safety/driver/${encodeURIComponent(truckCode)}`, { tokenKey: FIELD_TOKEN_KEY })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const body = await res.json();
          if (!cancelled) setSafety(body && typeof body === "object" ? body : null);
        })
        .catch(() => {
          if (!cancelled) setSafety(null);
        });
    load();
    const id = setInterval(load, SAFETY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [truckCode]);
  return safety;
}

export function SafetyBanner({ safety }) {
  if (safetyNotices(safety).length === 0) return null;
  return (
    <section className="driver-card driver-safety" data-testid="driver-safety" role="alert">
      <SafetyLines safety={safety} />
    </section>
  );
}

// The notice lines and their provenance badge, shared by the banner and the
// Route map's safety pop-over.
export function SafetyLines({ safety }) {
  const { t, lang } = useLanguage();
  const notices = safetyNotices(safety);
  // The backend label is a long English provenance note; the badge says the
  // same in the driver's language, falling back to the label as sent.
  const classification = String(safety?.classification || "");
  const label = classification.startsWith("SIMULATED")
    ? t("drv6_safety_class_simulated")
    : classification === "OBSERVED_APP_EVENTS"
      ? t("drv6_safety_class_observed")
      : safety?.label || classification;
  return (
    <>
      {notices.map((notice) => (
        <p
          key={notice.kind}
          className={`driver-safety-line ${notice.kind}`}
          data-testid={`driver-safety-${notice.kind}`}
        >
          {notice.kind === "gate" ? <Hourglass size={20} /> : <AlertTriangle size={20} />}
          <span>
            {t(`drv6_safety_${notice.kind}`).replace("{h}", formatHours(notice.hours, lang))}
            {notice.kind === "blocked" && notice.override && (
              <small data-testid="driver-safety-override">
                {t("drv6_safety_override").replace("{by}", notice.override.by || "—")}
              </small>
            )}
          </span>
        </p>
      ))}
      {label && (
        <span
          className="driver-provenance-note"
          data-testid="driver-safety-label"
          data-provenance={classification.startsWith("SIMULATED") ? "simulated" : "observed"}
          title={safetyNote(safety, t, lang) || label}
        />
      )}
    </>
  );
}

// ── Dispatcher instructions (audit gap 2) ─────────────────────────────────────

const DISPATCH_POLL_MS = 15000;

function dispatchCacheKey(truckCode) {
  return `pythia_driver_dispatch_${truckCode}`;
}

function readDispatchCache(truckCode) {
  try {
    const list = JSON.parse(localStorage.getItem(dispatchCacheKey(truckCode)) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Polls /dispatch/{truck}. The last live list is kept on this phone, so a
// reload or a dead backend still shows the instructions, labelled as cached
// with their age (X-Pythia-Cached-At from the service worker).
export function useDispatchInstructions(truckCode) {
  const [list, setList] = useState(() => readDispatchCache(truckCode));
  // null while live; otherwise { at } (ISO, may be null when the age is unknown).
  const [cached, setCached] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The driver's latest answer on this phone ({ id, status, at }): the pending list
  // drops it at once, so the tab badge and the empty state agree before the next poll.
  const [lastAnswer, setLastAnswer] = useState(null);
  // When the list last came live from the server (null until the first live read): the
  // message alert counts what is already there on that first read as seen.
  const [liveAt, setLiveAt] = useState(null);

  const settle = useCallback(
    (id, status) => {
      setLastAnswer({ id, status, at: new Date().toISOString() });
      setList((prev) => {
        const next = prev.filter((d) => d.id !== id);
        try {
          localStorage.setItem(dispatchCacheKey(truckCode), JSON.stringify(next));
        } catch {
          // The cache is a convenience; the next live poll rewrites it.
        }
        return next;
      });
    },
    [truckCode],
  );

  const load = useCallback(async () => {
    if (!truckCode) return;
    try {
      const res = await apiFetch(`/dispatch/${encodeURIComponent(truckCode)}`, { tokenKey: FIELD_TOKEN_KEY });
      if (res.status === 401) {
        announceSessionExpired();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const items = Array.isArray(body) ? body : [];
      const isStale = res.headers.get("X-Pythia-Stale") === "1";
      setList(items);
      setLoadFailed(false);
      setCached(isStale ? { at: res.headers.get("X-Pythia-Cached-At") } : null);
      if (!isStale) {
        setLiveAt(Date.now());
        markDriverSynced();
        try {
          localStorage.setItem(dispatchCacheKey(truckCode), JSON.stringify(items));
        } catch {
          // The cache is a convenience; the live list is already on screen.
        }
      }
    } catch {
      // Keep the last known instructions, labelled as cached.
      setLoadFailed(true);
      setCached((prev) => prev || { at: null });
    }
  }, [truckCode]);

  useEffect(() => {
    setList(readDispatchCache(truckCode));
    setCached(null);
    setLastAnswer(null);
    setLiveAt(null);
    load();
    const id = setInterval(load, DISPATCH_POLL_MS);
    // Back online: reload at once instead of showing the offline failure until the next poll.
    window.addEventListener("online", load);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", load);
    };
  }, [truckCode, load]);

  return { list, cached, loadFailed, lastAnswer, liveAt, settle, reload: load };
}

export function cachedAgeMinutes(at) {
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) ? Math.max(0, Math.round((Date.now() - time) / 60000)) : null;
}

// Approved-plan and "send route" instructions. The instruction text comes from
// the backend and is rendered as it arrives; "Siap" is one tap and queues
// offline like every driver write. With `showEmpty` (the Instruksi tab) the
// card also says when there is nothing to do or nothing loaded yet.
export function InstructionCard({ feed, blocked, outboxItems, say, showEmpty = false }) {
  const { t } = useLanguage();
  const { list, cached, loadFailed } = feed;
  const [answered, setAnswered] = useState(() => new Set());
  const [busyId, setBusyId] = useState(null);
  const [reasons, setReasons] = useState({});
  // One operation id per (instruction, answer): repeated taps replace one
  // queued entry instead of adding more, and every replay carries the id the
  // server's replay guard knows.
  const operationIds = useRef(new Map());
  const inFlight = useRef(new Set());

  const hidden = useMemo(() => {
    const ids = queuedDispatchIds(outboxItems);
    answered.forEach((id) => ids.add(id));
    return ids;
  }, [outboxItems, answered]);
  const visible = pendingInstructions(list, hidden);

  const operationIdFor = (dispatchId, status) => {
    const key = `${dispatchId}:${status}`;
    if (!operationIds.current.has(key)) operationIds.current.set(key, newOperationId());
    return operationIds.current.get(key);
  };

  const confirm = async (dispatch, status) => {
    // A second tap while the first is still out does nothing.
    if (inFlight.current.has(dispatch.id)) return;
    inFlight.current.add(dispatch.id);
    setBusyId(dispatch.id);
    const path = `/dispatch/${encodeURIComponent(dispatch.id)}/confirm`;
    const reason = (reasons[dispatch.id] || "").trim();
    const data = {
      status,
      note: status === "READY" ? t("drv6_instr_ready_note") : reason || t("drv6_instr_issue_note"),
      operation_id: operationIdFor(dispatch.id, status),
    };
    try {
      let res;
      try {
        res = await apiFetch(path, { method: "POST", body: data, tokenKey: FIELD_TOKEN_KEY });
      } catch {
        await enqueueDriverOperation({ path, data, label: t("drv6_instr_title") });
        setAnswered((prev) => new Set(prev).add(dispatch.id));
        say(t("drv_queued_offline"));
        return;
      }
      if (res.status === 401) {
        announceSessionExpired();
        say(t("drv6_session_expired"));
        return;
      }
      if (!res.ok) {
        say(t("drv6_request_failed").replace("{code}", res.status));
        return;
      }
      markDriverSynced();
      setAnswered((prev) => new Set(prev).add(dispatch.id));
      say(t("drv6_instr_sent"));
    } catch (error) {
      say(error instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv6_instr_failed"), 8000);
    } finally {
      inFlight.current.delete(dispatch.id);
      setBusyId(null);
    }
  };

  const age = cached ? cachedAgeMinutes(cached.at) : null;
  const cachedBadge = cached && (
    <span className="driver-badge" data-testid="driver-instructions-cached">
      {age === null ? t("drv6_instr_cached") : t("drv10_instr_cached_age").replace("{n}", age)}
    </span>
  );

  if (visible.length === 0) {
    if (!showEmpty) return null;
    const failedEmpty = loadFailed && list.length === 0;
    return (
      <section className="driver-card driver-instructions" data-testid="driver-instructions-empty">
        <div className="driver-card-head">
          <h2>
            <ClipboardList size={18} /> {t("drv6_instr_title")}
          </h2>
          {cachedBadge}
        </div>
        <p className="driver-instruction-empty" role={failedEmpty ? "alert" : undefined}>
          <strong>
            {failedEmpty
              ? navigator.onLine
                ? t("drv10_instr_load_error")
                : t("drv10_instr_offline")
              : t("drv10_instr_empty")}
          </strong>
          {!failedEmpty && <span className="driver-muted">{t("drv10_instr_empty_desc")}</span>}
        </p>
      </section>
    );
  }
  return (
    <section className="driver-card driver-instructions" data-testid="driver-instructions">
      <div className="driver-card-head">
        <h2>
          <ClipboardList size={18} /> {t("drv6_instr_title")}
        </h2>
        {cachedBadge}
      </div>
      <ul className="driver-instruction-list">
        {visible.map((dispatch) => {
          const time = clockTime(dispatch.created_at);
          const reasonId = `instr-reason-${dispatch.id}`;
          return (
            <li key={dispatch.id} data-testid={`driver-instruction-${dispatch.id}`}>
              <span className="driver-badge">
                {dispatch.manager_id === "operations_optimizer"
                  ? t("drv6_instr_plan")
                  : t("drv6_instr_dispatch")}
              </span>
              <p className="driver-instruction-text">{dispatchBody(dispatch, t)}</p>
              {time && <p className="driver-muted">{t("drv6_instr_time").replace("{time}", time)}</p>}
              {blocked && <p className="driver-held">{t("drv6_safety_held")}</p>}
              <label className="driver-label" htmlFor={reasonId}>
                {t("drv10_instr_reason_label")}
              </label>
              <input
                id={reasonId}
                className="driver-input"
                data-testid="driver-instruction-reason"
                value={reasons[dispatch.id] || ""}
                onChange={(e) => setReasons((prev) => ({ ...prev, [dispatch.id]: e.target.value }))}
                placeholder={t("drv10_instr_reason_placeholder")}
              />
              <div className="driver-actions">
                <button
                  type="button"
                  className="driver-btn primary"
                  data-testid="driver-instruction-ready"
                  disabled={blocked || busyId === dispatch.id}
                  onClick={() => confirm(dispatch, "READY")}
                >
                  {t("drv6_instr_ready")}
                </button>
                <button
                  type="button"
                  className="driver-btn ghost"
                  data-testid="driver-instruction-issue"
                  disabled={busyId === dispatch.id}
                  onClick={() => confirm(dispatch, "ISSUE")}
                >
                  <MessageSquareWarning size={18} /> {t("drv6_instr_issue")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Open instructions for the tab badge (the card's own filter).
export function openInstructionCount(list, outboxItems) {
  return pendingInstructions(list, queuedDispatchIds(outboxItems)).length;
}

// ── Sync status and rejected work (R3, audit gap 9) ───────────────────────────

// `onRetry` (the old /field "sync now"): the queue also retries on its own
// every 10 s and on reconnect; the button lets a driver who sees a bar of
// signal try at once.
export function SyncStatus({ lastSync, pending, flushing, online, onRetry }) {
  const { t } = useLanguage();
  const time = clockTime(lastSync);
  return (
    <section className="driver-sync" data-testid="driver-sync-status" role="status">
      {online ? <RefreshCw size={16} /> : <CloudOff size={16} />}
      <span data-testid="driver-last-sync">
        {time ? t("drv6_last_sync").replace("{time}", time) : t("drv6_never_synced")}
      </span>
      <span className={pending > 0 ? "driver-sync-pending" : ""} data-testid="driver-pending-count">
        {flushing
          ? t("drv_syncing")
          : pending > 0
            ? t("drv6_pending_n").replace("{n}", pending)
            : t("drv6_all_sent")}
      </span>
      {onRetry && pending > 0 && !flushing && (
        <button
          type="button"
          className="driver-btn ghost driver-sync-now"
          data-testid="driver-sync-now"
          onClick={onRetry}
        >
          {t("drv10_sync_now")}
        </button>
      )}
    </section>
  );
}

// The header chip of the trip screens. "Synced" only when nothing is
// waiting and the phone is online; otherwise it says what is held on the phone.
export function SyncChip({ online, pending = 0, flushing = false }) {
  const { t } = useLanguage();
  const offline = !online;
  const state = offline ? "offline" : flushing ? "sending" : pending > 0 ? "pending" : "synced";
  const label = {
    offline: pending > 0 ? t("d2_sync_offline_n").replace("{n}", pending) : t("d2_sync_offline"),
    sending: t("drv_syncing"),
    pending: t("d2_sync_pending_n").replace("{n}", pending),
    synced: t("d2_sync_synced"),
  }[state];
  return (
    <span
      className={`drt-sync${offline ? " is-offline" : state === "synced" ? "" : " is-pending"}`}
      data-testid="drt-sync"
      data-sync={state}
      role="status"
    >
      {offline ? <CloudOff size={14} aria-hidden="true" /> : <Cloud size={14} aria-hidden="true" />}
      {label}
    </span>
  );
}

export function NeedsActionList({ items, onDismiss }) {
  const { t } = useLanguage();
  if (!items || items.length === 0) return null;
  return (
    <section className="driver-card driver-needs-action" data-testid="driver-needs-action" role="alert">
      <h2>
        <AlertTriangle size={18} /> {t("drv6_needs_action_title")}
      </h2>
      <p className="driver-muted">{t("drv6_needs_action_desc")}</p>
      <ul className="driver-rejected-list">
        {items.map((item) => (
          <li key={item.op_id} data-testid="driver-rejected-item">
            <span>
              <strong>{item.label}</strong>
              <small>
                {item.reason === "photo_missing"
                  ? t("drv6_reason_photo_missing")
                  : t("drv6_reason_status").replace("{code}", item.status)}
                {item.detail ? ` · ${item.detail}` : ""}
              </small>
            </span>
            <button type="button" className="driver-btn ghost" onClick={() => onDismiss(item.op_id)}>
              {t("drv6_dismiss")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
