import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Check } from "lucide-react";
import { apiFetch } from "../shared/api/client.js";
import { whatsappLanguage } from "../shared/api/whatsappLanguage.js";
import { useSnapshot } from "../shared/hooks/useSnapshot.js";
import { translate, useLanguage } from "../shared/i18n/index.jsx";
import { ErrorBoundary } from "../shared/ui/ErrorBoundary.jsx";
import { DriverAnalytics } from "../features/drivers/DriverAnalytics.jsx";
import { DamageReportsPanel } from "../features/fleet/DamageReportsPanel.jsx";
import { alertDetail, alertTitle, routeName } from "../features/fleet/decisionRoute.js";
import { FleetOperations } from "../features/fleet/FleetOperations.jsx";
import { SpjPanel } from "../features/fleet/SpjPanel.jsx";
import { StaggerSimulatorPanel } from "../features/fleet/StaggerSimulatorPanel.jsx";
import { TpaQueuePanel } from "../features/fleet/TpaQueuePanel.jsx";
import { ForecastWorkspace } from "../features/forecast/ForecastWorkspace.jsx";
import { PlanningDecisionFlow } from "../features/planning/PlanningDecisionFlow.jsx";
import { planningScenarioPath } from "../features/planning/scenarioLink.js";
import { SettingsWorkspace } from "../features/settings/SettingsWorkspace.jsx";

const LiveFleetMap = lazy(() =>
  import("../features/fleet/LiveFleetMap.jsx").then((m) => ({ default: m.LiveFleetMap })),
);

function MapPanel({
  trucks,
  attendance,
  rainfall,
  onSelectTruck,
  layers,
  playbackTruck,
  onBreadcrumbsLoaded,
  jamActive,
  focusRequest,
  decisionRoute,
}) {
  const { t } = useLanguage();
  return (
    <section className="panel map-panel">
      {/* The map's provenance is one outlined mono footer chip. */}
      <p className="map-data-notice" data-testid="map-provenance">
        <span>{t("w10fleet_map_sim")}</span>
        <span aria-hidden="true">·</span>
        <span>{t("w10fleet_map_not_gps")}</span>
      </p>
      <Suspense fallback={<div className="map-loading-fallback">{t("w10fleet_map_loading")}</div>}>
        <LiveFleetMap
          trucks={trucks}
          attendance={attendance}
          rainfall={rainfall}
          onSelectTruck={onSelectTruck}
          layers={layers}
          playbackTruck={playbackTruck}
          onBreadcrumbsLoaded={onBreadcrumbsLoaded}
          jamActive={jamActive}
          focusRequest={focusRequest}
          decisionRoute={decisionRoute}
        />
      </Suspense>
    </section>
  );
}

// Reference layers only; the decision route draws itself while its decision is open.
const MAP_LAYER_KEYS = [
  ["heatmap", "fmap_heatmap"],
  ["tps", "fmap_tps"],
  ["wr", "fmap_wr"],
];

