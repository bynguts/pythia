import { useEffect, useState } from "react";
import { History, Play, Search, Square, X } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { formatDriverName } from "../../shared/format/driverName.js";
import { ActionCard } from "./ActionCard.jsx";
import { FleetHistoryPanel } from "./FleetHistoryPanel.jsx";
import { formatDistance } from "./decisionRoute.js";
import { TruckExceptions } from "./DriverExceptionAlerts.jsx";

const PAGE = 12;
const ACTIVE_STATUSES = ["active", "deviation"];

// One predicate per filter chip, so a chip's count is exactly the rows it shows (F3).
export const TRUCK_FILTERS = {
  all: () => true,
  active: (truck) => ACTIVE_STATUSES.includes(truck.status),
  deviation: (truck) => Boolean(truck.deviation?.violated),
  workshop: (truck) => Boolean(truck.is_damaged),
};

function truckTone(truck) {
  if (truck.deviation?.violated) return "danger";
  if (truck.is_damaged) return "warning";
  return "success";
}

function activityLabel(t, truck) {
  const state = truck.activity?.state;
  const key = `w10num_act_${state || "idle"}`;
  return t(key) !== key ? t(key) : truck.activity?.label || "";
}

// Teardown v4 P0-5 "Truk": two-line rows (status, code + plate, activity · zone, age).
export function TruckList({ trucks, filter, onFilter, onOpen }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const term = query.trim().toLowerCase();
  const rows = trucks.filter(TRUCK_FILTERS[filter] || TRUCK_FILTERS.all).filter(
    (truck) =>
      !term ||
      [truck.truck_code, truck.plate_number, truck.driver_name, truck.assigned_zone].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(term),
      ),
  );
  const shown = showAll ? rows : rows.slice(0, PAGE);

  return (
    <div className="truck-list-panel" data-testid="truck-list">
      <div className="rail-chips" role="group" aria-label={t("w10fleet_filter_label")}>
        {Object.keys(TRUCK_FILTERS).map((id) => (
          <button
            key={id}
            type="button"
            className="rail-chip"
            aria-pressed={filter === id}
            data-testid={`truck-filter-${id}`}
            onClick={() => onFilter(id)}
          >
            {t(`w10fleet_filter_${id}`)} <b>{trucks.filter(TRUCK_FILTERS[id]).length}</b>
          </button>
        ))}
      </div>
      <label className="rail-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">{t("w10fleet_search")}</span>
        <input
          type="search"
          value={query}
          placeholder={t("w10fleet_search")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p className="rail-note">{t("w10fleet_list_sim")}</p>
      {rows.length === 0 ? (
        <p className="rail-empty">{t("w10fleet_list_empty")}</p>
      ) : (
        <ul className="truck-rows">
          {shown.map((truck) => {
            const age = truck.latest_position?.updated_seconds_ago;
            return (
              <li key={truck.truck_code}>
                <button
                  type="button"
                  className="truck-row"
                  data-testid="truck-row"
                  data-truck={truck.truck_code}
                  aria-label={t("w10fleet_open_truck_aria").replace("{code}", truck.truck_code)}
                  onClick={() => onOpen(truck.truck_code)}
                >
                  <span className={`status-dot ${truckTone(truck)}`} />
                  <span className="truck-row-main">
                    <span className="truck-row-id">
                      <b className="mono-id">{truck.truck_code}</b>
                      <span className="mono-id">{truck.plate_number}</span>
                    </span>
                    <span className="truck-row-sub">
                      {activityLabel(t, truck)} · {truck.assigned_zone}
                    </span>
                  </span>
                  {age != null && (
                    <span className="truck-row-age">{t("w10fleet_age_s").replace("{n}", age)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > PAGE && (
        <button type="button" className="ghost-button rail-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? t("w10num_show_fewer") : t("w10fleet_show_all").replace("{n}", rows.length)}
        </button>
      )}
    </div>
  );
}

function useTruckRecords(code) {
  const [spj, setSpj] = useState(null);
  const [reports, setReports] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setSpj(null);
    setReports(null);
    apiFetch(`/spj?truck_code=${encodeURIComponent(code)}&limit=5`)
      .then((r) => (r.ok ? r.json() : { spj: [] }))
      .then((body) => !cancelled && setSpj(body.spj || []))
      .catch(() => !cancelled && setSpj([]));
    apiFetch("/damage-reports")
      .then((r) => (r.ok ? r.json() : { reports: [] }))
      .then(
        (body) =>
          !cancelled &&
          setReports((body.reports || []).filter((r) => r.truck_code === code && r.status !== "selesai")),
      )
      .catch(() => !cancelled && setReports([]));
    return () => {
      cancelled = true;
    };
  }, [code]);
  return { spj, reports };
}

// Teardown v4 §9.3: the truck detail opens in place (Sekarang | Riwayat). The decision
// for this truck, when it has one, is the drawer's single primary action.
export function TruckDrawer({
  truck,
  snapshot,
  alert,
  exceptions = [],
  safetyTruck,
  onClose,
  onOpenDrivers,
  playbackTruck,
  canReplay,
  onPlayback,
}) {
  const { t, lang } = useLanguage();
  const [view, setView] = useState("now");
  const { spj, reports } = useTruckRecords(truck.truck_code);
  const activeSpj = (spj || []).find((item) => item.status === "aktif");
  const doneStops = (activeSpj?.stops || []).filter((stop) => stop.status === "completed").length;
  const damage = truck.damage_status;
  const replaying = playbackTruck === truck.truck_code;

  return (
    <section className="truck-drawer" data-testid="truck-drawer" aria-labelledby="truck-drawer-title">
      <header className="truck-drawer-head">
        <div>
          <h3 id="truck-drawer-title">
            <span className="mono-id">{truck.truck_code}</span>{" "}
            <span className="mono-id truck-drawer-plate">{truck.plate_number}</span>
          </h3>
          <p>{formatDriverName(truck.driver_name, t).label}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t("w10fleet_drawer_close")}
          data-testid="truck-drawer-close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className="rail-segment" role="group" aria-label={t("w10fleet_drawer_views")}>
        {["now", "history"].map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            data-testid={`truck-drawer-${id}`}
            onClick={() => setView(id)}
          >
            {t(`w10fleet_drawer_${id}`)}
          </button>
        ))}
      </div>

      {view === "now" ? (
        <div className="truck-drawer-body">
          <section className="drawer-section">
            <h4>{t("w10fleet_sec_status")}</h4>
            <p>
              {activityLabel(t, truck)} ·{" "}
              {t("w10fleet_speed").replace("{n}", truck.latest_position?.speed_kmh ?? 0)}{" "}
              <span className="pill provenance-sim">{t("honesty_sim_badge")}</span>
            </p>
            <p className="drawer-muted">
              {truck.assigned_zone}
              {truck.latest_position?.updated_seconds_ago != null &&
                ` · ${t("w10fleet_updated").replace("{n}", truck.latest_position.updated_seconds_ago)}`}
            </p>
            <p className={truck.deviation?.violated ? "drawer-danger" : "drawer-muted"}>
              {truck.deviation?.violated
                ? t("w10fleet_corridor_off").replace(
                    "{d}",
                    formatDistance(truck.deviation.distance_meters, lang),
                  )
                : t("w10fleet_corridor_on")}
            </p>
          </section>

          <section className="drawer-section" data-testid="drawer-route">
            <h4>{t("w10fleet_sec_route")}</h4>
            {alert ? (
              <ActionCard snapshot={snapshot} alert={alert} />
            ) : (
              <p className="drawer-muted">{t("w10fleet_route_none")}</p>
            )}
          </section>

          <section className="drawer-section" data-testid="drawer-exceptions">
            <h4>{t("w10fleet_sec_exceptions")}</h4>
            <TruckExceptions exceptions={exceptions} />
          </section>

          <section className="drawer-section" data-testid="drawer-spj">
            <h4>{t("w10fleet_sec_spj")}</h4>
            <p className="drawer-muted">
              {spj === null
                ? "…"
                : activeSpj
                  ? t("w10fleet_spj_active")
                      .replace("{number}", activeSpj.spj_number)
                      .replace("{done}", doneStops)
                      .replace("{total}", activeSpj.stops?.length || 0)
                  : t("w10fleet_spj_none")}
            </p>
          </section>

          <section className="drawer-section" data-testid="drawer-damage">
            <h4>{t("w10fleet_sec_damage")}</h4>
            <p className={truck.is_damaged ? "drawer-warning" : "drawer-muted"}>
              {truck.is_damaged
                ? t(damage?.state === "breakdown" ? "w10num_ft_breakdown" : "w10num_ft_maintenance")
                : t("w10fleet_damage_none")}
              {reports?.length > 0 && ` · ${t("w10fleet_damage_reports").replace("{n}", reports.length)}`}
            </p>
          </section>

          <section className="drawer-section" data-testid="drawer-safety">
            <h4>{t("w10fleet_sec_safety")}</h4>
            <p className="drawer-muted">
              {safetyTruck
                ? `${t(`saf_duty_${safetyTruck.duty_state}`)} · ${t("saf_hm")
                    .replace("{h}", String(Math.floor((safetyTruck.duty_minutes || 0) / 60)))
                    .replace("{m}", String(Math.round(safetyTruck.duty_minutes || 0) % 60))}`
                : t("w10fleet_safety_none")}
            </p>
            <button type="button" className="text-button" onClick={onOpenDrivers}>
              {t("w10fleet_safety_open")}
            </button>
          </section>
        </div>
      ) : (
        <div className="truck-drawer-body">
          {canReplay ? (
            <button
              type="button"
              className="ghost-button drawer-replay"
              data-testid="truck-replay"
              onClick={() => onPlayback(replaying ? null : truck.truck_code)}
            >
              {replaying ? <Square size={15} /> : <Play size={15} />}
              {t(replaying ? "w10fleet_replay_close" : "w10fleet_replay")}
            </button>
          ) : (
            <p className="drawer-muted">
              <History size={14} aria-hidden="true" /> {t("w10fleet_replay_none")}
            </p>
          )}
          <FleetHistoryPanel truckCode={truck.truck_code} />
        </div>
      )}
    </section>
  );
}
