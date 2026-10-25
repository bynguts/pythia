import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HeartPulse } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import "./safety.css";

// Driver safety (R5/R6): duty hours since the first pre-trip or SPJ activation of
// the WIB day, and the gate wait at the TPA. Thresholds come from the API
// (app/core/units.py), so the marks below always match the server's rules.
const POLL_MS = 30000;
const DUTY_SCALE_MIN = 840; // 14 h axis: room past the 12 h block mark
const GATE_SCALE_MIN = 360; // 6 h axis around the 3 h service promise
const COLLAPSED_ROWS = 6;
const REASON_MIN = 10;

export function useSafetyOverview() {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/safety/overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOverview(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  return { overview, error, reload: load };
}

// Trucks that need a supervisor now: blocked without an override, or past the gate limit.
export function safetyAttentionCount(overview) {
  return (overview?.trucks || []).filter(
    (truck) => (truck.duty_state === "blocked" && !truck.override) || truck.gate_state === "alert",
  ).length;
}

function formatMinutes(minutes, t) {
  if (minutes === null || minutes === undefined) return "—";
  const whole = Math.max(0, Math.round(minutes));
  return t("saf_hm")
    .replace("{h}", String(Math.floor(whole / 60)))
    .replace("{m}", String(whole % 60).padStart(2, "0"));
}

function Gauge({ value, scale, marks, tone, label, valueText }) {
  const clamped = Math.min(Math.max(0, value), scale);
  return (
    <div className="safety-gauge-wrap">
      <div
        className="safety-gauge"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={scale}
        aria-valuenow={clamped}
        aria-valuetext={valueText}
      >
        <span className={`safety-gauge-fill tone-${tone}`} style={{ width: `${(clamped / scale) * 100}%` }} />
        {marks.map((mark) => (
          <span
            key={mark.at}
            className="safety-gauge-mark"
            data-testid="safety-gauge-mark"
            style={{ left: `${(mark.at / scale) * 100}%` }}
          />
        ))}
      </div>
      <div className="safety-gauge-ticks" aria-hidden="true">
        {marks.map((mark) => (
          <span key={mark.at} style={{ left: `${(mark.at / scale) * 100}%` }}>
            {mark.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function hoursMark(minutes, t) {
  return t("saf_hours_mark").replace("{h}", String(minutes / 60));
}

export function SafetyPanel({ overview, error = false, reload = () => {} }) {
  const { t, lang } = useLanguage();
  const titleId = useId();
  const reasonId = useId();
  const dialogTitleId = useId();
  const dialogRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overrideFor, setOverrideFor] = useState(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const trucks = overview?.trucks || [];
  const simulated = overview?.classification !== "OBSERVED_APP_EVENTS";
  const canOverride = Boolean(overview?.viewer?.can_override);
  const shown = expanded ? trucks : trucks.slice(0, COLLAPSED_ROWS);
  const warnAt = overview?.warn_at_minutes ?? 600;
  const blockAt = overview?.block_at_minutes ?? 720;
  const gateAt = overview?.gate_alert_at_minutes ?? 180;
  const windowDate = overview?.shift_window?.date
    ? new Date(`${overview.shift_window.date}T00:00:00`).toLocaleDateString(localeFor(lang), {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  function openOverride(truckCode) {
    setOverrideFor(truckCode);
    setReason("");
    setFormError("");
    dialogRef.current?.showModal?.();
  }

  function closeOverride() {
    dialogRef.current?.close?.();
    setOverrideFor(null);
  }

  async function submitOverride(event) {
    event.preventDefault();
    const text = reason.trim();
    if (text.length < REASON_MIN) {
      setFormError(t("saf_override_reason_short"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch("/safety/override", {
        method: "POST",
        body: { truck_code: overrideFor, reason: text },
      });
      if (res.status === 403) setFormError(t("saf_override_forbidden"));
      else if (!res.ok) setFormError(t("saf_override_failed"));
      else {
        closeOverride();
        reload();
      }
    } catch {
      setFormError(t("saf_override_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel safety-panel" data-testid="safety-panel" aria-labelledby={titleId}>
      <div className="safety-head">
        <div>
          <h2 id={titleId}>
            <HeartPulse size={18} aria-hidden="true" /> {t("saf_title")}
          </h2>
          <p>{t("saf_subtitle")}</p>
        </div>
        {overview && (
          <span
            className={`pill ${simulated ? "provenance-sim" : "provenance-observed"}`}
            data-testid="safety-classification"
            data-classification={overview.classification}
          >
            {simulated ? t("honesty_sim_badge") : t("saf_badge_observed")}
          </span>
        )}
      </div>

      {!overview && !error && (
        <p className="safety-status" role="status">
          {t("saf_loading")}
        </p>
      )}
      {error && (
        <p className="safety-status" role="alert">
          {t("saf_error")}
        </p>
      )}

      {overview && (
        <>
          <p className="safety-basis" data-testid="safety-basis">
            {simulated ? t("saf_basis_sim") : t("saf_basis_observed")}{" "}
            {windowDate && t("saf_window").replace("{date}", windowDate)}
          </p>
          <dl className="safety-stats">
            <div>
              <dt>{t("saf_p50")}</dt>
              <dd data-testid="safety-p50">{formatMinutes(overview.gate_wait_p50, t)}</dd>
            </div>
            <div>
              <dt>{t("saf_p90")}</dt>
              <dd data-testid="safety-p90">{formatMinutes(overview.gate_wait_p90, t)}</dd>
            </div>
            <div>
              <dt>{t("saf_count_blocked")}</dt>
              <dd>{overview.counts?.duty_blocked ?? 0}</dd>
            </div>
            <div>
              <dt>{t("saf_count_warn")}</dt>
              <dd>{overview.counts?.duty_warn ?? 0}</dd>
            </div>
            <div>
              <dt>{t("saf_count_gate")}</dt>
              <dd>{overview.counts?.gate_alert ?? 0}</dd>
            </div>
          </dl>
          <p className="safety-legend">
            {t("saf_legend")
              .replace("{warn}", String(warnAt / 60))
              .replace("{block}", String(blockAt / 60))
              .replace("{gate}", String(gateAt / 60))}
          </p>

          {trucks.length === 0 ? (
            <p className="safety-status">{t("saf_empty")}</p>
          ) : (
            <ul className="safety-list" aria-label={t("saf_list_aria")}>
              {shown.map((truck) => {
                const dutyTone =
                  truck.duty_state === "blocked" ? "danger" : truck.duty_state === "warn" ? "warning" : "ok";
                const gateTone = truck.gate_state === "alert" ? "danger" : "ok";
                const duty = formatMinutes(truck.duty_minutes, t);
                const wait = formatMinutes(truck.gate_wait_minutes, t);
                return (
                  <li
                    key={truck.truck_code}
                    className="safety-row"
                    data-testid="safety-row"
                    data-truck={truck.truck_code}
                    data-duty-state={truck.duty_state}
                    data-gate-state={truck.gate_state || "none"}
                  >
                    <div className="safety-row-head">
                      <strong>{truck.truck_code}</strong>
                      <span className={`safety-chip tone-${dutyTone}`}>
                        {t(`saf_duty_${truck.duty_state}`)}
                      </span>
                      {truck.gate_state && (
                        <span className={`safety-chip tone-${gateTone}`}>
                          {t(`saf_gate_${truck.gate_state}`)}
                        </span>
                      )}
                    </div>
                    <div className="safety-metric">
                      <span className="safety-metric-label">
                        {t("saf_duty")} <b>{duty}</b>
                      </span>
                      <Gauge
                        value={truck.duty_minutes}
                        scale={DUTY_SCALE_MIN}
                        marks={[
                          { at: warnAt, label: hoursMark(warnAt, t) },
                          { at: blockAt, label: hoursMark(blockAt, t) },
                        ]}
                        tone={dutyTone}
                        label={t("saf_duty_aria").replace("{truck}", truck.truck_code)}
                        valueText={duty}
                      />
                    </div>
                    <div className="safety-metric">
                      {truck.gate_wait_minutes === null || truck.gate_wait_minutes === undefined ? (
                        <span className="safety-metric-label">{t("saf_gate_none")}</span>
                      ) : (
                        <>
                          <span className="safety-metric-label">
                            {truck.gate_status === "exited" ? t("saf_gate_waited") : t("saf_gate_waiting")}{" "}
                            <b>{wait}</b>
                          </span>
                          <Gauge
                            value={truck.gate_wait_minutes}
                            scale={GATE_SCALE_MIN}
                            marks={[{ at: gateAt, label: hoursMark(gateAt, t) }]}
                            tone={gateTone}
                            label={t("saf_gate_aria").replace("{truck}", truck.truck_code)}
                            valueText={wait}
                          />
                        </>
                      )}
                    </div>
                    {truck.override ? (
                      <p className="safety-override-note" data-testid="safety-override-note">
                        {t("saf_override_by").replace("{by}", truck.override.by)}: {truck.override.reason}
                      </p>
                    ) : (
                      canOverride &&
                      truck.duty_state === "blocked" && (
                        <button
                          type="button"
                          className="safety-override-button"
                          data-testid="safety-override-open"
                          onClick={() => openOverride(truck.truck_code)}
                        >
                          {t("saf_override_action").replace("{truck}", truck.truck_code)}
                        </button>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {trucks.length > COLLAPSED_ROWS && (
            <button
              type="button"
              className="safety-toggle"
              data-testid="safety-show-all"
              data-value={trucks.length}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? t("saf_show_less") : t("saf_show_all").replace("{n}", String(trucks.length))}
            </button>
          )}
        </>
      )}

      <dialog
        ref={dialogRef}
        className="safety-dialog"
        aria-labelledby={dialogTitleId}
        data-testid="safety-override-dialog"
        onClose={() => setOverrideFor(null)}
      >
        <form noValidate onSubmit={submitOverride}>
          <h3 id={dialogTitleId}>{t("saf_override_title").replace("{truck}", overrideFor || "")}</h3>
          <p>{t("saf_override_hint")}</p>
          <label htmlFor={reasonId}>{t("saf_override_reason")}</label>
          <textarea
            id={reasonId}
            data-testid="safety-override-reason"
            value={reason}
            maxLength={500}
            rows={3}
            aria-invalid={Boolean(formError)}
            onChange={(event) => setReason(event.target.value)}
          />
          {formError && (
            <p className="safety-form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="safety-dialog-actions">
            <button type="button" className="safety-dialog-cancel" onClick={closeOverride}>
              {t("saf_cancel")}
            </button>
            <button
              type="submit"
              className="primary-button safety-dialog-submit"
              data-testid="safety-override-submit"
              disabled={submitting}
            >
              {t("saf_override_submit")}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
