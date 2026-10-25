import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { fleetDenominator } from "../../shared/hooks/useBaseline.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { AlertQueue, sortAlerts } from "./AlertQueue.jsx";
import { AStarReroutingPanel } from "./AStarReroutingPanel.jsx";
import { decisionRoute, drawableRoute, formatDistance } from "./decisionRoute.js";
import {
  DriverExceptionAlerts,
  exceptionAlertId,
  useDriverExceptions,
  useHandledExceptions,
} from "./DriverExceptionAlerts.jsx";
import { SafetyPanel, safetyAttentionCount, useSafetyOverview } from "./SafetyPanel.jsx";
import { peakHourText } from "./TpaQueuePanel.jsx";
import { TRUCK_FILTERS, TruckDrawer, TruckList } from "./TruckPanel.jsx";
import { UnlicensedCollectorAlerts } from "./UnlicensedCollectorAlerts.jsx";

const RAIL_TABS = ["action", "trucks", "queue"];
const RECORD_TABS = [
  { id: "spj", key: "w10fleet_tab_spj", surface: "fleet-spj-surface" },
  { id: "damage", key: "tab_damage", surface: "fleet-damage-surface" },
  { id: "safety", key: "saf_tab", surface: "fleet-safety-surface" },
];
const TRIPS_POLL_MS = 30000;

// "Ritase selesai": today's work orders closed in the driver app (SPJ store, Jakarta day).
function useTripsToday() {
  const [trips, setTrips] = useState(null);
  useEffect(() => {
    const load = () =>
      apiFetch("/spj?limit=500")
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!body) return;
          const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
          const issued = (body.spj || []).filter(
            (item) => item.date === today && item.status !== "draft" && item.status !== "batal",
          );
          setTrips({ done: issued.filter((item) => item.status === "selesai").length, total: issued.length });
        })
        .catch(() => {});
    load();
    const id = setInterval(load, TRIPS_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return trips;
}

