import { useEffect, useState } from "react";
import { CheckCircle2, Route, Wrench } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { formatDriverName } from "../../shared/format/driverName.js";
import { ListRow } from "../../shared/ui/ListRow.jsx";
import { MetricStrip } from "../../shared/ui/MetricStrip.jsx";
import "./drivers.css";

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
}

export function DriverAnalytics() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    let controller;
    async function load() {
      controller?.abort();
      controller = new AbortController();
      try {
        const payload = await apiGet("/fleet/driver-analytics", { signal: controller.signal });
        if (
          !Array.isArray(payload.drivers) ||
          !Number.isFinite(Date.parse(payload.sampled_at)) ||
          !payload.provenance?.id ||
          !payload.provenance?.en ||
          !payload.source
        ) {
          throw new Error("Invalid driver analytics response");
        }
        if (!active) return;
        setData(payload);
        setError(false);
        setNow(Date.now());
      } catch (reason) {
        if (active && reason.name !== "AbortError") setError(true);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    const interval = setInterval(() => {
      setNow(Date.now());
      load();
    }, 15000);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(interval);
    };
  }, [refreshKey]);

  const drivers = data?.drivers || [];
  const stale = Boolean(data && (error || now - Date.parse(data.sampled_at) > 30000));
  const deviations = drivers.filter((driver) => driver.deviation_violated);
  const damaged = drivers.filter((driver) => driver.is_damaged);
  // Drivers: the attention rail lists every flagged unit, the widest deviation first,
  // then damaged units; its first row is the old single "operational priority".
  const flagged = [
    ...[...deviations].sort((a, b) => (b.deviation_meters ?? 0) - (a.deviation_meters ?? 0)),
    ...damaged.filter((driver) => !driver.deviation_violated),
  ];
  // Teardown v4 D2: corridor distances read in km ("26,1 km"), never "26.108 m".
  const distance = (value) =>
    Number.isFinite(value)
      ? value >= 1000
        ? `${(value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} km`
        : `${Math.round(value).toLocaleString(locale)} m`
      : t("w10num_drv_unavailable");
  // The one fleet denominator (Fleet KPI, Prediksi, Rencana): on duty out of all units.
  const fleet = {
    active: drivers.filter((driver) => ["active", "deviation"].includes(driver.status)).length,
    total: drivers.length,
  };
  // The denominator keeps the one shared template; only the active count is drawn large.
  const [denominatorLead, denominatorTail] = t("w10num_fleet_denominator")
    .replace("{total}", fleet.total)
    .split("{active}");
  const metrics = [
    {
      label: t("w10num_fleet_pilot"),
      value: (
        <span data-testid="drivers-fleet-denominator">
          {denominatorLead}
          {fleet.active}
          <em className="metric-unit">{denominatorTail}</em>
        </span>
      ),
      source: t("set11_drv_prov_fleet"),
      sourceKind: "sim",
    },
    {
      label: t("w10num_drv_named"),
      value: (
        <span data-testid="drivers-named-count">
          {new Set(drivers.map((driver) => driver.driver_name)).size}
        </span>
      ),
      source: t("honesty_sim_badge"),
      sourceKind: "sim",
    },
    {
      label: t("w10num_drv_deviations"),
      value: deviations.length,
      source: t("set11_drv_prov_detector"),
      sourceKind: "proxy",
      tone: deviations.length ? "danger" : undefined,
    },
    {
      label: t("w10num_drv_damaged"),
      value: damaged.length,
      source: t("honesty_sim_badge"),
      sourceKind: "sim",
      tone: damaged.length ? "warning" : undefined,
    },
  ];

  return (
    <section className="driver-workspace workspace-page" data-testid="drivers-workspace">
      <header className="drv-heading">
        <div>
          <h1>{t("w10num_drv_title")}</h1>
          <p>{t("w10num_drv_sub")}</p>
        </div>
        {data && (
          <div className={`drv-freshness${stale ? " is-stale" : ""}`} role="status">
            {stale ? (
              <span className="prov prov-stale">{t("w10num_drv_stale")}</span>
            ) : (
              <span>{t("w10num_drv_snapshot")}</span>
            )}
            <time dateTime={data.sampled_at}>
              {new Date(data.sampled_at).toLocaleTimeString(locale, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </time>
          </div>
        )}
      </header>

      {loading && !data && (
        <p className="drv-state" role="status">
          {t("w10num_drv_loading")}
        </p>
      )}
      {error && (
        <div className="drv-state is-bad" role="alert">
          <p>{t(data ? "w10num_drv_refresh_failed" : "w10num_drv_load_failed")}</p>
          <button type="button" className="ghost-button" onClick={() => setRefreshKey((key) => key + 1)}>
            {t("w10num_drv_retry")}
          </button>
        </div>
      )}
      {data && (
        <>
          <MetricStrip metrics={metrics} label={t("w10num_drv_title")} />

          <p className="drv-source" data-testid="drivers-provenance">
            <span className="prov prov-sim">{t("honesty_sim_badge")}</span>
            <span>
              {t("w10num_drv_source")} {data.provenance[lang]}
            </span>
          </p>

          {drivers.length === 0 ? (
            <p className="drv-state" role="status">
              {t("w10num_drv_empty")}
            </p>
          ) : (
            <div className="drv-grid">
              <section className="drv-table-surface" aria-labelledby="drv-table-title">
                <div className="drv-surface-head">
                  <h2 id="drv-table-title">{t("w10num_drv_table_title")}</h2>
                  <span className="drv-count">{drivers.length}</span>
                </div>
                <div className="drv-table-wrap">
                  <table className="drv-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("w10num_drv_th_driver")}</th>
                        <th scope="col">{t("w10num_drv_th_vehicle")}</th>
                        <th scope="col">{t("w10num_drv_th_zone")}</th>
                        <th scope="col">{t("w10num_drv_th_condition")}</th>
                        <th scope="col">{t("w10num_drv_th_deviation")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drivers.map((driver) => (
                        <tr
                          key={driver.truck_code}
                          className={driver.deviation_violated || driver.is_damaged ? "needs-attention" : ""}
                        >
                          <td>
                            <span className="drv-person">
                              <i aria-hidden="true">{initials(driver.driver_name)}</i>
                              <strong>{formatDriverName(driver.driver_name, t).label}</strong>
                            </span>
                          </td>
                          <td className="drv-mono">{driver.truck_code}</td>
                          <td>{driver.assigned_zone || "—"}</td>
                          <td>
                            <span className={`drv-dot ${driver.is_damaged ? "is-warning" : "is-good"}`}>
                              {t(driver.is_damaged ? "w10num_drv_damaged_badge" : "w10num_drv_operating")}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`drv-dot ${driver.deviation_violated ? "is-danger" : "is-quiet"}`}
                            >
                              {driver.deviation_violated
                                ? distance(driver.deviation_meters)
                                : t("w10num_drv_none_flagged")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <aside className="drv-rail" aria-labelledby="drv-rail-title" data-testid="drivers-attention">
                <div className="drv-surface-head">
                  <h2 id="drv-rail-title">{t("w10num_drv_priority")}</h2>
                  <span className="drv-count">{flagged.length}</span>
                </div>
                {flagged.length === 0 ? (
                  <p className="drv-rail-empty">
                    <CheckCircle2 size={18} aria-hidden="true" />
                    {t("w10num_drv_priority_none")}
                  </p>
                ) : (
                  <ul className="ui-list" aria-labelledby="drv-rail-title">
                    {flagged.map((driver) => {
                      const off = driver.deviation_violated;
                      return (
                        <ListRow
                          key={driver.truck_code}
                          icon={off ? Route : Wrench}
                          tone={off ? "danger" : "warning"}
                          title={
                            off
                              ? t("set11_drv_row_off_route").replace("{d}", distance(driver.deviation_meters))
                              : t("w10num_drv_damaged_badge")
                          }
                          meta={[
                            driver.truck_code,
                            formatDriverName(driver.driver_name, t).label,
                            driver.assigned_zone,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          action={{ label: t("set11_drv_open_fleet"), onClick: () => navigate("/fleet") }}
                          testId="drivers-attention-row"
                        >
                          <p className="drv-rail-next">
                            {t(off ? "w10num_drv_next_deviation" : "w10num_drv_next_damage")}
                          </p>
                        </ListRow>
                      );
                    })}
                  </ul>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </section>
  );
}
