import { useEffect, useState } from "react";
import { Camera, FileText, ShieldAlert, Scale } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { ListRow } from "../../shared/ui/ListRow.jsx";
import { MetricStrip } from "../../shared/ui/MetricStrip.jsx";

const POLL_MS = 60000;

// The close-of-day recap (GET /api/recap/daily) as a plain list: recorded vs
// planned tonnes, gate wait and incidents, then the evidence gaps and the day's summary.
// A figure the day has not recorded reads "—", never zero.
export function DailyRecapList() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [recap, setRecap] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      apiFetch("/recap/daily", { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.status))))
        .then((body) => {
          setRecap(body);
          setFailed(false);
        })
        .catch((error) => error?.name !== "AbortError" && setFailed(true));
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  if (!recap) {
    return <p className="rail-empty">{t(failed ? "w12_load_failed" : "w12_loading")}</p>;
  }
  const number = (value) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: 1 });
  const signed = (value) => (value == null ? "—" : `${value > 0 ? "+" : ""}${number(value)}`);
  const exceptions = recap.incidents.exceptions;
  const incidents = Object.values(exceptions).reduce((sum, n) => sum + n, 0) + recap.incidents.damage_reports;
  const inApp = t("w12_src_in_app");
  const evidence = [
    { key: "stops_missing_evidence", icon: Camera },
    { key: "overrides", icon: ShieldAlert },
    { key: "receipts_pending_review", icon: Scale },
  ];

  return (
    <div data-testid="recap-list" data-date={recap.date}>
      <MetricStrip
        label={t("w12_recap_title")}
        metrics={[
          {
            label: t("w12_recap_actual"),
            value: number(recap.actual.receipt_tons),
            unit: recap.actual.receipt_tons == null ? null : "t",
            source: inApp,
            helper: t("w12_recap_ritasi").replace("{n}", number(recap.actual.ritasi)),
            testId: "recap-actual",
          },
          {
            label: t("w12_recap_planned"),
            value: number(recap.forecast.planned_tons),
            unit: recap.forecast.planned_tons == null ? null : "t",
            source: t("w10num_badge_model"),
            sourceKind: "model",
            testId: "recap-planned",
          },
          {
            label: t("w12_recap_delta"),
            value: signed(recap.delta.tons),
            unit: recap.delta.tons == null ? null : "t",
            helper: recap.delta.pct == null ? null : `${signed(recap.delta.pct)}%`,
            source: inApp,
            testId: "recap-delta",
          },
          {
            label: t("w12_recap_gate_wait"),
            value: number(recap.gate_wait.median_min),
            unit: recap.gate_wait.median_min == null ? null : t("qm_min"),
            source: inApp,
            helper: t("w12_recap_gate_wait_n").replace("{n}", number(recap.gate_wait.observed_n)),
            testId: "recap-gate-wait",
          },
          {
            label: t("w12_recap_incidents"),
            value: number(incidents),
            source: inApp,
            helper: t("w12_recap_incidents_helper")
              .replace("{closed}", number(exceptions.road_closed))
              .replace("{breakdown}", number(exceptions.truck_breakdown))
              .replace("{damage}", number(recap.incidents.damage_reports)),
            testId: "recap-incidents",
          },
        ]}
      />
      <ul className="ui-list">
        {evidence.map(({ key, icon }) => (
          <ListRow
            key={key}
            icon={icon}
            tone={recap.evidence[key] ? "warning" : "neutral"}
            title={t(`w12_recap_${key}`).replace("{n}", number(recap.evidence[key]))}
            testId="recap-evidence-row"
          />
        ))}
        <ListRow
          icon={FileText}
          tone="info"
          title={t("w12_recap_summary")}
          meta={recap.summary[lang] || recap.summary.id}
          testId="recap-summary"
        />
      </ul>
    </div>
  );
}