function deviationMeters(truck) {
  const parsed = Number(truck?.deviation?.distance_meters ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function onTabKeys(event, ids, current, select) {
  const index = ids.indexOf(current);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: ids.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  // Roving tabindex: selection and focus move together.
  const id = ids[(next + ids.length) % ids.length];
  select(id);
  event.currentTarget.parentElement.querySelector(`[data-tab="${id}"]`)?.focus();
}

// Teardown v4 F1–F5 / research P0-5: one flat metric strip, the map large, and a right
// rail (a sheet under the map on phones) with Perlu tindakan · Truk · Antrean TPA.
export function FleetOperations({
  snapshot,
  renderMap,
  mapTools,
  aiEvents,
  jamActive,
  onAckEvent,
  playbackTruck,
  playbackOptions = [],
  onPlayback,
  onWhatsApp,
  onFocusTruck,
  queue,
  spj,
  damage,
}) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const [railTab, setRailTab] = useState("action");
  // undefined = the default decision is open; null = the operator collapsed it.
  const [selectedAlertId, setSelectedAlertId] = useState(undefined);
  const [drawerTruck, setDrawerTruck] = useState(null);
  const [truckFilter, setTruckFilter] = useState("all");
  const [recordTab, setRecordTab] = useState("spj");
  const [toolsOpen, setToolsOpen] = useState(false);
  const railRef = useRef(null);
  const recordsRef = useRef(null);
  const safety = useSafetyOverview();
  const trips = useTripsToday();
  const exceptions = useDriverExceptions();
  const [handledExceptions, markExceptionHandled] = useHandledExceptions();

  const trucks = snapshot.trucks || [];
  const alerts = sortAlerts(snapshot.alerts);
  const kpis = snapshot.kpis || {};
  const defaultAlert = alerts.find((a) => decisionRoute(a)) || alerts[0] || null;
  const selectedAlert =
    selectedAlertId === null
      ? null
      : alerts.find((a) => a.id === selectedAlertId) || (selectedAlertId === undefined ? defaultAlert : null);
  const deviating = trucks.filter(TRUCK_FILTERS.deviation);
  const worst = deviating.reduce((a, b) => (deviationMeters(b) > deviationMeters(a) ? b : a), deviating[0]);
  const openDeviations = alerts.filter((a) => a.type === "route_deviation");
  const openExceptions = exceptions.filter((e) => !handledExceptions[exceptionAlertId(e)]);
  const actionCount = alerts.length + openExceptions.length;
  const drawerData = drawerTruck ? trucks.find((truck) => truck.truck_code === drawerTruck) : null;
  const drawerAlert = drawerData ? alerts.find((a) => a.truck_code === drawerData.truck_code) : null;
  // One route on the map: the decision the operator is looking at, nothing else (M3).
  const routeAlert = railTab === "action" ? selectedAlert : railTab === "trucks" ? drawerAlert : null;

  function revealRail(tab) {
    setRailTab(tab);
    railRef.current?.scrollIntoView?.({ block: "nearest" });
  }

  function openTruck(code) {
    setDrawerTruck(code);
    revealRail("trucks");
  }

  function selectAlert(alert) {
    setSelectedAlertId(alert ? alert.id : null);
    if (alert) onFocusTruck(alert.truck_code);
  }

  const metrics = [
    trucks.length > 0 && {
      id: "active",
      label: t("w10fleet_metric_active"),
      value: fleetDenominator(t, { active: kpis.active_trucks, total: trucks.length }),
      helper: t("kpi_active_trucks_sub"),
      onSelect: () => {
        setTruckFilter("active");
        setDrawerTruck(null);
        revealRail("trucks");
      },
    },
    kpis.tpa_wait_minutes != null && {
      id: "queue",
      label: t("kpi_landfill_queue"),
      value: t("w10num_tpa_peak")
        .replace("{hour}", peakHourText(t, kpis.tpa_queue_hour))
        .replace("{n}", kpis.tpa_wait_minutes),
      helper: t("w10num_tpa_peak_helper").replace("{n}", kpis.tpa_queue_trucks),
      tone: "warning",
      onSelect: () => revealRail("queue"),
    },
    trucks.length > 0 && {
      id: "deviation",
      label: t("w10fleet_metric_deviation"),
      value: String(openDeviations.length),
      helper: worst
        ? t("w10fleet_metric_deviation_worst")
            .replace("{code}", worst.truck_code)
            .replace("{d}", formatDistance(deviationMeters(worst), lang))
        : t("w10fleet_metric_deviation_none"),
      tone: openDeviations.length ? "danger" : "neutral",
      onSelect: () => {
        const target = openDeviations.find((a) => a.truck_code === worst?.truck_code) || openDeviations[0];
        if (target) selectAlert(target);
        revealRail("action");
      },
    },
    trips?.total > 0 && {
      id: "trips",
      label: t("w10fleet_metric_trips"),
      value: t("w10fleet_metric_trips_value").replace("{done}", trips.done).replace("{total}", trips.total),
      helper: t("w10fleet_metric_trips_helper"),
      onSelect: () => {
        setRecordTab("spj");
        recordsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      },
    },
  ].filter(Boolean);

  const recordSurfaces = { spj, damage, safety: <SafetyPanel {...safety} /> };
  // Drivers who need a supervisor now (blocked without override, or past the gate limit).
  const safetyCount = safetyAttentionCount(safety.overview);
  const activeRecord = RECORD_TABS.find((tab) => tab.id === recordTab) || RECORD_TABS[0];

  return (
    <section className="fleet-workspace workspace-page" data-testid="fleet-workspace">
      <h1 className="sr-only">{t("w10fleet_title")}</h1>

      {metrics.length > 0 && (
        <div className="metric-strip fleet-metrics" data-testid="metric-strip">
          {metrics.map((metric) => (
            <button
              key={metric.id}
              type="button"
              className={`metric-cell metric-button metric-${metric.tone || "neutral"}`}
              data-testid="metric-cell"
              data-metric={metric.id}
              onClick={metric.onSelect}
            >
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.helper}</small>
            </button>
          ))}
        </div>
      )}

      <div className="fleet-deck">
        <div className="fleet-deck-stage" data-testid="fleet-map-stage">
          {renderMap({ decisionRoute: drawableRoute(decisionRoute(routeAlert)), onSelectTruck: openTruck })}

          <button
            type="button"
            className="deck-tools-toggle"
            data-testid="deck-tools-toggle"
            aria-expanded={toolsOpen}
            aria-controls="deck-tools-panel"
            onClick={() => setToolsOpen((open) => !open)}
          >
            <Layers size={16} />
            {t("w10fleet_layers_toggle")}
          </button>
          {toolsOpen && (
            <div className="deck-tools-panel" id="deck-tools-panel" data-testid="deck-tools-panel">
              <div className="deck-tools-head">
                <strong>{t("w10fleet_layers_title")}</strong>
                <button type="button" className="deck-tools-close" onClick={() => setToolsOpen(false)}>
                  {t("w10fleet_close")}
                </button>
              </div>
              {mapTools}
            </div>
          )}
        </div>

        <aside
          className="fleet-rail"
          ref={railRef}
          data-testid="fleet-rail"
          aria-label={t("w10fleet_rail_label")}
        >
          <div className="rail-tabs" role="tablist" aria-label={t("w10fleet_rail_label")}>
            {RAIL_TABS.map((id) => (
              <button
                key={id}
                id={`fleet-rail-tab-${id}`}
                data-tab={id}
                type="button"
                role="tab"
                className="rail-tab"
                aria-selected={railTab === id}
                aria-controls={`fleet-rail-panel-${id}`}
                tabIndex={railTab === id ? 0 : -1}
                onClick={() => setRailTab(id)}
                onKeyDown={(event) => onTabKeys(event, RAIL_TABS, railTab, setRailTab)}
              >
                {t(`w10fleet_tab_${id}`)}
                {id === "action" && actionCount > 0 && <b className="rail-tab-count">{actionCount}</b>}
              </button>
            ))}
          </div>

          <div
            id={`fleet-rail-panel-${railTab}`}
            className="rail-panel"
            role="tabpanel"
            aria-labelledby={`fleet-rail-tab-${railTab}`}
            data-testid={railTab === "queue" ? "fleet-queue-surface" : `fleet-rail-${railTab}`}
          >
            {railTab === "action" && (
              <>
                {actionCount === 0 && <p className="rail-empty">{t("w10fleet_action_empty")}</p>}
                <DriverExceptionAlerts
                  exceptions={exceptions}
                  handled={handledExceptions}
                  onHandled={markExceptionHandled}
                  onWhatsApp={onWhatsApp}
                />
                <AlertQueue
                  alerts={alerts}
                  snapshot={snapshot}
                  selectedId={selectedAlert?.id ?? null}
                  onSelect={selectAlert}
                  onWhatsApp={onWhatsApp}
                />
                <UnlicensedCollectorAlerts />
                <AStarReroutingPanel jamActive={jamActive} aiEvents={aiEvents} onAckEvent={onAckEvent} />
              </>
            )}
            {railTab === "trucks" &&
              (drawerData ? (
                <TruckDrawer
                  truck={drawerData}
                  snapshot={snapshot}
                  alert={drawerAlert}
                  exceptions={exceptions.filter((e) => e.truck_code === drawerTruck)}
                  safetyTruck={(safety.overview?.trucks || []).find((s) => s.truck_code === drawerTruck)}
                  onClose={() => setDrawerTruck(null)}
                  onOpenDrivers={() => navigate("/drivers")}
                  playbackTruck={playbackTruck}
                  canReplay={playbackOptions.includes(drawerTruck)}
                  onPlayback={onPlayback}
                />
              ) : (
                <TruckList
                  trucks={trucks}
                  filter={truckFilter}
                  onFilter={setTruckFilter}
                  onOpen={openTruck}
                />
              ))}
            {railTab === "queue" && queue}
          </div>
        </aside>
      </div>

      <section className="fleet-records-surface" ref={recordsRef} id="fleet-records">
        <div className="workspace-tabs" role="tablist" aria-label={t("w10fleet_records_title")}>
          {RECORD_TABS.map((tab) => (
            <button
              key={tab.id}
              id={`fleet-record-tab-${tab.id}`}
              data-tab={tab.id}
              className="workspace-tab"
              type="button"
              role="tab"
              aria-selected={recordTab === tab.id}
              aria-controls={tab.surface}
              tabIndex={recordTab === tab.id ? 0 : -1}
              onClick={() => setRecordTab(tab.id)}
              onKeyDown={(event) =>
                onTabKeys(
                  event,
                  RECORD_TABS.map((item) => item.id),
                  recordTab,
                  setRecordTab,
                )
              }
            >
              {t(tab.key)}
              {tab.id === "safety" && safetyCount > 0 && (
                <b className="rail-tab-count" data-testid="safety-tab-count">
                  {safetyCount}
                </b>
              )}
            </button>
          ))}
        </div>
        <div
          id={activeRecord.surface}
          className="fleet-detail-surface"
          role="tabpanel"
          aria-labelledby={`fleet-record-tab-${activeRecord.id}`}
          data-testid={activeRecord.surface}
        >
          {recordSurfaces[activeRecord.id]}
        </div>
      </section>
    </section>
  );
}
