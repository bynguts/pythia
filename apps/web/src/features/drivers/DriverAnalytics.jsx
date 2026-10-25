import { useEffect, useState } from "react";
import { AlertTriangle, Clock3, Route, Truck, Users, Wrench } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { fleetDenominator } from "../../shared/hooks/useBaseline.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";

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
  const priority =
    deviations.reduce(
      (worst, driver) =>
        !worst || (driver.deviation_meters ?? 0) > (worst.deviation_meters ?? 0) ? driver : worst,
      null,
    ) || damaged[0];
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

  return (
    <section className="driver-workspace workspace-page">
      <header className="workspace-heading">
        <div>
          <h1>{t("w10num_drv_title")}</h1>
          <p>{t("w10num_drv_sub")}</p>
        </div>
        {data && (
          <div className="workspace-freshness" role="status">
            <Clock3 size={16} />
            <span>{t(stale ? "w10num_drv_stale" : "w10num_drv_snapshot")}</span>
            <strong>
              <time dateTime={data.sampled_at}>
                {new Date(data.sampled_at).toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
            </strong>
          </div>
        )}
      </header>

      {loading && !data && <p role="status">{t("w10num_drv_loading")}</p>}
      {error && (
        <div role="alert">
          <p>{t(data ? "w10num_drv_refresh_failed" : "w10num_drv_load_failed")}</p>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>
            {t("w10num_drv_retry")}
          </button>
        </div>
      )}
      {data && (
        <>
          <p className="workspace-data-note">
            <span className="pill provenance-sim">{t("honesty_sim_badge")}</span> {t("w10num_drv_source")}{" "}
            {data.provenance[lang]}
          </p>
          <div className="driver-metric-strip">
            <div>
              <Truck size={18} />
              <span>
                {t("w10num_fleet_pilot")}
                <strong data-testid="drivers-fleet-denominator">{fleetDenominator(t, fleet)}</strong>
              </span>
            </div>
            <div>
              <Users size={18} />
              <span>
                {t("w10num_drv_named")}
                <strong data-testid="drivers-named-count">
                  {new Set(drivers.map((driver) => driver.driver_name)).size}
                </strong>
              </span>
            </div>
            <div>
              <Route size={18} />
              <span>
                {t("w10num_drv_deviations")}
                <strong>{deviations.length}</strong>
              </span>
            </div>
            <div>
              <Wrench size={18} />
              <span>
                {t("w10num_drv_damaged")}
                <strong>{damaged.length}</strong>
              </span>
            </div>
          </div>

          {drivers.length === 0 ? (
            <p role="status">{t("w10num_drv_empty")}</p>
          ) : (
            <div className="driver-command-grid">
              <section className="driver-table-surface">
                <div className="section-intro compact">
                  <div>
                    <h2>{t("w10num_drv_table_title")}</h2>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="driver-table">
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
                            <span className="driver-person">
                              <i aria-hidden="true">{initials(driver.driver_name)}</i>
                              <strong>{driver.driver_name}</strong>
                            </span>
                          </td>
                          <td>
                            <code>{driver.truck_code}</code>
                          </td>
                          <td>{driver.assigned_zone || "—"}</td>
                          <td>
                            <span className={`deviation-badge ${driver.is_damaged ? "danger" : "success"}`}>
                              {t(driver.is_damaged ? "w10num_drv_damaged_badge" : "w10num_drv_operating")}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`deviation-badge ${driver.deviation_violated ? "warning" : "success"}`}
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

              <aside className="driver-attention-rail">
                <span className="attention-icon">
                  <AlertTriangle size={19} />
                </span>
                <h2>{t("w10num_drv_priority")}</h2>
                {priority ? (
                  <>
                    <p>
                      {priority.driver_name} · {priority.truck_code}
                    </p>
                    <p>
                      {priority.deviation_violated
                        ? t("w10num_drv_priority_deviation").replace(
                            "{d}",
                            distance(priority.deviation_meters),
                          )
                        : t("w10num_drv_priority_damage")}
                    </p>
                    <div className="attention-note">
                      <strong>{t("w10num_drv_next_step")}</strong>
                      <span>
                        {t(
                          priority.deviation_violated
                            ? "w10num_drv_next_deviation"
                            : "w10num_drv_next_damage",
                        )}
                      </span>
                    </div>
                  </>
                ) : (
                  <p>{t("w10num_drv_priority_none")}</p>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </section>
  );
}
