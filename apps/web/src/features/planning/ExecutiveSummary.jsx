import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { AT_RISK_LEVELS, signedPercent } from "../../shared/hooks/useSnapshot.js";
import { ShieldCheck } from "lucide-react";

// Teardown v4 R1: the summary reads the same outlook as the rest of Rencana
// (/api/baseline/today or its what-if). Its extra-truck figure is the tonnage above
// the normal day in the at-risk kecamatan, and the backend clamps it to the pilot
// fleet's reserve: what cannot be fielded is stated as a shortfall, never "+300 trucks".
export function ExecutiveSummary({ outlook, snapshot, queue }) {
  const { lang, t } = useLanguage();
  const locale = localeFor(lang);
  const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
  const fill = (key, values) =>
    Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), t(key));
  const [impact, setImpact] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/reports/executive-summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setImpact(data?.queue_impact || null);
      })
      .catch(() => {
        if (!cancelled) setImpact(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = outlook?.kecamatan || [];
  // Teardown v3 N2: the headline kecamatan is the largest increase among those really
  // at risk (high or critical vs the normal day, engine.spike_risk), if any.
  const atRisk = rows.filter((row) => AT_RISK_LEVELS.includes(row.risk_level));
  const peak = atRisk.reduce(
    (best, row) =>
      !best || row.predicted_tons - row.normal_tons > best.predicted_tons - best.normal_tons ? row : best,
    null,
  );
  const rec = outlook?.recommendation;
  const deviation = snapshot?.alerts?.find(
    (alert) => alert.type === "route_deviation" && alert.status === "active",
  );
  const routeName = deviation?.recommended_routes?.[0]?.name;
  // The backend names routes in English ("Route B - Daan Mogot Recovery"): localise the two words.
  const route = routeName
    ?.replace(/^Route /i, `${t("ufx_exec_route_word")} `)
    .replace("Recovery", t("ufx_exec_route_recovery"));
  const hasQueue =
    queue?.estimated_wait_minutes != null && Number.isFinite(Number(queue.estimated_wait_minutes));
  const wait = queue?.estimated_wait_minutes;
  const queueDelayed = hasQueue && Number(wait) >= 45;
  // The "before" arm is the assumed current practice (departure SD), as in the PDF.
  const baselineSd = Number(impact?.minutes_per_truck?.baseline_departure_sd_minutes);
  const headline = !outlook
    ? t("exec_headline_none")
    : peak
      ? fill("exec_headline_peak", { district: peak.kecamatan })
      : t("ufx_exec_headline_not_elevated");
  const points = [];
  if (peak && rec) {
    points.push(
      fill("w10num_exec_point_peak", {
        pct: signedPercent(peak.spike_percent),
        district: peak.kecamatan,
        n: atRisk.length,
      }),
    );
    points.push(
      rec.shortfall_trucks > 0
        ? fill("w10num_exec_point_shortfall", {
            reserve: number(rec.fleet_reserve),
            short: number(rec.shortfall_trucks),
          })
        : fill("w10num_exec_point_covered", {
            deploy: number(rec.deployable_trucks),
            reserve: number(rec.fleet_reserve),
          }),
    );
  } else if (outlook) {
    points.push(t("w10num_exec_point_normal"));
  }
  if (deviation) {
    points.push(
      route
        ? fill("exec_point_deviation_route", { truck: deviation.truck_code, route })
        : fill("exec_point_deviation", { truck: deviation.truck_code }),
    );
  }
  if (hasQueue) {
    points.push(fill(queueDelayed ? "exec_point_queue_delayed" : "exec_point_queue", { n: number(wait) }));
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("exec_title")}</h2>
          <p>{t("exec_sub")}</p>
        </div>
        <div className="panel-header-icon-wrap">
          <ShieldCheck size={18} />
        </div>
      </div>
      <h3 data-testid="exec-headline">{headline}</h3>
      {outlook?.kind === "scenario" && (
        <p className="exec-scenario-note">
          <span className="scenario-badge">{t("w10num_scenario_badge")}</span>{" "}
          {t("w10num_exec_scenario_note")}
        </p>
      )}
      {points.length > 0 && (
        <ul>
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      )}
      <div className="queue-box">
        <strong>{t("exec_queue_title")}</strong>
        {hasQueue ? (
          <>
            <span>
              {queue.trucks_waiting != null
                ? `${fill("exec_queue_waiting", { n: number(queue.trucks_waiting) })} · `
                : ""}
              {fill("exec_queue_wait", { n: number(wait) })}
            </span>
            <p>{t(queueDelayed ? "exec_queue_advice_delayed" : "exec_queue_advice_clear")}</p>
          </>
        ) : (
          <p>{t("exec_queue_none")}</p>
        )}
      </div>
      {impact && (
        <div className="exec-impact">
          <div className="exec-impact-head">
            <strong>{t("exec_impact_title")}</strong>
          </div>
          <div className="exec-impact-grid">
            <div className="exec-impact-col">
              <span className="exec-impact-label" data-testid="exec-impact-baseline">
                {Number.isFinite(baselineSd)
                  ? fill("exec_impact_baseline", { sd: number(baselineSd) })
                  : t("ufx_exec_impact_baseline_nosd")}
              </span>
              <strong>
                {fill("exec_impact_value", {
                  trucks: number(impact.baseline_queue_trucks),
                  wait: number(impact.baseline_wait_minutes),
                })}
              </strong>
              <small>{fill("exec_impact_p95", { n: number(impact.baseline_p95_minutes) })}</small>
            </div>
            <div className="exec-impact-arrow" aria-hidden="true">
              →
            </div>
            <div className="exec-impact-col">
              <span className="exec-impact-label">{t("exec_impact_staggered")}</span>
              <strong>
                {fill("exec_impact_value", {
                  trucks: number(impact.optimized_queue_trucks),
                  wait: number(impact.optimized_wait_minutes),
                })}
              </strong>
              <small>{fill("exec_impact_p95", { n: number(impact.optimized_p95_minutes) })}</small>
            </div>
            <div className="exec-impact-delta">
              <strong>{fill("exec_impact_delta", { n: number(impact.queue_reduction_percent) })}</strong>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
