import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CircleCheck,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  CloudOff,
  Flag,
  Info,
  LockKeyhole,
  LogIn,
  MessageSquareWarning,
  OctagonPause,
  RefreshCw,
  Route,
  Scale,
  Search,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Truck,
  Warehouse,
} from "lucide-react";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { formatDriverName } from "../../shared/format/driverName.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Mascot } from "../../shared/ui/Mascot.jsx";
import { enqueueDriverOperation, markDriverSynced, OutboxStorageFullError } from "./DriverOutbox.js";
import { announceSessionExpired, cachedAgeMinutes } from "./DriverPanels.jsx";
import { matchTrucks, readRecentTrucks } from "./TruckPicker.jsx";
import {
  clockTime,
  departHeadline,
  instructionSlotFromText,
  pendingInstructions,
  pretripSummary,
  queuedDispatchIds,
} from "./driverHelpers.js";

// Wave 13 driver core (lane D1): the top bar, the sync pill, the safety gate,
// the instructions screen, the waiting-for-signal and signed-out states and the
// tab bar, drawn to docs/design/export-handoff (drv_*.html, 390 px).

const fill = (text, values) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text);

// Lucide's cloud-check (the design's sync icon), which the installed
// lucide-react predates; same 24 px grid and stroke as the library icons.
function CloudCheck({ size = 24, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d="m17 15-5.5 5.5L9 18" />
      <path d="M5 17.743A7 7 0 1 1 15.71 10h1.79a4.5 4.5 0 0 1 1.5 8.742" />
    </svg>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────

// "Synced" when live with nothing queued, "{n} waiting" while the outbox holds
// work, "Offline" with no connection. The time of the last live contact is the
// title; the full queue is on the Instructions tab.
export function SyncPill({ online, queued, flushing, lastSync, onOpen }) {
  const { t } = useLanguage();
  const time = clockTime(lastSync);
  const title = time ? fill(t("d1_sync_title"), { time }) : t("d1_never_synced");
  const tone = queued > 0 ? "is-waiting" : online ? "is-synced" : "is-offline";
  const Icon = queued > 0 || !online ? CloudOff : CloudCheck;
  const label =
    queued > 0 ? (
      <span data-testid="driver-queued-count">
        {flushing ? t("d1_syncing") : fill(t("d1_waiting_n"), { n: queued })}
      </span>
    ) : online ? (
      t("d1_synced")
    ) : (
      t("d1_offline")
    );
  const content = (
    <>
      <Icon size={14} aria-hidden="true" />
      {label}
    </>
  );
  if (queued > 0 && onOpen) {
    return (
      <button
        type="button"
        className={`drv-pill drv-hit ${tone}`}
        data-testid="driver-sync-pill"
        title={title}
        onClick={onOpen}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={`drv-pill ${tone}`} data-testid="driver-sync-pill" title={title} role="status">
      {content}
    </span>
  );
}

export function DriverTopBar({ truckCode, onChangeTruck, sync }) {
  const { t } = useLanguage();
  const chip = (
    <>
      <Truck size={15} aria-hidden="true" />
      <span data-testid="driver-truck-code">{truckCode}</span>
    </>
  );
  return (
    <header className="drv-top">
      <Mascot size={28} />
      {onChangeTruck ? (
        <button
          type="button"
          className="drv-chip drv-hit"
          data-testid="driver-truck-chip"
          aria-label={`${fill(t("d1_truck_chip"), { code: truckCode })} · ${t("d1_change_truck")}`}
          onClick={onChangeTruck}
        >
          {chip}
        </button>
      ) : (
        <span className="drv-chip" data-testid="driver-truck-chip">
          {chip}
        </span>
      )}
      <span className="drv-top-space" />
      {sync}
    </header>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

export const DRIVER_TABS = [
  { id: "instruksi", icon: ClipboardList, label: "d1_tab_instructions" },
  { id: "rute", icon: Route, label: "d1_tab_route" },
  { id: "lapor", icon: TriangleAlert, label: "d1_tab_report" },
  { id: "tpa", icon: Warehouse, label: "d1_tab_tpa" },
];

export function DriverTabBar({ tab, onSelect, instructionCount }) {
  const { t } = useLanguage();
  return (
    <nav className="driver-tabs" aria-label={t("d1_tabs")}>
      {DRIVER_TABS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          className={`driver-tab${tab === id ? " active" : ""}`}
          data-testid={`driver-tab-${id}`}
          aria-current={tab === id ? "page" : undefined}
          onClick={() => onSelect(id)}
        >
          <Icon size={22} aria-hidden="true" />
          <span>{t(label)}</span>
          {id === "instruksi" && instructionCount > 0 && (
            <span className="driver-tab-count" data-testid="driver-tab-instruksi-count">
              {instructionCount}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

// ── Choose your truck ─────────────────────────────────────────────────────────

const PICK_ROWS = 6;

// The shared depot account picks its truck from the fleet roster (simulated, so
// the list carries data-provenance and a title). Without a search the trucks
// used last on this phone come first, then the roster by code.
export function TruckPickScreen({ drivers, loading, initialCode, onStart, onBack, backLabel, sync }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => initialCode || readRecentTrucks()[0]?.code || null);
  const recentCodes = useMemo(() => new Set(readRecentTrucks().map((d) => d.code)), []);
  const rows = useMemo(() => {
    if (query.trim()) return matchTrucks(drivers, query);
    const known = new Map(drivers.map((d) => [d.code, d]));
    const recent = readRecentTrucks().map((d) => known.get(d.code) || d);
    const rest = drivers.filter((d) => !recentCodes.has(d.code));
    return [...recent, ...rest];
  }, [drivers, query, recentCodes]);
  const shown = rows.slice(0, PICK_ROWS);
  const typed = query.trim().toUpperCase();
  // Offline before the roster ever loaded: a typed code is still usable.
  const offlineCode = drivers.length === 0 && /^[A-Z]{1,3}-?\d{1,4}$/.test(typed) ? typed : null;
  const pickable = offlineCode ? [{ code: offlineCode, name: offlineCode }, ...shown] : shown;
  const chosen =
    pickable.find((d) => d.code === selected) ||
    drivers.find((d) => d.code === selected) ||
    readRecentTrucks().find((d) => d.code === selected) ||
    null;

  return (
    <>
      <header className="drv-top">
        <button
          type="button"
          className="drv-back drv-hit"
          data-testid="driver-pick-back"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="drv-top-title">{t("d1_pick_title")}</h1>
        <span className="drv-top-space" />
        {sync}
      </header>
      <div className="drv-body" data-testid="driver-truck-gate">
        <p className="drv-lede">{t("d1_pick_sub")}</p>
        <div className="drv-field">
          <label className="drv-label" htmlFor="driver-truck-search">
            {t("d1_pick_search")}
          </label>
          <div className="drv-input-wrap">
            <Search size={18} aria-hidden="true" />
            <input
              id="driver-truck-search"
              className="drv-input"
              data-testid="driver-truck-search"
              type="search"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("d1_pick_placeholder")}
            />
          </div>
        </div>
        {pickable.length > 0 && (
          <ul
            className="drv-list drv-pick-list"
            aria-label={t("d1_pick_list")}
            data-testid={!query.trim() && recentCodes.size > 0 ? "driver-pick-recent" : undefined}
            data-provenance="simulated"
            title={t("d1_pick_sim")}
          >
            {pickable.map((d) => {
              const on = d.code === selected;
              const recent = recentCodes.has(d.code);
              return (
                <li key={d.code} data-testid={`pick-${d.code}`}>
                  <button
                    type="button"
                    className={`drv-pick${on ? " is-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => setSelected(d.code)}
                  >
                    <span className="drv-pick-icon" aria-hidden="true">
                      <Truck size={20} />
                    </span>
                    <span className="drv-pick-text">
                      <strong>{d.code}</strong>
                      <small>
                        {[recent && !query.trim() ? t("d1_pick_recent") : null, d.zone || d.plate || null]
                          .filter(Boolean)
                          .join(" · ") || formatDriverName(d.name, t).label}
                      </small>
                    </span>
                    <span className="drv-radio" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {query.trim() && rows.length > shown.length && (
          <p className="drv-muted" data-testid="driver-pick-more">
            {fill(t("drv10_pick_more"), { n: rows.length - shown.length })}
          </p>
        )}
        {query.trim() && drivers.length > 0 && rows.length === 0 && (
          <p className="drv-muted" role="status" data-testid="driver-pick-none">
            {t("drv10_pick_none")}
          </p>
        )}
        {loading && drivers.length === 0 && !offlineCode && (
          <p className="drv-muted" role="status">
            {t("drv_gate_loading")}
          </p>
        )}
        <span className="drv-roster-sim sr-only" data-testid="driver-roster-sim">
          {t("d1_pick_sim")}
        </span>
        <div className="drv-push">
          <button
            type="button"
            className="drv-btn primary"
            data-testid="driver-pick-start"
            disabled={!chosen}
            onClick={() => chosen && onStart(chosen)}
          >
            <ArrowRight size={18} aria-hidden="true" />
            {chosen ? fill(t("d1_pick_start"), { code: chosen.code }) : t("d1_pick_choose")}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Safety ────────────────────────────────────────────────────────────────────

function hoursMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return { h: Math.floor(total / 60), m: String(total % 60).padStart(2, "0") };
}

const isSimulated = (safety) => String(safety?.classification || "").startsWith("SIMULATED");

// The duty cap screen (Y1kCA): new work is held until a supervisor lifts it.
// Thresholds and duty come from GET /api/safety/driver/{truck}; simulated duty
// carries data-provenance and says so in its title.
export function SafetyGate({ safety, onTellDispatch }) {
  const { t } = useLanguage();
  const [showHours, setShowHours] = useState(false);
  const block = Number(safety.block_at_minutes) || 720;
  const warn = Number(safety.warn_at_minutes) || 600;
  const duty = Number(safety.duty_minutes) || 0;
  const scale = Math.max(block, duty);
  const value = hoursMinutes(duty);
  const sim = isSimulated(safety);
  const provenance = sim ? t("d1_safety_sim") : t("d1_safety_observed");
  const started = clockTime(safety.shift_started_at);
  return (
    <section className="drv-gate" data-testid="driver-safety-gate-screen" role="alert">
      <span className="drv-gate-icon" aria-hidden="true">
        <OctagonPause size={32} />
      </span>
      <h1 className="drv-h1" data-testid="driver-safety-blocked">
        {fill(t("d1_safety_title"), { h: Math.round(block / 60) })}
      </h1>
      <p className="drv-gate-sub">{t("d1_safety_sub")}</p>
      <div
        className="drv-panel drv-duty"
        data-provenance={sim ? "simulated" : "observed"}
        title={provenance}
        data-testid="driver-safety-label"
      >
        <p className="drv-duty-row">
          <span>{t("d1_safety_duty")}</span>
          <strong>{fill(t("d1_safety_value"), value)}</strong>
        </p>
        <div
          className="drv-duty-track"
          role="meter"
          aria-label={t("d1_safety_duty")}
          aria-valuemin={0}
          aria-valuemax={scale}
          aria-valuenow={duty}
          aria-valuetext={fill(t("d1_safety_value"), value)}
        >
          <span className="drv-duty-fill" style={{ transform: `scaleX(${Math.min(1, duty / scale)})` }} />
          <span className="drv-duty-mark" style={{ left: `${(warn / scale) * 100}%` }} />
        </div>
        <p className="drv-duty-ticks" aria-hidden="true">
          <span>{t("d1_safety_tick_zero")}</span>
          <span>{fill(t("d1_safety_tick_warn"), { h: Math.round(warn / 60) })}</span>
          <span>{fill(t("d1_safety_tick_stop"), { h: Math.round(block / 60) })}</span>
        </p>
        {showHours && (
          <p className="drv-muted" data-testid="driver-safety-hours">
            {started ? `${fill(t("d1_safety_started"), { time: started })} · ` : ""}
            {provenance}
          </p>
        )}
      </div>
      <div className="drv-panel">
        <p className="drv-panel-title">
          <ShieldCheck size={16} aria-hidden="true" />
          {t("d1_safety_lift_title")}
        </p>
        <p className="drv-muted">{t("d1_safety_lift_body")}</p>
      </div>
      <div className="drv-push">
        <button type="button" className="drv-btn primary" onClick={onTellDispatch}>
          <MessageSquareWarning size={18} aria-hidden="true" />
          {t("d1_safety_tell")}
        </button>
        <button
          type="button"
          className="drv-btn secondary"
          aria-expanded={showHours}
          onClick={() => setShowHours((v) => !v)}
        >
          <Clock3 size={18} aria-hidden="true" />
          {showHours ? t("d1_safety_hide_hours") : t("d1_safety_hours")}
        </button>
      </div>
    </section>
  );
}

// Thin notices for the states that do not stop work: approaching the duty cap,
// a supervisor's override, and a long wait at the disposal gate.
export function SafetyNotice({ safety }) {
  const { t, lang } = useLanguage();
  if (!safety || typeof safety !== "object") return null;
  const hours = (minutes, fallback) => {
    const n = Number(minutes);
    const h = Number.isFinite(n) && n > 0 ? Math.round((n / 60) * 10) / 10 : fallback;
    return h.toLocaleString(localeFor(lang), { maximumFractionDigits: 1 });
  };
  const lines = [];
  if (safety.duty_state === "warn") {
    lines.push({ kind: "warn", text: fill(t("drv6_safety_warn"), { h: hours(safety.warn_at_minutes, 10) }) });
  }
  if (safety.duty_state === "blocked" && safety.override) {
    lines.push({
      kind: "override",
      text: fill(t("drv6_safety_override"), { by: safety.override.by || "—" }),
      note: safety.override.reason,
    });
  }
  if (safety.gate_state === "alert") {
    lines.push({
      kind: "gate",
      text: fill(t("drv6_safety_gate"), { h: hours(safety.gate_alert_at_minutes, 3) }),
    });
  }
  if (lines.length === 0) return null;
  const sim = isSimulated(safety);
  return (
    <section
      className="drv-notice"
      data-testid="driver-safety"
      role="alert"
      data-provenance={sim ? "simulated" : "observed"}
      title={sim ? t("d1_safety_sim") : t("d1_safety_observed")}
    >
      {lines.map((line) => (
        <p
          key={line.kind}
          className={`drv-notice-line is-${line.kind}`}
          data-testid={`driver-safety-${line.kind}`}
        >
          {line.kind === "override" ? (
            <ShieldCheck size={16} aria-hidden="true" />
          ) : (
            <TriangleAlert size={16} aria-hidden="true" />
          )}
          <span>
            {line.text}
            {line.note ? ` · ${line.note}` : ""}
          </span>
        </p>
      ))}
    </section>
  );
}

// ── Pre-trip check ────────────────────────────────────────────────────────────

export const PRETRIP_ITEMS = ["rem", "mesin", "ban", "bbm", "oli", "bak_compactor", "lampu"];
export const BERAT_COMPONENTS = new Set(["rem", "mesin", "ban"]);

// EIqeR: seven OK/NO rows; a NO opens its own note and says what happens next
// (brakes, engine and tyres are serious and keep the truck off the road).
// `onSubmit(items, notes)` posts or queues; the parent owns the network.
export function PretripCheck({ onSubmit }) {
  const { t } = useLanguage();
  const [items, setItems] = useState({});
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(false);

  const answered = PRETRIP_ITEMS.filter((key) => key in items).length;
  const failures = PRETRIP_ITEMS.filter((key) => items[key] === false);
  const notesMissing = failures.some((key) => !(notes[key] || "").trim());
  const canSubmit = answered === PRETRIP_ITEMS.length && !notesMissing;

  const markRestOk = () =>
    setItems((prev) => {
      const next = { ...prev };
      PRETRIP_ITEMS.forEach((key) => {
        if (!(key in next)) next[key] = true;
      });
      return next;
    });

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(items, notes);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="drv-screen" data-testid="pretrip-form">
      <div className="drv-head">
        <h1 className="drv-h2">{t("d1_pretrip_title")}</h1>
        <div className="drv-steps" aria-hidden="true">
          {PRETRIP_ITEMS.map((key, i) => (
            <span key={key} className={i < answered ? "is-done" : ""} />
          ))}
        </div>
        <p className="drv-small" role="status">
          {fill(t("d1_pretrip_progress"), { n: answered, total: PRETRIP_ITEMS.length })}
        </p>
      </div>
      <ul className="drv-list drv-checks">
        {PRETRIP_ITEMS.map((key) => {
          const label = t(`d1_item_${key}`);
          const failed = items[key] === false;
          const noteId = `pretrip-note-${key}`;
          const hintId = `pretrip-hint-${key}`;
          return (
            <li key={key} className={`drv-check${failed ? " is-failed" : ""}`} data-testid={`pretrip-${key}`}>
              <div className="drv-check-row">
                <span className="drv-check-name">{label}</span>
                <span className="drv-seg">
                  <button
                    type="button"
                    data-testid={`ok-${key}`}
                    className={`drv-seg-btn ok${items[key] === true ? " active" : ""}`}
                    aria-pressed={items[key] === true}
                    aria-label={fill(t("d1_ok_aria"), { item: label })}
                    onClick={() => setItems((p) => ({ ...p, [key]: true }))}
                  >
                    {t("d1_ok")}
                  </button>
                  <button
                    type="button"
                    data-testid={`tidak-${key}`}
                    className={`drv-seg-btn no${failed ? " active" : ""}`}
                    aria-pressed={failed}
                    aria-label={fill(t("d1_no_aria"), { item: label })}
                    onClick={() => setItems((p) => ({ ...p, [key]: false }))}
                  >
                    {t("d1_no")}
                  </button>
                </span>
              </div>
              {failed && (
                <>
                  <input
                    id={noteId}
                    className="drv-note"
                    data-testid={`pretrip-note-${key}`}
                    aria-label={fill(t("d1_note_aria"), { item: label })}
                    aria-describedby={hintId}
                    value={notes[key] || ""}
                    onChange={(e) => setNotes((p) => ({ ...p, [key]: e.target.value }))}
                    placeholder={t("d1_note_placeholder")}
                  />
                  <p
                    id={hintId}
                    className={`drv-check-hint${BERAT_COMPONENTS.has(key) ? " is-serious" : ""}`}
                  >
                    {BERAT_COMPONENTS.has(key) ? t("d1_serious") : t("d1_minor")}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {answered === PRETRIP_ITEMS.length && notesMissing && (
        <p className="drv-small" role="status">
          {t("d1_note_needed")}
        </p>
      )}
      <div className="drv-actions-row">
        <button
          type="button"
          className="drv-btn secondary"
          data-testid="pretrip-rest-ok"
          onClick={markRestOk}
          disabled={answered === PRETRIP_ITEMS.length}
        >
          {t("d1_rest_ok")}
        </button>
        <button
          type="button"
          className="drv-btn primary"
          data-testid="pretrip-submit"
          onClick={submit}
          disabled={!canSubmit || busy}
        >
          {busy ? t("d1_sending") : t("d1_submit")}
        </button>
      </div>
    </section>
  );
}

// ── Instructions ──────────────────────────────────────────────────────────────

const STRUCTURED_POLL_MS = 30000;

function structuredCacheKey(truckCode) {
  return `pythia_driver_plan_instr_${truckCode}`;
}

// GET /api/operations/instructions/{truck}: the approved plan's trips, gate slot
// and reason as fields (the dispatch row carries the same as Indonesian text).
// Keyed by dispatch_id; the last live copy stays on this phone.
export function useStructuredInstructions(truckCode) {
  const read = useCallback(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(structuredCacheKey(truckCode)) || "[]");
      return Array.isArray(cached) ? cached : [];
    } catch {
      return [];
    }
  }, [truckCode]);
  const [list, setList] = useState(read);
  useEffect(() => {
    if (!truckCode) return undefined;
    setList(read());
    let cancelled = false;
    const load = () =>
      apiFetch(`/operations/instructions/${encodeURIComponent(truckCode)}`, { tokenKey: FIELD_TOKEN_KEY })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const body = await res.json();
          if (cancelled || !Array.isArray(body)) return;
          setList(body);
          if (res.headers.get("X-Pythia-Stale") !== "1") {
            try {
              localStorage.setItem(structuredCacheKey(truckCode), JSON.stringify(body));
            } catch {
              // The cache is a convenience only.
            }
          }
        })
        .catch(() => {});
    load();
    const id = setInterval(load, STRUCTURED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [truckCode, read]);
  return useMemo(() => new Map(list.map((item) => [item.dispatch_id, item])), [list]);
}

function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function greetingKey(date = new Date()) {
  const h = date.getHours();
  if (h < 11) return "d1_greet_morning";
  if (h < 18) return "d1_greet_afternoon";
  return "d1_greet_evening";
}

function ModelTag() {
  const { t } = useLanguage();
  return (
    <span className="drv-tag is-model" title={t("d1_model_title")}>
      {t("d1_model")}
    </span>
  );
}

// One instruction card: the approved plan's trips (structured fields) or a
// dispatcher's message (text only). "Depart HH:MM" is the headline when the
// plan carries a gate slot; both times are model output and tagged so.
function InstructionCard({ dispatch, plan, cachedTag }) {
  const { t, lang } = useLanguage();
  const fields = plan || null;
  const stops = Array.isArray(fields?.stops) ? [...fields.stops].sort((a, b) => a.order - b.order) : [];
  const slot = fields?.gate_slot || instructionSlotFromText(dispatch.instruction);
  const depart = departHeadline(slot);
  const facilityNames = new Map(stops.map((s) => [s.facility, s.facility_display || s.facility]));
  const facility = slot ? facilityNames.get(slot.facility) || slot.facility : null;
  const areas = Array.isArray(fields?.reason?.areas) ? fields.reason.areas : [];
  const received = clockTime(dispatch.created_at);
  const nf = (n) => Number(n).toLocaleString(localeFor(lang), { maximumFractionDigits: 0 });
  const title = stops.length
    ? stops.length === 1
      ? t("d1_instr_trip")
      : fill(t("d1_instr_trips"), { n: stops.length })
    : dispatch.manager_id === "operations_optimizer"
      ? t("drv6_instr_plan")
      : t("d1_instr_from_dispatch");
  const departDate =
    depart?.date &&
    new Date(`${depart.date}T00:00:00`).toLocaleDateString(localeFor(lang), {
      day: "numeric",
      month: "short",
    });
  const lastFacility = stops.length ? stops[stops.length - 1].facility_display : null;

  return (
    <article className="drv-card drv-instr">
      <div className="drv-instr-head">
        <p className="drv-instr-kicker">
          <span>{t("d1_instr_today")}</span>
          {cachedTag ||
            (received && (
              <span className="drv-tag is-new">{fill(t("d1_instr_new"), { time: received })}</span>
            ))}
        </p>
        <h2 className="drv-h3">{title}</h2>
        {depart && (
          <div className="drv-slot" data-testid="driver-instruction-depart">
            <Warehouse size={20} aria-hidden="true" />
            <span className="drv-slot-text">
              <small>{t("d1_depart_label")}</small>
              <strong>
                {depart.time}
                {departDate && (
                  <span className="drv-slot-day"> {fill(t("d1_depart_day"), { date: departDate })}</span>
                )}
              </strong>
              {slot?.start && (
                <small className="drv-slot-gate">
                  {fill(t("d1_gate_slot"), {
                    facility: facility || "—",
                    start: slot.start,
                    end: slot.end || "",
                  })}
                </small>
              )}
            </span>
            <ModelTag />
          </div>
        )}
      </div>
      {stops.length > 0 ? (
        <ol className="drv-stops">
          {stops.map((stop, i) => (
            <li key={`${stop.order}-${stop.area || i}`}>
              <span className="drv-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="drv-stop-name">
                {fill(t("d1_stop_area"), { name: stop.kecamatan })}
                {Number.isFinite(Number(stop.tons)) && (
                  <small>{fill(t("d1_stop_tons"), { t: nf(stop.tons) })}</small>
                )}
              </span>
              {stop.window && <span className="drv-stop-time">{stop.window}</span>}
            </li>
          ))}
          {lastFacility && (
            <li>
              <span className="drv-num" aria-hidden="true">
                {stops.length + 1}
              </span>
              <span className="drv-stop-name">{lastFacility}</span>
              {slot?.start && <span className="drv-stop-time">{slot.start}</span>}
            </li>
          )}
        </ol>
      ) : (
        <p className="drv-instr-text driver-instruction-text">{dispatch.instruction}</p>
      )}
      {areas.length > 0 && (
        <p className="drv-why">
          <Info size={15} aria-hidden="true" />
          <span>
            {fill(t("d1_reason"), {
              areas: areas.map((a) => `Kec. ${a.kecamatan} ${nf(a.forecast_tons)} t`).join(", "),
            })}{" "}
            <ModelTag />
          </span>
        </p>
      )}
    </article>
  );
}

// Accept (READY) or report a problem (ISSUE). One operation id per (instruction,
// answer): repeated taps replace one queued entry, and every replay carries the
// id the server's replay guard knows. Offline answers queue like every write.
function useInstructionAnswer(say, onSettled) {
  const { t } = useLanguage();
  const [answered, setAnswered] = useState(() => new Set());
  const [busyId, setBusyId] = useState(null);
  const operationIds = useRef(new Map());
  const inFlight = useRef(new Set());

  const operationIdFor = (dispatchId, status) => {
    const key = `${dispatchId}:${status}`;
    if (!operationIds.current.has(key)) operationIds.current.set(key, newOperationId());
    return operationIds.current.get(key);
  };

  const answer = async (dispatch, status, reason = "") => {
    if (inFlight.current.has(dispatch.id)) return;
    inFlight.current.add(dispatch.id);
    setBusyId(dispatch.id);
    const path = `/dispatch/${encodeURIComponent(dispatch.id)}/confirm`;
    const data = {
      status,
      note: status === "READY" ? t("drv6_instr_ready_note") : reason.trim() || t("drv6_instr_issue_note"),
      operation_id: operationIdFor(dispatch.id, status),
    };
    try {
      let res;
      try {
        res = await apiFetch(path, { method: "POST", body: data, tokenKey: FIELD_TOKEN_KEY });
      } catch {
        await enqueueDriverOperation({ path, data, label: t("d1_instr_today") });
        setAnswered((prev) => new Set(prev).add(dispatch.id));
        onSettled?.(dispatch.id, status);
        say(t("drv_queued_offline"));
        return;
      }
      if (res.status === 401) {
        announceSessionExpired();
        say(t("drv6_session_expired"));
        return;
      }
      if (!res.ok) {
        say(fill(t("drv6_request_failed"), { code: res.status }));
        return;
      }
      markDriverSynced();
      setAnswered((prev) => new Set(prev).add(dispatch.id));
      onSettled?.(dispatch.id, status);
      say(t("drv6_instr_sent"));
    } catch (error) {
      say(error instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv6_instr_failed"), 8000);
    } finally {
      inFlight.current.delete(dispatch.id);
      setBusyId(null);
    }
  };
  return { answered, busyId, answer };
}

function InstructionActions({ dispatch, blocked, busy, onAnswer }) {
  const { t } = useLanguage();
  const [issueOpen, setIssueOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = `instr-reason-${dispatch.id}`;
  return (
    <div className="drv-instr-actions">
      {blocked && <p className="drv-held driver-held">{t("drv6_safety_held")}</p>}
      <button
        type="button"
        className="drv-btn primary"
        data-testid="driver-instruction-ready"
        disabled={blocked || busy}
        onClick={() => onAnswer(dispatch, "READY")}
      >
        <Check size={18} aria-hidden="true" />
        {t("d1_accept")}
      </button>
      {issueOpen ? (
        <div className="drv-field">
          <label className="drv-label" htmlFor={reasonId}>
            {t("d1_issue_label")}
          </label>
          <input
            id={reasonId}
            className="drv-input is-plain"
            data-testid="driver-instruction-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("d1_issue_placeholder")}
          />
          <button
            type="button"
            className="drv-btn secondary"
            data-testid="driver-instruction-issue"
            disabled={busy}
            onClick={() => onAnswer(dispatch, "ISSUE", reason)}
          >
            <MessageSquareWarning size={18} aria-hidden="true" />
            {t("d1_issue_send")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="drv-link drv-hit"
          data-testid="driver-instruction-cant"
          onClick={() => setIssueOpen(true)}
        >
          {t("d1_cant")}
        </button>
      )}
    </div>
  );
}

// yNOwN: greeting, the pre-trip banner, today's instruction and Accept. Without
// a pending instruction it is the "No instruction yet" state (D2vpX), or, once
// the driver answered or a route is under way, says so and leads to the route.
export function InstructionsScreen({
  driver,
  feed,
  plans,
  blocked,
  outboxItems,
  pretrip,
  onStartPretrip,
  say,
  queuePanel,
  route,
  onOpenRoute,
}) {
  const { t, lang } = useLanguage();
  const { answered, busyId, answer } = useInstructionAnswer(say, feed.settle);
  const hidden = useMemo(() => {
    const ids = queuedDispatchIds(outboxItems);
    answered.forEach((id) => ids.add(id));
    return ids;
  }, [outboxItems, answered]);
  const visible = pendingInstructions(feed.list, hidden);
  const [first, ...rest] = visible;
  const firstPlan = first ? plans.get(first.id) : null;
  const trips = Array.isArray(firstPlan?.stops) ? firstPlan.stops.length : 0;
  const today = new Date().toLocaleDateString(localeFor(lang), {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const summary = pretripSummary(pretrip.record, BERAT_COMPONENTS);
  // A copy served from the cache says so, with its age when the service worker knows it.
  const cachedAge = feed.cached ? cachedAgeMinutes(feed.cached.at) : null;
  const cachedTag = feed.cached && (
    <span className="drv-tag is-neutral" data-testid="driver-instructions-cached">
      {cachedAge === null ? t("d1_instr_cached") : t("drv10_instr_cached_age").replace("{n}", cachedAge)}
    </span>
  );
  const lastAnswer = feed.lastAnswer || null;
  // A failed reload is only "could not load" when nothing else is known: an answered
  // instruction or a route under way is the state to show, labelled as a saved copy.
  const failedEmpty = feed.loadFailed && feed.list.length === 0 && !lastAnswer && !route;
  const emptyTitle = failedEmpty
    ? navigator.onLine
      ? t("drv10_instr_load_error")
      : t("drv10_instr_offline")
    : lastAnswer
      ? fill(t(lastAnswer.status === "READY" ? "d1_empty_accepted" : "d1_empty_issue"), {
          time: clockTime(lastAnswer.at) || "",
        }).trim()
      : route
        ? t("d1_empty_route_title")
        : t("d1_empty_title");
  const emptyBody = failedEmpty
    ? null
    : route
      ? fill(t("d1_empty_route_body"), { n: route.left })
      : lastAnswer
        ? t(lastAnswer.status === "READY" ? "d1_empty_accepted_body" : "d1_empty_issue_body")
        : t("d1_empty_body");
  const name = formatDriverName(driver.driver_name, t);

  return (
    <section className="drv-screen" data-testid={first ? "driver-instructions" : "driver-instructions-empty"}>
      {queuePanel}
      {first || pretrip.done ? (
        <div className="drv-hi">
          <h1 className="drv-h2">{t(greetingKey())}</h1>
          <p className="drv-hi-sub">
            <span
              data-testid="driver-identity"
              {...(name.simulated || !driver.bound
                ? { "data-provenance": "simulated", title: name.title || t("d1_pick_sim") }
                : {})}
            >
              {name.label}
            </span>
            {` · ${today}`}
            {trips > 0 && ` · ${trips === 1 ? t("d1_trip_today") : fill(t("d1_trips_today"), { n: trips })}`}
          </p>
        </div>
      ) : null}
      {pretrip.done && (
        <p className={`drv-done-banner${summary.serious ? " is-serious" : ""}`} data-testid="pretrip-done">
          {summary.serious ? (
            <TriangleAlert size={16} aria-hidden="true" />
          ) : (
            <CircleCheck size={16} aria-hidden="true" />
          )}
          <span>
            {summary.time ? fill(t("d1_pretrip_done"), { time: summary.time }) : t("d1_pretrip_done_plain")}
            {summary.serious
              ? ` · ${t("d1_pretrip_serious")}`
              : summary.minor > 0
                ? ` · ${summary.minor === 1 ? t("d1_pretrip_note_one") : fill(t("d1_pretrip_notes"), { n: summary.minor })}`
                : ""}
          </span>
        </p>
      )}
      {first && pretrip.done === false && (
        <button
          type="button"
          className="drv-todo-banner"
          data-testid="driver-start-pretrip"
          onClick={onStartPretrip}
        >
          <ClipboardCheck size={16} aria-hidden="true" />
          <span>{t("d1_pretrip_todo")}</span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      )}
      {first ? (
        <>
          <div className="drv-instr-wrap is-main" data-testid={`driver-instruction-${first.id}`}>
            <InstructionCard dispatch={first} plan={firstPlan} cachedTag={cachedTag} />
            {rest.length > 0 && (
              <p className="drv-small">{fill(t("d1_more_instructions"), { n: rest.length })}</p>
            )}
            <div className="drv-push">
              <InstructionActions
                dispatch={first}
                blocked={blocked}
                busy={busyId === first.id}
                onAnswer={answer}
              />
            </div>
          </div>
          {rest.map((dispatch) => (
            <div
              key={dispatch.id}
              className="drv-instr-wrap"
              data-testid={`driver-instruction-${dispatch.id}`}
            >
              <InstructionCard dispatch={dispatch} plan={plans.get(dispatch.id)} cachedTag={cachedTag} />
              <InstructionActions
                dispatch={dispatch}
                blocked={blocked}
                busy={busyId === dispatch.id}
                onAnswer={answer}
              />
            </div>
          ))}
        </>
      ) : (
        <div className="drv-empty">
          <Mascot size={80} />
          <h2 className="drv-h2" data-testid="driver-instructions-empty-title">
            {emptyTitle}
          </h2>
          {emptyBody && <p className="drv-empty-body">{emptyBody}</p>}
          {cachedTag}
          {route && onOpenRoute && (
            <button
              type="button"
              className="drv-btn secondary"
              data-testid="driver-open-route"
              onClick={onOpenRoute}
            >
              <Route size={18} aria-hidden="true" />
              {t("d1_open_route")}
            </button>
          )}
          {pretrip.done === false && (
            <button
              type="button"
              className="drv-btn secondary"
              data-testid="driver-start-pretrip"
              onClick={onStartPretrip}
            >
              <ClipboardCheck size={18} aria-hidden="true" />
              {t("d1_start_pretrip")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ── Waiting for signal ────────────────────────────────────────────────────────

function queueIcon(path = "") {
  if (/\/stops\/\d+\/complete$/.test(path)) return Camera;
  if (/\/receipt$/.test(path)) return Scale;
  if (path === "/pretrip") return ClipboardCheck;
  if (path.startsWith("/dispatch/")) return ClipboardList;
  if (path.includes("gate-arrival")) return Flag;
  return TriangleAlert;
}

// D2vpX "Waiting for signal": what the outbox still holds, each with the time
// it was saved; it sends by itself, "Try sending now" retries at once. Work the
// server refused is listed apart (it was NOT recorded) until dismissed.
export function QueuePanel({ items, flushing, lastSync, onRetry }) {
  const { t } = useLanguage();
  if (items.length === 0) return null;
  const time = clockTime(lastSync);
  return (
    <div className="drv-queue" data-testid="driver-sync-status">
      <>
        <div className="drv-banner is-waiting" role="status">
          <CloudOff size={20} aria-hidden="true" />
          <span>
            <strong>
              {items.length === 1 ? t("d1_queue_title_one") : fill(t("d1_queue_title"), { n: items.length })}
            </strong>
            <small>{t("d1_queue_sub")}</small>
          </span>
        </div>
        <ul className="drv-list drv-queue-list" aria-label={t("d1_queue_list")}>
          {items.map((item) => {
            const Icon = queueIcon(item.path);
            const saved = clockTime(item.queued_at);
            return (
              <li key={item.op_id} data-testid="driver-queue-item">
                <Icon size={17} aria-hidden="true" />
                <span className="drv-queue-text">
                  <strong>{item.label}</strong>
                  {saved && <small>{fill(t("d1_queue_saved"), { time: saved })}</small>}
                </span>
                <Timer size={15} aria-hidden="true" className="drv-queue-timer" />
              </li>
            );
          })}
        </ul>
        <p className="drv-small">
          <span data-testid="driver-last-sync">
            {time ? fill(t("drv6_last_sync"), { time }) : t("drv6_never_synced")}
          </span>
          {" · "}
          <span data-testid="driver-pending-count">
            {flushing ? t("d1_syncing") : fill(t("drv6_pending_n"), { n: items.length })}
          </span>
        </p>
        {onRetry && (
          <button
            type="button"
            className="drv-btn secondary"
            data-testid="driver-sync-now"
            disabled={flushing}
            onClick={onRetry}
          >
            <RefreshCw size={18} aria-hidden="true" />
            {flushing ? t("d1_syncing") : t("d1_try_now")}
          </button>
        )}
      </>
    </div>
  );
}

// Work the server refused (it was NOT recorded) stays on every tab until the
// driver dismisses it.
export function RejectedList({ items, onDismiss }) {
  const { t } = useLanguage();
  if (items.length === 0) return null;
  return (
    <section className="drv-card drv-rejected" data-testid="driver-needs-action" role="alert">
      <p className="drv-panel-title">
        <TriangleAlert size={16} aria-hidden="true" />
        {t("drv6_needs_action_title")}
      </p>
      <p className="drv-muted">{t("drv6_needs_action_desc")}</p>
      <ul className="drv-list-plain">
        {items.map((item) => (
          <li key={item.op_id} data-testid="driver-rejected-item">
            <span className="drv-queue-text">
              <strong>{item.label}</strong>
              <small>
                {item.reason === "photo_missing"
                  ? t("drv6_reason_photo_missing")
                  : fill(t("drv6_reason_status"), { code: item.status })}
                {item.detail ? ` · ${item.detail}` : ""}
              </small>
            </span>
            <button
              type="button"
              className="drv-btn secondary is-small"
              onClick={() => onDismiss(item.op_id)}
            >
              {t("drv6_dismiss")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Signed out ────────────────────────────────────────────────────────────────

// D2vpX "Signed out": the backend forgot this session. The driver signs in
// again in place; the outbox is untouched and flushes once the token is back.
export function SignInAgain({ username, queued, onSignedIn }) {
  const { t } = useLanguage();
  const [user, setUser] = useState(username || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        body: { username: user, password },
        auth: false,
      });
      if (res.status === 401) {
        setError(t("login_error"));
        return;
      }
      if (!res.ok) throw new Error(`login HTTP ${res.status}`);
      const principal = await res.json();
      try {
        localStorage.setItem(FIELD_TOKEN_KEY, principal.token);
        localStorage.setItem(FIELD_ROLE_KEY, principal.role);
      } catch {
        // Storage blocked: the session lasts until reload.
      }
      onSignedIn(principal);
    } catch {
      setError(t("login_error_unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const body =
    queued === 0
      ? t("d1_session_body_none")
      : queued === 1
        ? t("d1_session_body_one")
        : fill(t("d1_session_body"), { n: queued });

  return (
    <form
      className="drv-body drv-signed-out"
      data-testid="driver-session-expired"
      role="alert"
      onSubmit={submit}
    >
      <span className="drv-icon-tile" aria-hidden="true">
        <LogIn size={26} />
      </span>
      <h1 className="drv-h2">{t("d1_signin_again")}</h1>
      <p className="drv-lede">{body}</p>
      {!username && (
        <div className="drv-field">
          <label className="drv-label" htmlFor="drv-again-user">
            {t("d1_username")}
          </label>
          <input
            id="drv-again-user"
            className="drv-input is-plain"
            autoComplete="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>
      )}
      <div className="drv-field">
        <label className="drv-label" htmlFor="drv-again-password">
          {t("d1_password")}
        </label>
        <div className="drv-input-wrap">
          <LockKeyhole size={18} aria-hidden="true" />
          <input
            id="drv-again-password"
            className="drv-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <p className="drv-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="drv-btn primary" disabled={busy || !user || !password}>
        <ArrowRight size={18} aria-hidden="true" />
        {busy ? t("d1_signing_in") : t("d1_sign_in")}
      </button>
    </form>
  );
}
