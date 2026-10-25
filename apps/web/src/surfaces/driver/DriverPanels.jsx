import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ClipboardList,
  CloudOff,
  Hourglass,
  MessageSquareWarning,
  RefreshCw,
} from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
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
  const { t, lang } = useLanguage();
  const notices = safetyNotices(safety);
  if (notices.length === 0) return null;
  // The backend label is a long English provenance note; the badge says the
  // same in the driver's language, falling back to the label as sent.
  const classification = String(safety.classification || "");
  const label = classification.startsWith("SIMULATED")
    ? t("drv6_safety_class_simulated")
    : classification === "OBSERVED_APP_EVENTS"
      ? t("drv6_safety_class_observed")
      : safety.label || classification;
  return (
    <section className="driver-card driver-safety" data-testid="driver-safety" role="alert">
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
          className="driver-badge driver-provenance"
          data-testid="driver-safety-label"
          title={safety.label || undefined}
        >
          {label}
        </span>
      )}
    </section>
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

// Polls /dispatch/{truck} and shows approved-plan and "send route"
// instructions. The instruction text comes from the backend and is rendered
// as it arrives; "Siap" is one tap and queues offline like every driver write.
export function InstructionCard({ truckCode, blocked, outboxItems, say }) {
  const { t } = useLanguage();
  const [list, setList] = useState(() => readDispatchCache(truckCode));
  const [stale, setStale] = useState(false);
  const [answered, setAnswered] = useState(() => new Set());
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/dispatch/${encodeURIComponent(truckCode)}`, { tokenKey: FIELD_TOKEN_KEY });
      if (res.status === 401) {
        announceSessionExpired();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const isStale = res.headers.get("X-Pythia-Stale") === "1";
      setList(Array.isArray(body) ? body : []);
      setStale(isStale);
      if (!isStale) {
        markDriverSynced();
        try {
          localStorage.setItem(dispatchCacheKey(truckCode), JSON.stringify(Array.isArray(body) ? body : []));
        } catch {
          // The cache is a convenience; the live list is already on screen.
        }
      }
    } catch {
      setStale(true); // Keep the last known instructions, labelled as cached.
    }
  }, [truckCode]);

  useEffect(() => {
    setList(readDispatchCache(truckCode));
    load();
    const id = setInterval(load, DISPATCH_POLL_MS);
    return () => clearInterval(id);
  }, [truckCode, load]);

  const hidden = useMemo(() => {
    const ids = queuedDispatchIds(outboxItems);
    answered.forEach((id) => ids.add(id));
    return ids;
  }, [outboxItems, answered]);
  const visible = pendingInstructions(list, hidden);

  const confirm = async (dispatch, status) => {
    setBusyId(dispatch.id);
    const path = `/dispatch/${encodeURIComponent(dispatch.id)}/confirm`;
    const data = {
      status,
      note: status === "READY" ? t("drv6_instr_ready_note") : t("drv6_instr_issue_note"),
      operation_id: newOperationId(),
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
      setBusyId(null);
    }
  };

  if (visible.length === 0) return null;
  return (
    <section className="driver-card driver-instructions" data-testid="driver-instructions">
      <div className="driver-card-head">
        <h2>
          <ClipboardList size={18} /> {t("drv6_instr_title")}
        </h2>
        {stale && <span className="driver-badge">{t("drv6_instr_cached")}</span>}
      </div>
      <ul className="driver-instruction-list">
        {visible.map((dispatch) => {
          const time = clockTime(dispatch.created_at);
          return (
            <li key={dispatch.id} data-testid={`driver-instruction-${dispatch.id}`}>
              <span className="driver-badge">
                {dispatch.manager_id === "operations_optimizer"
                  ? t("drv6_instr_plan")
                  : t("drv6_instr_dispatch")}
              </span>
              <p className="driver-instruction-text">{dispatch.instruction}</p>
              {time && <p className="driver-muted">{t("drv6_instr_time").replace("{time}", time)}</p>}
              {blocked && <p className="driver-held">{t("drv6_safety_held")}</p>}
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

// ── Sync status and rejected work (R3, audit gap 9) ───────────────────────────

export function SyncStatus({ lastSync, pending, flushing, online }) {
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
    </section>
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
