import { useEffect, useRef } from "react";
import { ArrowLeft, CircleCheck, Cloud, CloudOff, LogOut } from "lucide-react";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { SyncChip } from "./DriverPanels.jsx";
import { clockTime, receiptWeightRows } from "./driverHelpers.js";
import { shortSpjNumber } from "./RouteOverview.jsx";

const WEIGHT_ROW_NAMES = { gross_weight_kg: "gross", tare_weight_kg: "tare", net_weight_kg: "net" };

function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// H10: gross, tare and net exactly as recorded; one row per weight_labels key,
// and a weight the server did not record says so instead of showing a number.
export function ReceiptWeights({ receipt }) {
  const { t, lang } = useLanguage();
  const rows = receiptWeightRows(receipt);
  if (rows.length === 0) return null;
  return (
    <dl className="drt-receipt-weights" data-testid="receipt-weights">
      {rows.map((row) => {
        const name = WEIGHT_ROW_NAMES[row.key];
        return (
          <div key={row.key} data-testid={`receipt-weight-${name}`} title={t(`drv7_weight_${name}_desc`)}>
            <dt>{t(`drv7_weight_${name}`)}</dt>
            <dd>
              {row.kg === null
                ? t("drv7_weight_not_recorded")
                : `${row.kg.toLocaleString(localeFor(lang))} kg`}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function receiptKg(receipt) {
  const net = Number(receipt?.net_weight_kg);
  return receipt?.net_weight_kg != null && Number.isFinite(net) ? net : null;
}

// pIpBP: today's shift on this truck from the server's closed work orders:
// trips, net tonnes delivered (only recorded nets are summed), duty time
// (observed or simulated, labelled), stops, and whether the phone holds
// anything unsent. `receipt` is the receipt just recorded (null while queued).
export function ShiftSummary({
  history,
  receipt,
  spjId,
  safety,
  online,
  pending,
  flushing,
  lastSync,
  onBack,
  onSignOut,
}) {
  const { t, lang } = useLanguage();
  const backRef = useRef(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const today = localDay();
  const todays = (history || []).filter((s) => s.date === today || s.spj_id === spjId);
  const nets = todays.map((s) => receiptKg(s.spj_id === spjId && receipt ? receipt : s.receipt));
  const delivered = nets.some((kg) => kg !== null) ? nets.reduce((sum, kg) => sum + (kg || 0), 0) : null;
  const stopsTotal = todays.reduce((sum, s) => sum + (s.stops?.length || 0), 0);
  const stopsDone = todays.reduce(
    (sum, s) => sum + (s.stops || []).filter((stop) => stop.status === "completed").length,
    0,
  );
  const duty = Number.isFinite(Number(safety?.duty_minutes)) ? Number(safety.duty_minutes) : null;
  const dutySimulated = String(safety?.classification || "").startsWith("SIMULATED");
  const fmt = (n, digits = 0) =>
    Number(n).toLocaleString(localeFor(lang), {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  const syncTime = clockTime(lastSync);

  return (
    <div
      className="drt-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drt-summary-title"
      data-testid="done-screen"
    >
      <header className="drt-head">
        <button
          ref={backRef}
          type="button"
          className="drt-icon-btn drt-back"
          onClick={onBack}
          aria-label={t("drv_done_back")}
          data-testid="done-back"
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <p className="drt-head-title">{t("d2_summary_title")}</p>
        <SyncChip online={online} pending={pending} flushing={flushing} />
      </header>

      <div className="drt-layer-body">
        <h1 className="drt-h1 is-summary" id="drt-summary-title">
          {t("d2_summary_heading")}
        </h1>

        <div className="drt-stats">
          <div className="drt-stat" data-testid="summary-trips">
            <span>{t("d2_summary_trips")}</span>
            <strong>{fmt(todays.length)}</strong>
          </div>
          <div className="drt-stat" data-testid="summary-delivered" title={t("d2_summary_delivered_tip")}>
            <span>{t("d2_summary_delivered")}</span>
            <strong>{delivered === null ? "—" : `${fmt(delivered / 1000, 1)} t`}</strong>
          </div>
          <div
            className="drt-stat"
            data-testid="summary-duty"
            data-provenance={dutySimulated ? "simulated" : undefined}
            title={dutySimulated ? safety?.label || t("drv6_safety_class_simulated") : undefined}
          >
            <span>{t("d2_summary_duty")}</span>
            <strong>
              {duty === null
                ? "—"
                : t("d2_summary_duty_value")
                    .replace("{h}", Math.floor(duty / 60))
                    .replace("{m}", String(duty % 60).padStart(2, "0"))}
            </strong>
          </div>
          <div className="drt-stat" data-testid="summary-stops">
            <span>{t("d2_summary_stops")}</span>
            <strong>
              {stopsTotal === 0
                ? "—"
                : t("d2_summary_stops_value").replace("{done}", stopsDone).replace("{total}", stopsTotal)}
            </strong>
          </div>
        </div>

        {pending > 0 ? (
          <div className="drt-sent is-pending" role="status" data-testid="summary-sync">
            <CloudOff size={20} aria-hidden="true" />
            <div>
              <strong>{t("d2_summary_pending").replace("{n}", pending)}</strong>
              <small>{t("d2_summary_pending_desc")}</small>
            </div>
          </div>
        ) : (
          <div className="drt-sent" role="status" data-testid="summary-sync">
            <Cloud size={20} aria-hidden="true" />
            <div>
              <strong>{t("d2_summary_sent")}</strong>
              <small>
                {syncTime
                  ? t("d2_summary_sent_desc").replace("{time}", syncTime)
                  : t("d2_summary_sent_desc_never")}
              </small>
            </div>
          </div>
        )}

        <section className="drt-list" aria-labelledby="drt-closed-title">
          <h2 className="drt-list-head" id="drt-closed-title">
            {t("d2_summary_closed")}
          </h2>
          {todays.length === 0 ? (
            <p className="drt-note is-in-list">{t("d2_summary_closed_empty")}</p>
          ) : (
            <ul>
              {todays.map((s) => {
                const kg = receiptKg(s.spj_id === spjId && receipt ? receipt : s.receipt);
                const stops = s.stops?.length || 0;
                return (
                  <li key={s.spj_id} data-testid={`summary-spj-${s.spj_id}`}>
                    <CircleCheck size={18} aria-hidden="true" />
                    <div className="drt-list-text is-bold">
                      <strong title={s.spj_number}>{shortSpjNumber(s.spj_number)}</strong>
                      <small>
                        {[t("d2_summary_stops_n").replace("{n}", stops), kg === null ? null : `${fmt(kg)} kg`]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </div>
                    <span className="drt-list-time">{clockTime(s.completed_at) || ""}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {spjId && (
          <section className="drt-card" aria-label={t("drv_receipt_title")}>
            <p className="drt-step-title">{t("d2_summary_this_ticket")}</p>
            {receipt ? (
              <ReceiptWeights receipt={receipt} />
            ) : (
              <p className="drt-note" data-testid="receipt-weights-pending">
                {t("drv7_receipt_weights_pending")}
              </p>
            )}
          </section>
        )}
      </div>

      {onSignOut && (
        <div className="drt-layer-foot">
          <button type="button" className="drt-btn is-secondary" data-testid="end-shift" onClick={onSignOut}>
            <LogOut size={18} aria-hidden="true" /> {t("d2_summary_end")}
          </button>
        </div>
      )}
    </div>
  );
}
