import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle, Send } from "lucide-react";
import { dayPhase, useConsole } from "../app/console/useConsole.js";
import { decisionRoute, drawableRoute } from "../features/fleet/decisionRoute.js";
import { GateCard } from "../features/operations/GateCard.jsx";
import { InstructionDrawer } from "../features/operations/InstructionDrawer.jsx";
import { NeedsYouPanel } from "../features/operations/NeedsYouPanel.jsx";
import { jakartaTime, slotAt, useOperationsData } from "../features/operations/useOperations.js";
import "../features/operations/operations.css";
import { useSnapshot } from "../shared/hooks/useSnapshot.js";
import { localeFor, useLanguage } from "../shared/i18n/index.jsx";
import { Button } from "../shared/ui/Button.jsx";
import { Kpi, KpiStrip } from "../shared/ui/KpiStrip.jsx";
import { OfflineBanner } from "../shared/ui/OfflineBanner.jsx";
import { Tag } from "../shared/ui/Tag.jsx";

const LiveFleetMap = lazy(() =>
  import("../features/fleet/LiveFleetMap.jsx").then((m) => ({ default: m.LiveFleetMap })),
);

const PHASE_KEYS = {
  plan: "f_phase_plan",
  ready: "f_phase_ready",
  run: "f_phase_run",
  close: "f_phase_close",
};
// Reference layers stay off: the Operations map shows the fleet and its decisions.
const MAP_LAYERS = { heatmap: false, unlicensed: false, tps: false, wr: false };
// Floating panels cover the map's left 432 px (Needs you) on a desktop-wide stage.
const WIDE_STAGE = 1100;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function number(value, lang, digits = 0) {
  return Number(value).toLocaleString(localeFor(lang), { maximumFractionDigits: digits });
}

