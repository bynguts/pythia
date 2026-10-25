import { useState, useEffect } from "react";
import { apiFetch } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Factory } from "lucide-react";

const SEVERITY_COLOR = { critical: "#b91c1c", watch: "#92400e", ok: "#15803d", unknown: "#475569" };

// Teardown v4 T1/P4: the demand is today's baseline (outlook=true), the same
// kecamatan tonnes the forecast tab prints; every label comes from the locale.
export function FacilityGapPanel() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    setLoading(true);
    apiFetch("/facilities/gap-analysis?outlook=true", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => {
        clearTimeout(timer);
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const areas = data?.areas || [];
  const summary = data?.summary || {};
  const shown = showAll ? areas : areas.slice(0, 6);
  const number = (value) => (value == null ? "?" : Number(value).toLocaleString(locale));

  return (
    <section className="panel wide facility-gap-panel" data-testid="facility-gap-panel">
      <div className="panel-title">
        <div>
          <h2>{t("w10num_fac_title")}</h2>
          <p>
            <span className="classification-badge proxy">{t("w10num_badge_proxy")}</span>{" "}
            {t("w10num_fac_sub")}
          </p>
        </div>
        <div className="panel-header-icon-wrap">
          <Factory size={18} />
        </div>
      </div>

      {loading && <p className="panel-loading">{t("w10num_fac_loading")}</p>}
      {!loading && !data && <p className="panel-loading">{t("w10num_fac_unavailable")}</p>}

      {data && (
        <>
          <div className="facility-summary">
            <div>
              <b>{summary.critical_count}</b>
              <span>{t("w10num_fac_critical")}</span>
            </div>
            <div>
              <b>{number(summary.total_gap_ton_per_day)} t</b>
              <span>{t("w10num_fac_gap")}</span>
            </div>
            <div>
              <b>{summary.total_extra_trucks_needed}</b>
              <span>{t("w10num_fac_trips")}</span>
            </div>
            <div>
              <b>{summary.total_new_tps_sites_needed}</b>
              <span>{t("w10num_fac_sites")}</span>
            </div>
            <div>
              <b>{Math.round((summary.citywide_proxy_coverage_ratio || 0) * 100)}%</b>
              <span>{t("w10num_fac_coverage")}</span>
            </div>
          </div>

          <div className="facility-list">
            {shown.map((a) => (
              <article key={a.slug} className="facility-row">
                <div className="facility-head">
                  <strong>{a.kecamatan}</strong>
                  <span className="facility-sev" style={{ color: SEVERITY_COLOR[a.severity] }}>
                    {t(`w10num_fac_sev_${a.severity}`)}
                  </span>
                </div>
                <div className="facility-meta">
                  <span>
                    {t("w10num_fac_row_demand")
                      .replace("{t}", number(a.predicted_tons_per_day))
                      .replace("{cap}", number(a.tps_capacity_proxy_ton_per_day))}
                  </span>
                  <span>
                    {t("w10num_fac_row_gap")
                      .replace("{gap}", number(a.gap_ton_per_day))
                      .replace("{trips}", a.recommended_extra_trips_per_day)
                      .replace("{sites}", a.recommended_new_tps_sites)}
                  </span>
                </div>
                {a.siting_candidates?.length > 0 && (
                  <div className="facility-siting">
                    {t("w10num_fac_site_near")}{" "}
                    {a.siting_candidates
                      .map((c) =>
                        t("w10num_fac_site_item")
                          .replace("{name}", c.kelurahan)
                          .replace("{t}", number(c.predicted_tons))
                          .replace("{n}", c.existing_tps_sites),
                      )
                      .join(" · ")}
                  </div>
                )}
              </article>
            ))}
          </div>

          {areas.length > 6 && (
            <button className="text-button show-more-btn" onClick={() => setShowAll(!showAll)}>
              {showAll ? t("w10num_show_fewer") : t("w10num_show_all_kec").replace("{n}", areas.length)}
            </button>
          )}
          <p className="kec-note">
            {data.assumptions?.coverage_code === "tps_proxy_partial_coverage"
              ? t("w10num_fac_coverage_note")
              : data.assumptions?.coverage_note}
          </p>
        </>
      )}
    </section>
  );
}