// The pre-redesign workspaces (fleet, forecast, planning, drivers,
// settings) without their old shell. The console page stubs render one each until
// their replacement page takes over; scenario hand-offs between them travel in the URL.
export function LegacyWorkspace({ workspace: activeWorkspace }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { snapshot, status: snapshotStatus } = useSnapshot();
  // Teardown v3 N1: the canned sample is only ever the offline sample, never live data.
  const forecastSource =
    snapshotStatus === "online" ? "live" : snapshotStatus === "offline" ? "sample" : "loading";
  const [toast, setToast] = useState("");
  const [mapFocusRequest, setMapFocusRequest] = useState(null);

  // Teardown v4 R2: no what-if by default; Rencana starts from today's baseline.
  const [attendance, setAttendance] = useState(0);
  const [rainfall, setRainfall] = useState(0);
  const [eventLat, setEventLat] = useState(null);
  const [eventLng, setEventLng] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState("7d");

  // Map state lifted from LiveFleetMap
  const [layers, setLayers] = useState({
    heatmap: false,
    unlicensed: true,
    tps: false,
    wr: false,
  });
  const [playbackTruck, setPlaybackTruck] = useState(null);
  const [playbackOptions, setPlaybackOptions] = useState([]);
  const [jamActive, setJamActive] = useState(false);
  const [aiEvents, setAiEvents] = useState([]);

  useEffect(() => {
    const load = () => {
      apiFetch("/fleet/astar-reroute")
        .then((r) => r.json())
        .then((body) => setJamActive(Boolean(body.jam_active)))
        .catch(() => {});
      apiFetch("/ai/events")
        .then((r) => r.json())
        .then((body) => setAiEvents(body.events || []))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  const ackAiEvent = useCallback((index) => {
    apiFetch(`/ai/events/${index}/ack`, { method: "POST" })
      .then(() => apiFetch("/ai/events"))
      .then((r) => r.json())
      .then((body) => setAiEvents(body.events || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const idx = aiEvents.findIndex(
      (e) => e.event_type === "auto_replay" && e.status === "new" && playbackOptions.includes(e.truck_code),
    );
    if (idx === -1) return;
    const code = aiEvents[idx].truck_code;
    setPlaybackTruck(code);
    setToast(t("w10fleet_replay_toast").replace("{code}", code));
    setTimeout(() => setToast(""), 4200);
    ackAiEvent(idx);
  }, [aiEvents, playbackOptions, ackAiEvent, t]);

  function focusFleetTruck(code) {
    setMapFocusRequest({ code, ts: Date.now() });
  }

  async function sendWhatsAppAlert(alert) {
    const route = alert.recommended_routes?.[0];
    try {
      const wl = await whatsappLanguage();
      const wt = (key) => translate(wl, key);
      const response = await apiFetch("/whatsapp/alert", {
        method: "POST",
        body: JSON.stringify({
          truck_code: alert.truck_code,
          issue: `${alertTitle(wt, alert)}. ${alertDetail(wt, alert, wl)}`,
          recommendation: route
            ? routeName(wt, route)
            : wt(alert.type === "driver_exception" ? "w10fleet_exc_wa_reco" : "w10fleet_wa_backup"),
        }),
      });
      if (!response.ok) {
        setToast({
          error: true,
          message: t(
            response.status === 401
              ? "w10fleet_wa_session"
              : response.status === 403
                ? "w10fleet_wa_denied"
                : "w10fleet_wa_failed",
          ),
        });
        return;
      }
      const data = await response.json();
      setToast(
        data.sent
          ? t("w10fleet_wa_sent")
          : {
              error: !data.partial,
              message: t(data.partial ? "w10fleet_wa_partial" : "w10fleet_wa_not_sent"),
            },
      );
    } catch {
      setToast({ error: true, message: t("w10fleet_wa_unreachable") });
    } finally {
      setTimeout(() => setToast(""), 4200);
    }
  }

  return (
    <>
      {activeWorkspace === "fleet" && (
        <ErrorBoundary name="fleet">
          <FleetOperations
            snapshot={snapshot}
            renderMap={({ decisionRoute, onSelectTruck }) => (
              <div id="map-panel" className="map-anchor">
                <MapPanel
                  trucks={snapshot.trucks}
                  attendance={attendance}
                  rainfall={rainfall}
                  onSelectTruck={onSelectTruck}
                  layers={layers}
                  playbackTruck={playbackTruck}
                  onBreadcrumbsLoaded={setPlaybackOptions}
                  jamActive={jamActive}
                  focusRequest={mapFocusRequest}
                  decisionRoute={decisionRoute}
                />
              </div>
            )}
            mapTools={
              <div className="deck-tools-section">
                <span className="deck-tools-label">{t("w10fleet_layers")}</span>
                <div className="map-controls-grid">
                  {MAP_LAYER_KEYS.map(([id, key]) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={layers[id]}
                        onChange={(e) => setLayers((s) => ({ ...s, [id]: e.target.checked }))}
                      />
                      <span>{t(key)}</span>
                    </label>
                  ))}
                </div>
              </div>
            }
            aiEvents={aiEvents}
            jamActive={jamActive}
            onAckEvent={ackAiEvent}
            playbackTruck={playbackTruck}
            playbackOptions={playbackOptions}
            onPlayback={setPlaybackTruck}
            onWhatsApp={sendWhatsAppAlert}
            onFocusTruck={focusFleetTruck}
            queue={
              <div className="fleet-queue-stack">
                <TpaQueuePanel />
                <StaggerSimulatorPanel />
              </div>
            }
            spj={<SpjPanel />}
            damage={<DamageReportsPanel />}
          />
        </ErrorBoundary>
      )}

      {activeWorkspace !== "fleet" && (
        <section className="main-grid">
          {activeWorkspace === "forecast" && (
            <ErrorBoundary name="forecast">
              <ForecastWorkspace
                snapshot={snapshot}
                forecastSource={forecastSource}
                horizon={forecastHorizon}
                onHorizonChange={setForecastHorizon}
                onSimulateEvent={(ev) =>
                  navigate(
                    planningScenarioPath({
                      scenario: "event",
                      attendance: ev.expected_attendance,
                      lat: ev.lat,
                      lng: ev.lng,
                    }),
                  )
                }
                onPermitSubmitted={(permit) => {
                  setAttendance(permit.expected_attendance);
                  setEventLat(permit.lat);
                  setEventLng(permit.lng);
                }}
              />
            </ErrorBoundary>
          )}

          {activeWorkspace === "planning" && (
            <ErrorBoundary name="planning">
              <PlanningDecisionFlow
                attendance={attendance}
                setAttendance={setAttendance}
                rainfall={rainfall}
                setRainfall={setRainfall}
                eventLat={eventLat}
                eventLng={eventLng}
                snapshot={snapshot}
                queue={snapshot.tpa_queue}
              />
            </ErrorBoundary>
          )}

          {activeWorkspace === "drivers" && (
            <div className="grid-col-12">
              <ErrorBoundary name="drivers">
                <DriverAnalytics />
              </ErrorBoundary>
            </div>
          )}

          {activeWorkspace === "settings" && (
            <ErrorBoundary name="settings">
              <SettingsWorkspace />
            </ErrorBoundary>
          )}
        </section>
      )}
      {toast && (
        <div className="toast" role={toast.error ? "alert" : "status"}>
          {toast.error ? <AlertTriangle size={16} /> : <Check size={16} />} {toast.message || toast}
        </div>
      )}
    </>
  );
}
