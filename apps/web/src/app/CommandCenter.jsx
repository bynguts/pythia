import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Check, Radio } from "lucide-react";
import { AppShell } from "./AppShell.jsx";
import { workspacePath } from "./workspaces.js";
import { apiFetch } from "../shared/api/client.js";
import { useSnapshot } from "../shared/hooks/useSnapshot.js";
import { useLanguage } from "../shared/i18n/index.jsx";
import { ErrorBoundary } from "../shared/ui/ErrorBoundary.jsx";
import { StatusPill } from "../shared/ui/StatusPill.jsx";
import { AssistantPanel } from "../features/assistant/AssistantPanel.jsx";
import { DataAuditWorkspace } from "../features/audit/DataAuditWorkspace.jsx";
import { DriverAnalytics } from "../features/drivers/DriverAnalytics.jsx";
import { ActionCard } from "../features/fleet/ActionCard.jsx";
import { createAlertDispatch } from "../features/fleet/alertDispatch.js";
import { AlertQueue } from "../features/fleet/AlertQueue.jsx";
import { AStarReroutingPanel } from "../features/fleet/AStarReroutingPanel.jsx";
import { CarbonPanel } from "../features/fleet/CarbonPanel.jsx";
import { DamageReportsPanel } from "../features/fleet/DamageReportsPanel.jsx";
import { FleetHistoryPanel } from "../features/fleet/FleetHistoryPanel.jsx";
import { FleetOperations } from "../features/fleet/FleetOperations.jsx";
import { FleetTable } from "../features/fleet/FleetTable.jsx";
import { RouteEvidencePanel } from "../features/fleet/RouteEvidencePanel.jsx";
import { SpjPanel } from "../features/fleet/SpjPanel.jsx";
import { StaggerSimulatorPanel } from "../features/fleet/StaggerSimulatorPanel.jsx";
import { TpaQueuePanel } from "../features/fleet/TpaQueuePanel.jsx";
import { UnlicensedCollectorAlerts } from "../features/fleet/UnlicensedCollectorAlerts.jsx";
import { CrowdEventsPanel } from "../features/forecast/CrowdEventsPanel.jsx";
import { FacilityGapPanel } from "../features/forecast/FacilityGapPanel.jsx";
import { KecamatanMapPanel } from "../features/forecast/KecamatanMapPanel.jsx";
import { PermitSubmissionPanel } from "../features/forecast/PermitSubmissionPanel.jsx";
import { PredictionPanel } from "../features/forecast/PredictionPanel.jsx";
import { ReportActions } from "../features/forecast/ReportActions.jsx";
import { WasteForecast } from "../features/forecast/WasteForecast.jsx";
import { WeatherPanel } from "../features/forecast/WeatherPanel.jsx";
import { PlanningDecisionFlow } from "../features/planning/PlanningDecisionFlow.jsx";

const LiveFleetMap = lazy(() =>
  import("../features/fleet/LiveFleetMap.jsx").then((m) => ({ default: m.LiveFleetMap })),
);
// deck.gl + the twin stay in their own lazy chunk, off the startup path.
const TwinWorkspace = lazy(() =>
  import("../features/twin/TwinWorkspace.jsx").then((m) => ({ default: m.TwinWorkspace })),
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
}) {
  const { lang } = useLanguage();
  return (
    <section className="panel map-panel">
      <div className="map-data-notice">
        <StatusPill tone="warning">
          <Radio size={14} /> {lang === "id" ? "Data simulasi" : "Simulated data"}
        </StatusPill>
        <span>{lang === "id" ? "Posisi bukan GPS langsung" : "Positions are not live GPS"}</span>
      </div>
      <Suspense
        fallback={
          <div className="map-loading-fallback">{lang === "id" ? "Memuat peta…" : "Loading map…"}</div>
        }
      >
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
        />
      </Suspense>
    </section>
  );
}