// Operations (U0H9au): the run of the day, map first. Every figure is bound to the API;
// simulated truck data keeps data-provenance="simulated" and says so in its tooltip.
export function OperationsPage() {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const { role, setNavCount } = useConsole();
  const now = useClock();
  const { snapshot, status } = useSnapshot();
  const { feed, recap, gate, queue } = useOperationsData();
  const [selectedId, setSelectedId] = useState(undefined);
  const [focusRequest, setFocusRequest] = useState(null);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [wide] = useState(() => typeof window === "undefined" || window.innerWidth > WIDE_STAGE);

  const time = jakartaTime(now);
  const hour = Number(time.slice(0, 2));
  const phase = dayPhase(hour);
  const live = status === "online";
  const trucks = live ? snapshot.trucks || [] : [];
  const alerts = live ? snapshot.alerts || [] : [];
  const kpis = live ? snapshot.kpis || {} : {};
  const items = feed.data?.items || [];

  useEffect(() => {
    if (feed.data) setNavCount("operations", feed.data.counts?.all ?? null, "danger");
  }, [feed.data, setNavCount]);

  // The expanded decision: the operator's pick, else the first deviation.
  const openId =
    selectedId === undefined ? items.find((item) => item.kind === "deviation")?.id || null : selectedId;
  const openAlert = alerts.find((alert) => alert.id === openId) || null;
  const route = drawableRoute(decisionRoute(openAlert));

  const pinTonesKey = JSON.stringify(
    items
      .filter((item) => item.truck_code)
      .map((item) => [
        item.truck_code,
        item.id === openId
          ? "selected"
          : item.kind === "accident" || item.kind === "duty_blocked"
            ? "danger"
            : item.kind === "duty_warn"
              ? "warn"
              : item.kind === "truck_breakdown"
                ? "off"
                : null,
      ])
      .filter(([, tone]) => tone)
      .reverse(),
  );
  const pinTones = useMemo(() => Object.fromEntries(JSON.parse(pinTonesKey)), [pinTonesKey]);

  const roleKey = `pln6_profile_role_${role}`;
  const roleLabel = role && t(roleKey) !== roleKey ? t(roleKey) : t("s1_role_fallback");
  const greetKey = hour < 12 ? "s1_greet_morning" : hour < 18 ? "s1_greet_afternoon" : "s1_greet_evening";
  const dateLine = new Intl.DateTimeFormat(localeFor(lang), {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "short",
  })
    .format(now)
    .replace(/,/g, "");

  // KPI: trucks on route (simulated fleet).
  const total = trucks.length;
  const active = kpis.active_trucks;
  // KPI: trips done (SPJ receipts today) against the approved plan's trips.
  const actual = recap.data?.actual || {};
  const forecast = recap.data?.forecast || {};
  const planned = forecast.planned_trips;
  const trips = recap.data ? actual.ritasi : null;
  // KPI: tonnes delivered (net weights recorded) against the plan's tonnes.
  const tons = actual.receipt_tons;
  const plannedTons = forecast.planned_tons;
  // KPI: gate queue now: the modelled slot holding now, else the normal-day queue model.
  const slotNow = slotAt(gate.data?.slots, now);
  const gateWait = slotNow ? slotNow.expected_wait_min : (queue.data?.avg_wait_minutes ?? null);
  const gateSub = slotNow
    ? t("s1_kpi_gate_sub")
    : queue.data?.modelled_hour != null
      ? t("s1_kpi_gate_sub_peak").replace("{h}", String(queue.data.modelled_hour).padStart(2, "0"))
      : t("s1_kpi_gate_sub");

  const offline = status === "offline" || (feed.error && !(feed.error.status >= 400));
  const truckCodes = trucks.map((truck) => truck.truck_code);

  return (
    <div className="ops" data-testid="fleet-workspace">
      <header className="ops-head">
        <div className="ops-head-text">
          <p className="ops-eyebrow">
            <Tag tone="live" data-testid="ops-phase">
              {t(PHASE_KEYS[phase])} · {time}
            </Tag>
            <span>{dateLine}</span>
          </p>
          <h1>{t(greetKey).replace("{role}", roleLabel)}</h1>
        </div>
        <div className="ops-head-actions">
          <Button
            icon={MessageCircle}
            title={t("s1_message_hint")}
            data-testid="ops-message-drivers"
            onClick={() => navigate("/app/settings?tab=whatsapp")}
          >
            {t("s1_message_drivers")}
          </Button>
          <Button
            variant="primary"
            icon={Send}
            aria-haspopup="dialog"
            data-testid="ops-new-instruction"
            onClick={() => setInstructionOpen(true)}
          >
            {t("s1_new_instruction")}
          </Button>
        </div>
      </header>

      {offline && <OfflineBanner since={feed.at ? jakartaTime(feed.at) : null} />}

      <KpiStrip label={t("s1_kpi_label")} className="ops-kpis" data-testid="metric-strip">
        <Kpi
          testId="kpi-trucks"
          label={t("s1_kpi_trucks")}
          value={
            <span data-provenance="simulated" title={t("s1_kpi_trucks_hint")}>
              {active != null && total ? number(active, lang) : "—"}
            </span>
          }
          unit={total ? `/ ${number(total, lang)}` : null}
          progress={active != null && total ? active / total : null}
          sub={
            active != null && total
              ? t("s1_kpi_trucks_sub").replace("{n}", number(Math.max(0, total - active), lang))
              : t("s1_none")
          }
        />
        <Kpi
          testId="kpi-trips"
          label={t("s1_kpi_trips")}
          value={trips != null ? number(trips, lang) : "—"}
          unit={t("s1_kpi_of").replace("{n}", planned != null ? number(planned, lang) : "—")}
          progress={trips != null && planned ? trips / planned : null}
          sub={
            planned
              ? t("s1_kpi_trips_sub").replace(
                  "{pct}",
                  number(Math.round((100 * (trips || 0)) / planned), lang),
                )
              : t("s1_kpi_no_plan")
          }
        />
        <Kpi
          testId="kpi-tonnes"
          label={t("s1_kpi_tonnes")}
          value={tons != null ? `${number(tons, lang, 1)} t` : "—"}
          progress={tons != null && plannedTons ? tons / plannedTons : null}
          sub={
            plannedTons != null
              ? t("s1_kpi_tonnes_sub").replace("{n}", number(plannedTons, lang))
              : t("s1_kpi_tonnes_none")
          }
        />
        <Kpi
          testId="kpi-gate"
          label={t("s1_kpi_gate")}
          tag={
            <Tag tone="model" title={t("s1_model_hint")}>
              {t("s1_model")}
            </Tag>
          }
          value={
            <span data-provenance="model" title={t("s1_model_hint")}>
              {gateWait != null ? `${number(gateWait, lang)} min` : "—"}
            </span>
          }
          sub={gateSub}
        />
      </KpiStrip>

      <div className={`ops-stage${wide ? " is-wide" : ""}`}>
        <div className="ops-map" id="map-panel" data-testid="fleet-map-stage" aria-label={t("s1_map_label")}>
          <Suspense fallback={<div className="ops-map-loading">{t("s1_map_loading")}</div>}>
            <LiveFleetMap
              variant="console"
              trucks={trucks}
              attendance={0}
              rainfall={0}
              layers={MAP_LAYERS}
              focusRequest={focusRequest}
              decisionRoute={route}
              pinTones={pinTones}
              fitPadding={wide ? { top: 64, bottom: 72, left: 440, right: 64 } : null}
              onSelectTruck={(code) => setFocusRequest({ code, ts: Date.now() })}
            />
          </Suspense>
        </div>

        <NeedsYouPanel
          feed={feed}
          alerts={alerts}
          openId={openId}
          onSelect={setSelectedId}
          onFocusTruck={(code) => setFocusRequest({ code, ts: Date.now() })}
          trucksOnRoute={active != null && total ? active : null}
          role={role}
        />

        <div className="ops-corner">
          <p className="ops-attrib">
            ©{" "}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>{" "}
            {t("s1_attrib_contrib")} ·{" "}
            <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
              OpenFreeMap
            </a>
          </p>
          <GateCard board={gate.data} currentStart={slotNow?.start || null} />
        </div>
      </div>

      <InstructionDrawer
        open={instructionOpen}
        onClose={() => setInstructionOpen(false)}
        truckCodes={truckCodes}
        role={role}
      />
    </div>
  );
}
