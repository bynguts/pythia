import { useState } from "react";
import { fleetDenominator } from "../../shared/hooks/useBaseline.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Search } from "lucide-react";

const ACTIVE_STATUSES = ["active", "deviation"];

export function FleetTable({ trucks, onOpenTripHistory }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [showAll, setShowAll] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const term = searchTerm.toLowerCase();
  const filtered = trucks.filter(
    (truck) =>
      truck.truck_code?.toLowerCase().includes(term) ||
      truck.driver_name?.toLowerCase().includes(term) ||
      truck.plate_number?.toLowerCase().includes(term) ||
      truck.assigned_zone?.toLowerCase().includes(term),
  );
  const shown = showAll ? filtered : filtered.slice(0, 12);
  const damagedCount = trucks.filter((truck) => truck.is_damaged).length;
  const violationCount = trucks.filter((truck) => truck.deviation?.violated).length;
  // Teardown v4 F4: one denominator ("52 aktif / 59 unit"), the Fleet KPI's basis, and
  // honest freshness: the fleet is simulated and the snapshot refreshes every 8 s.
  const fleet = {
    active: trucks.filter((truck) => ACTIVE_STATUSES.includes(truck.status)).length,
    total: trucks.length,
  };
  const distance = (meters) =>
    meters >= 1000
      ? `${(meters / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} km`
      : `${Math.round(meters)} m`;

  return (
    <section className="panel wide">
      <div className="panel-title">
        <div>
          <h2>{t("ft_title")}</h2>
          <p data-testid="fleet-table-summary">
            <strong data-testid="fleet-table-denominator">{fleetDenominator(t, fleet)}</strong> ·{" "}
            {t("w10num_ft_summary")
              .replace("{damaged}", damagedCount)
              .replace("{deviations}", violationCount)}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div className="input-shell" style={{ width: "220px", height: "36px" }}>
            <Search size={14} />
            <input
              type="text"
              placeholder={t("ft_search")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ fontSize: "12.5px" }}
            />
          </div>
        </div>
      </div>
      <div className="table-wrap fleet-table-wrap">
        <table className="fleet-state-table" aria-label={t("w10num_ft_table_label")}>
          <thead>
            <tr>
              <th scope="col" style={{ width: "18%" }}>
                {t("ft_th_truck")}
              </th>
              <th scope="col" style={{ width: "16%" }}>
                {t("ft_th_driver")}
              </th>
              <th scope="col" style={{ width: "14%" }}>
                {t("ft_th_zone")}
              </th>
              <th scope="col" style={{ width: "16%" }}>
                {t("ft_th_comp")}
              </th>
              <th scope="col" style={{ width: "16%" }}>
                {t("ft_th_activity")}
              </th>
              <th scope="col" style={{ width: "10%" }}>
                {t("ft_th_speed")}
              </th>
              <th scope="col" style={{ width: "10%" }}>
                {t("ft_th_action")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "32px", color: "var(--ui-muted)" }}>
                  {t("w10num_ft_no_match").replace("{q}", searchTerm)}
                </td>
              </tr>
            ) : (
              shown.map((truck) => {
                const isViolation = Boolean(truck.deviation?.violated);
                const isBreakdown = Boolean(truck.is_damaged);
                const complianceTone = isViolation ? "danger" : isBreakdown ? "warning" : "success";
                const complianceLabel = isViolation
                  ? t("w10num_ft_violation").replace("{d}", distance(truck.deviation.distance_meters))
                  : isBreakdown
                    ? t(
                        truck.damage_status?.state === "breakdown"
                          ? "w10num_ft_breakdown"
                          : "w10num_ft_maintenance",
                      )
                    : t("w10num_ft_compliant");
                const activity = truck.activity?.state;
                const activityLabel = activity
                  ? t(`w10num_act_${activity}`) === `w10num_act_${activity}`
                    ? truck.activity.label
                    : t(`w10num_act_${activity}`)
                  : t("w10num_act_idle");

                return (
                  <tr key={truck.truck_code}>
                    <td>
                      <div
                        className="truck-cell"
                        style={{ display: "flex", alignItems: "center", gap: "8px" }}
                      >
                        <strong className="plate-badge">{truck.truck_code}</strong>
                        <span
                          style={{
                            fontSize: "11.5px",
                            color: "var(--ui-muted)",
                            fontFamily: "var(--mono, monospace)",
                          }}
                        >
                          {truck.plate_number}
                        </span>
                      </div>
                    </td>
                    <td className="driver-name-cell">
                      <strong style={{ color: "var(--ui-ink)", fontWeight: 600 }}>{truck.driver_name}</strong>
                    </td>
                    <td>
                      <span className="zone-tag">{truck.assigned_zone}</span>
                    </td>
                    <td>
                      <span className={`pill ${complianceTone}`}>
                        <span className={`status-dot ${complianceTone}`} />
                        {complianceLabel}
                      </span>
                    </td>
                    <td>
                      <div
                        className="activity-cell"
                        style={{ display: "flex", alignItems: "center", gap: "6px" }}
                      >
                        <span
                          className={`activity-dot ${isViolation ? "danger" : isBreakdown ? "warning" : "active"}`}
                        />
                        <span style={{ fontSize: "12.5px" }}>{activityLabel}</span>
                      </div>
                    </td>
                    <td className="speed-cell">
                      <span className="speed-badge">{truck.latest_position?.speed_kmh || 0} km/h</span>
                    </td>
                    <td>
                      <button
                        className="text-button"
                        type="button"
                        aria-label={t("w10num_ft_history_aria").replace("{code}", truck.truck_code)}
                        onClick={() => onOpenTripHistory?.(truck.truck_code)}
                        style={{ height: "30px", padding: "0 10px", fontSize: "12px" }}
                      >
                        {t("btn_trip_history")}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > 12 && (
        <div style={{ marginTop: "12px", display: "flex", justifyContent: "center" }}>
          <button className="text-button show-more-btn" onClick={() => setShowAll(!showAll)}>
            {showAll ? t("w10num_show_fewer") : t("w10num_ft_show_all").replace("{n}", filtered.length)}
          </button>
        </div>
      )}
    </section>
  );
}