// The active workspace comes from the URL (/fleet, /forecast, …); this component
// stays mounted across workspace navigation, so scenario state handed from one
// workspace to another (e.g. a crowd event into planning) survives the switch.
export function CommandCenter({ workspace: activeWorkspace, onLogout }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const { snapshot, online, refresh } = useSnapshot();
  const [toast, setToast] = useState("");
  const [filterTruck, setFilterTruck] = useState("ALL");
  const setActiveWorkspace = useCallback(
    (id) => {
      if (id !== activeWorkspace) navigate(workspacePath(id));
    },
    [activeWorkspace, navigate],
  );
  const [twinCity, setTwinCity] = useState("jakarta");
  const [fleetDetailTab, setFleetDetailTab] = useState("fleet");
  const [historyScrollRequest, setHistoryScrollRequest] = useState(0);
  const [selectedMapTruck, setSelectedMapTruck] = useState(null);
  const [mapFocusRequest, setMapFocusRequest] = useState(null);

  const [attendance, setAttendance] = useState(85000);
  const [rainfall, setRainfall] = useState(42);
  const [eventLat, setEventLat] = useState(null);
  const [eventLng, setEventLng] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState("7d");

  // Map state lifted from LiveFleetMap
  const [layers, setLayers] = useState({ heatmap: false, osrm: true, unlicensed: true, tps: true, wr: true });
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
    setToast(`Replay otomatis: ${code} menyimpang dari koridor`);
    setTimeout(() => setToast(""), 4200);
    ackAiEvent(idx);
  }, [aiEvents, playbackOptions, ackAiEvent]);

  useEffect(() => {
    if (!historyScrollRequest || fleetDetailTab !== "history") return;
    const el = document.getElementById("history-panel");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }, [fleetDetailTab, historyScrollRequest]);

  function selectFleetTruck(code, openTripHistory = false) {
    setFilterTruck(code);
    setSelectedMapTruck(code);
    if (openTripHistory) {
      setFleetDetailTab("history");
      setHistoryScrollRequest((request) => request + 1);
    }
  }

  function focusFleetTruck(code) {
    setSelectedMapTruck(code);
    setMapFocusRequest({ code, ts: Date.now() });
  }

  async function dispatch(alert) {
    try {
      const response = await createAlertDispatch(alert, t);
      if (!response.ok) {
        setToast({
          error: true,
          message:
            response.status === 401
              ? lang === "id"
                ? "Sesi berakhir. Masuk kembali untuk mengirim instruksi."
                : "Session expired. Sign in again to dispatch."
              : response.status === 403
                ? lang === "id"
                  ? "Akses ditolak. Anda tidak dapat mengirim instruksi."
                  : "Access denied. You cannot dispatch this instruction."
                : lang === "id"
                  ? "Gagal mengirim instruksi. Coba lagi."
                  : "Dispatch failed. Try again.",
        });
        return false;
      }
      setToast(
        lang === "id"
          ? `Instruksi dikirim ke ${alert.truck_code}`
          : `Instruction sent to ${alert.truck_code}`,
      );
      refresh();
      return true;
    } catch {
      setToast({
        error: true,
        message:
          lang === "id"
            ? "Tidak dapat menghubungi server dispatch. Coba lagi."
            : "Cannot reach dispatch server. Try again.",
      });
      return false;
    } finally {
      setTimeout(() => setToast(""), 4200);
    }
  }

  async function sendWhatsAppAlert(alert) {
    const route =
      alert.recommended_routes?.[0]?.name ||
      (lang === "id" ? "tugaskan armada cadangan" : "dispatch backup fleet");
    try {
      const response = await apiFetch("/whatsapp/alert", {
        method: "POST",
        body: JSON.stringify({
          truck_code: alert.truck_code,
          issue: alert.description || alert.title,
          recommendation: route,
        }),
      });
      if (!response.ok) {
        setToast({
          error: true,
          message:
            response.status === 401
              ? lang === "id"
                ? "Sesi berakhir. Masuk kembali untuk mengirim WhatsApp."
                : "Session expired. Sign in again to send WhatsApp."
              : response.status === 403
                ? lang === "id"
                  ? "Akses ditolak. WhatsApp tidak terkirim."
                  : "Access denied. WhatsApp was not sent."
                : lang === "id"
                  ? "WhatsApp gagal dikirim. Coba lagi."
                  : "WhatsApp delivery failed. Try again.",
        });
        return;
      }
      const data = await response.json();
      setToast(
        data.sent
          ? lang === "id"
            ? "WhatsApp berhasil dikirim."
            : "WhatsApp delivered."
          : {
              error: !data.partial,
              message: data.partial
                ? lang === "id"
                  ? "WhatsApp hanya terkirim ke sebagian penerima."
                  : "WhatsApp delivered to some recipients only."
                : lang === "id"
                  ? "WhatsApp tidak terkirim. Periksa gateway."
                  : "WhatsApp not delivered. Check the gateway.",
            },
      );
    } catch {
      setToast({
        error: true,
        message:
          lang === "id" ? "Tidak dapat menghubungi layanan WhatsApp." : "Cannot reach the WhatsApp service.",
      });
    } finally {
      setTimeout(() => setToast(""), 4200);
    }
  }

  return (
    <AppShell
      activeWorkspace={activeWorkspace}
      onWorkspaceChange={setActiveWorkspace}
      online={online}
      onRefresh={refresh}
      onLogout={onLogout}
      assistant={<AssistantPanel />}
      contextKey={
        activeWorkspace === "twin" && twinCity === "hcmc" ? "shell_context_eyebrow_hcmc" : undefined
      }
    >
      {activeWorkspace === "fleet" && (
        <ErrorBoundary name="fleet">
          <FleetOperations
            detailTab={fleetDetailTab}
            onDetailTabChange={setFleetDetailTab}
            actionCard={<ActionCard snapshot={snapshot} targetTruck={selectedMapTruck} />}
            trucks={snapshot.trucks}
            queueTrucks={snapshot.kpis.tpa_queue_trucks}
            queueWaitMinutes={snapshot.kpis.tpa_wait_minutes}
            onFocusProblem={focusFleetTruck}
            metrics={[
              {
                label: t("kpi_active_trucks"),
                value: snapshot.kpis.active_trucks,
                helper: t("kpi_active_trucks_sub"),
              },
              {
                label: t("kpi_operational_issues"),
                value: snapshot.kpis.trucks_with_issues,
                helper: t("kpi_operational_issues_sub"),
                tone: "danger",
              },
              {
                label: t("kpi_landfill_queue"),
                value: `${snapshot.kpis.tpa_wait_minutes}m`,
                helper: `${snapshot.kpis.tpa_queue_trucks} ${t("kpi_landfill_queue_sub")}`,
                tone: "warning",
              },
              {
                label: t("kpi_waste_spike"),
                value: `+${snapshot.kpis.predicted_spike_percent}%`,
                helper: t("kpi_waste_spike_sub"),
                tone: "warning",
              },
            ]}
            map={
              <div id="map-panel" className="map-anchor">
                <MapPanel
                  trucks={snapshot.trucks}
                  attendance={attendance}
                  rainfall={rainfall}
                  onSelectTruck={selectFleetTruck}
                  layers={layers}
                  playbackTruck={playbackTruck}
                  onBreadcrumbsLoaded={setPlaybackOptions}
                  jamActive={jamActive}
                  focusRequest={mapFocusRequest}
                />
              </div>
            }
            mapTools={
              <>
                <div className="deck-tools-section">
                  <span className="deck-tools-label">{lang === "id" ? "Lapisan" : "Layers"}</span>
                  <div className="map-controls-grid">
                    <label>
                      <input
                        type="checkbox"
                        checked={layers.heatmap}
                        onChange={(e) => setLayers((s) => ({ ...s, heatmap: e.target.checked }))}
                      />{" "}
                      {lang === "id" ? "Peta Panas" : "Heatmap"}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layers.osrm}
                        onChange={(e) => setLayers((s) => ({ ...s, osrm: e.target.checked }))}
                      />{" "}
                      {lang === "id" ? "Rute OSRM" : "OSRM route"}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layers.tps}
                        onChange={(e) => setLayers((s) => ({ ...s, tps: e.target.checked }))}
                      />{" "}
                      {lang === "id" ? "Titik TPS" : "TPS"}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layers.wr}
                        onChange={(e) => setLayers((s) => ({ ...s, wr: e.target.checked }))}
                      />{" "}
                      {lang === "id" ? "Wajib Retribusi" : "Retribution registry"}
                    </label>
                  </div>
                </div>
                <div className="deck-tools-section">
                  <span className="deck-tools-label">{lang === "id" ? "Replay rute" : "Route replay"}</span>
                  <div className="playback-select-wrap">
                    <select
                      value={playbackTruck || ""}
                      onChange={(e) => setPlaybackTruck(e.target.value || null)}
                      aria-label={lang === "id" ? "Putar ulang perjalanan" : "Trip playback"}
                    >
                      <option value="">{lang === "id" ? "Putar riwayat rute..." : "Trip playback..."}</option>
                      {playbackOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    {playbackTruck && (
                      <button className="compact-enforce-btn" onClick={() => setPlaybackTruck(null)}>
                        {lang === "id" ? "Tutup putar ulang" : "Close replay"}
                      </button>
                    )}
                  </div>
                </div>
                <details className="deck-tools-section deck-legend">
                  <summary>{lang === "id" ? "Legenda peta" : "Map legend"}</summary>
                  <div
                    className="map-legend deck-legend-body"
                    aria-label={lang === "id" ? "Legenda peta" : "Map legend"}
                  >
                    <span>
                      <i
                        className="legend-heatmap"
                        style={{
                          backgroundColor: "#22c55e",
                          borderRadius: "50%",
                          width: "10px",
                          height: "10px",
                          border: "1.5px solid #fff",
                          display: "inline-block",
                        }}
                      />{" "}
                      {lang === "id" ? "Titik TPS" : "TPS locations"}{" "}
                      <em className="legend-tag">{lang === "id" ? "RIIL" : "REAL"}</em>
                    </span>
                    <span>
                      <i
                        className="legend-heatmap"
                        style={{
                          backgroundColor: "#f97316",
                          borderRadius: "50%",
                          width: "10px",
                          height: "10px",
                          border: "1.5px solid #fff",
                          display: "inline-block",
                        }}
                      />{" "}
                      {lang === "id" ? "Wajib Retribusi" : "Retribution registry"}{" "}
                      <em className="legend-tag">{lang === "id" ? "RIIL" : "REAL"}</em>
                    </span>
                    <span>
                      <i
                        className="legend-heatmap"
                        style={{ backgroundColor: "#a5b4fc", display: "inline-block" }}
                      />{" "}
                      {lang === "id" ? "Risiko Sampah Wilayah" : "District waste risk"}{" "}
                      <em className="legend-tag">MODEL</em>
                    </span>
                    <span>
                      <i className="legend-assigned" style={{ display: "inline-block" }} />{" "}
                      {lang === "id" ? "Koridor Ditugaskan" : "Assigned corridor"}{" "}
                      <em className="legend-tag">{lang === "id" ? "SIMULASI" : "SIMULATED"}</em>
                    </span>
                    <span>
                      <i
                        className="legend-actual"
                        style={{ backgroundColor: "#176b54", display: "inline-block" }}
                      />{" "}
                      {lang === "id" ? "Rute Aktual" : "Actual (clean)"}{" "}
                      <em className="legend-tag">{lang === "id" ? "SIMULASI" : "SIMULATED"}</em>
                    </span>
                    <span>
                      <i
                        className="legend-critical"
                        style={{
                          backgroundColor: "#b42318",
                          borderRadius: "50%",
                          width: "10px",
                          height: "10px",
                          display: "inline-block",
                        }}
                      />{" "}
                      {lang === "id" ? "Segmen Pelanggaran" : "Violation segment"}{" "}
                      <em className="legend-tag">{lang === "id" ? "SIMULASI" : "SIMULATED"}</em>
                    </span>
                    <span>
                      <i
                        className="legend-osrm"
                        style={{ backgroundColor: "#0891b2", display: "inline-block" }}
                      />{" "}
                      {lang === "id" ? "Rute OSRM" : "OSRM route"}{" "}
                      <em className="legend-tag">{lang === "id" ? "LANGSUNG" : "LIVE"}</em>
                    </span>
                    <span>
                      <span className="legend-icon-tpa" /> TPA Bantargebang{" "}
                      <em className="legend-tag">MODEL</em>
                    </span>
                    <span>
                      <span className="legend-icon-unlicensed" />{" "}
                      {lang === "id" ? "Kolektor Liar" : "Unlicensed Collector"}{" "}
                      <em className="legend-tag">{lang === "id" ? "SIMULASI" : "SIMULATED"}</em>
                    </span>
                    <span>
                      <i
                        className="legend-event"
                        style={{
                          backgroundColor: "#eab308",
                          borderRadius: "4px",
                          width: "16px",
                          height: "12px",
                          display: "inline-block",
                        }}
                      />{" "}
                      {lang === "id" ? "Acara Keramaian" : "Crowd Event"}{" "}
                      <em className="legend-tag">{lang === "id" ? "SIMULASI" : "SIMULATED"}</em>
                    </span>
                  </div>
                </details>
                <div className="deck-tools-section">
                  <details className="alert-queue-collapsible">
                    <summary>{t("ac_all_alerts").replace("{n}", snapshot.alerts.length)}</summary>
                    <AlertQueue
                      alerts={snapshot.alerts}
                      onDispatch={dispatch}
                      onWhatsApp={sendWhatsAppAlert}
                    />
                  </details>
                </div>
                <div className="deck-tools-section">
                  <AStarReroutingPanel jamActive={jamActive} aiEvents={aiEvents} onAckEvent={ackAiEvent} />
                </div>
              </>
            }
            routeEvidence={<RouteEvidencePanel route={snapshot.osrm_route} />}
            queue={
              <div className="fleet-queue-stack">
                <TpaQueuePanel />
                <StaggerSimulatorPanel />
              </div>
            }
            fleetTable={
              <FleetTable
                trucks={snapshot.trucks}
                onOpenTripHistory={(code) => selectFleetTruck(code, true)}
              />
            }
            unlicensedTable={<UnlicensedCollectorAlerts />}
            history={<FleetHistoryPanel filterTruck={filterTruck} setFilterTruck={setFilterTruck} />}
            carbon={<CarbonPanel />}
            spj={<SpjPanel />}
            damage={<DamageReportsPanel />}
          />
        </ErrorBoundary>
      )}

      {activeWorkspace === "twin" && (
        <ErrorBoundary name="twin">
          <Suspense
            fallback={
              <div className="map-loading-fallback" role="status">
                {t("twin_loading")}
              </div>
            }
          >
            <TwinWorkspace onCityChange={setTwinCity} />
          </Suspense>
        </ErrorBoundary>
      )}

      {activeWorkspace !== "fleet" && activeWorkspace !== "twin" && (
        <section className="main-grid">
          {activeWorkspace === "forecast" && (
            <ErrorBoundary name="forecast">
              <WasteForecast
                metrics={[
                  {
                    label: lang === "id" ? "Lonjakan Terbesar" : "Largest forecast spike",
                    value: `+${snapshot.kpis.predicted_spike_percent}%`,
                    helper: lang === "id" ? "7 hari ke depan" : "next 7 days",
                    tone: "warning",
                  },
                  {
                    label: lang === "id" ? "Distrik Risiko Tinggi" : "High-risk districts",
                    value: snapshot.critical_predictions.length,
                    helper: lang === "id" ? "perlu penguatan armada" : "capacity reinforcement needed",
                    tone: "danger",
                  },
                  {
                    label: lang === "id" ? "Puncak Curah Hujan" : "Peak rainfall",
                    value: `${Math.round(Math.max(...snapshot.weather.forecast.map((day) => day.rainfall_mm)))} mm`,
                    helper: lang === "id" ? "faktor pemicu timbulan" : "forecast driver",
                    tone: "warning",
                  },
                  {
                    label: lang === "id" ? "Status Perencanaan" : "Planning status",
                    value: lang === "id" ? "Siap" : "Ready",
                    helper: lang === "id" ? "dapat dialihkan ke perencana" : "scenario handoff enabled",
                  },
                ]}
                forecast={
                  <PredictionPanel
                    predictions={snapshot.critical_predictions}
                    allPredictions={snapshot.predictions}
                  />
                }
                weather={<WeatherPanel weather={snapshot.weather} />}
                events={
                  <>
                    <CrowdEventsPanel
                      onSimulateEvent={(ev) => {
                        setAttendance(ev.expected_attendance);
                        setRainfall(10);
                        setEventLat(ev.lat);
                        setEventLng(ev.lng);
                        setActiveWorkspace("planning");
                      }}
                    />
                  </>
                }
                districts={
                  <>
                    <KecamatanMapPanel horizon={forecastHorizon} />
                    <PermitSubmissionPanel
                      onPermitSubmitted={(permit) => {
                        setAttendance(permit.expected_attendance);
                        setEventLat(permit.lat);
                        setEventLng(permit.lng);
                      }}
                    />
                    <FacilityGapPanel rainfall={rainfall} attendance={attendance} />
                  </>
                }
                reportActions={<ReportActions />}
                horizon={forecastHorizon}
                onHorizonChange={setForecastHorizon}
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

          {activeWorkspace === "audit" && (
            <ErrorBoundary name="audit">
              <DataAuditWorkspace />
            </ErrorBoundary>
          )}
        </section>
      )}
      {toast && (
        <div className="toast" role={toast.error ? "alert" : "status"}>
          {toast.error ? <AlertTriangle size={16} /> : <Check size={16} />} {toast.message || toast}
        </div>
      )}
    </AppShell>
  );
}
