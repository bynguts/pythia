import { Suspense, lazy, useEffect, useState } from "react";
import { CheckCircle2, Flag, Layers, Navigation, Scale } from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { clockTime } from "./driverHelpers.js";

const ArNavigator = lazy(() => import("./ArNavigator.jsx").then((m) => ({ default: m.ArNavigator })));

const QUEUE_CACHE_KEY = "pythia_driver_tpa_queue";
const TICK_MS = 30000;

function readQueueCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(QUEUE_CACHE_KEY) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch {
    return null;
  }
}

// GET /api/tpa/queue-status: the landfill's modelled peak hour (SIMULATED). The
// last copy is kept so the card still has its estimate where the signal is weak.
function useTpaQueue() {
  const [queue, setQueue] = useState(() => readQueueCache());
  useEffect(() => {
    let cancelled = false;
    apiFetch("/tpa/queue-status", { tokenKey: FIELD_TOKEN_KEY })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        setQueue(body);
        try {
          localStorage.setItem(QUEUE_CACHE_KEY, JSON.stringify(body));
        } catch {
          // The cached copy only serves a weak signal.
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return queue;
}

function useArSupported() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const xr = typeof navigator !== "undefined" ? navigator.xr : undefined;
    if (!xr?.isSessionSupported) return undefined;
    xr.isSessionSupported("immersive-ar")
      .then((ok) => {
        if (!cancelled) setSupported(Boolean(ok));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return supported;
}

// The modelled queue applies only to the facility it was modelled for.
export function tpaQueueFor(queue, destination) {
  if (!queue || !destination) return null;
  return queue.facility_name === destination ? queue : null;
}

function wholeMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

// P1-3 / L4: the last ~500 m inside the landfill, gate → weighbridge → active
// zone, as a 2D step card that works on every phone. The gate step is the
// driver's own report (device time); the queue ahead and the wait are the
// simulated peak-hour model and say so; the zone has no data in Pythia, so
// the card says to follow the weighbridge officer instead of inventing one.
// AR is offered only where immersive-ar runs, pointing at the verified TPA point.
// Another destination has no queue model: `fallback` (the plain gate button) shows.
export function TpaGuide({ spj, gateAt, onArriveGate, fallback = null }) {
  const { t } = useLanguage();
  const queue = tpaQueueFor(useTpaQueue(), spj.destination);
  const arSupported = useArSupported();
  const [ar, setAr] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!gateAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [gateAt]);

  if (!queue) return fallback;

  const ahead = Number.isFinite(Number(queue.queue_trucks_mean)) ? Math.round(queue.queue_trucks_mean) : null;
  const wait = wholeMinutes(queue.avg_wait_minutes);
  const hour = Number.isInteger(queue.modelled_hour) ? String(queue.modelled_hour).padStart(2, "0") : null;
  const waited = gateAt ? wholeMinutes((now - Date.parse(gateAt)) / 60000) : null;
  const target = { name: queue.facility_name, lat: queue.lat, lng: queue.lng, kecamatan: "", address: "" };

  return (
    <div className="driver-tpa-guide" data-testid="tpa-guide">
      <div className="driver-card-head">
        <h3>{t("drv10_tpa_title")}</h3>
        <span className="driver-badge driver-provenance" data-testid="tpa-guide-sim">
          {t("drv6_sim_badge")}
        </span>
      </div>
      <p className="driver-muted">{t("drv10_tpa_intro")}</p>
      <ol className="driver-tpa-steps">
        <li className={gateAt ? "done" : "current"} data-testid="tpa-step-gate">
          <span className="driver-tpa-icon" aria-hidden="true">
            {gateAt ? <CheckCircle2 size={20} /> : <Flag size={20} />}
          </span>
          <div>
            <strong>{t("drv10_tpa_step_gate")}</strong>
            {gateAt ? (
              <p className="driver-geotag" data-testid="gate-arrived">
                {t("drv6_gate_arrived").replace("{time}", clockTime(gateAt) || "—")}
              </p>
            ) : (
              <>
                <p className="driver-muted">{t("drv10_tpa_gate_todo")}</p>
                <button
                  type="button"
                  className="driver-btn primary"
                  data-testid="gate-arrival"
                  onClick={onArriveGate}
                >
                  <Flag size={18} /> {t("drv6_gate_arrive")}
                </button>
              </>
            )}
          </div>
        </li>
        <li className={gateAt ? "current" : ""} data-testid="tpa-step-weigh">
          <span className="driver-tpa-icon" aria-hidden="true">
            <Scale size={20} />
          </span>
          <div>
            <strong>{t("drv10_tpa_step_weigh")}</strong>
            <dl className="driver-tpa-facts">
              <div data-testid="tpa-queue-ahead">
                <dt>{t("drv10_tpa_queue_label")}</dt>
                <dd>{ahead === null ? "—" : t("drv10_tpa_queue_value").replace("{n}", ahead)}</dd>
              </div>
              <div data-testid="tpa-queue-eta">
                <dt>{t("drv10_tpa_eta_label")}</dt>
                <dd>{wait === null ? "—" : t("drv10_tpa_eta_value").replace("{n}", wait)}</dd>
              </div>
              {waited !== null && (
                <div data-testid="tpa-waited">
                  <dt>{t("drv10_tpa_waited_label")}</dt>
                  <dd>{t("drv10_tpa_eta_value").replace("{n}", waited)}</dd>
                </div>
              )}
            </dl>
            <p className="driver-muted" data-testid="tpa-model-note">
              {hour ? t("drv10_tpa_model_note_hour").replace("{hour}", hour) : t("drv10_tpa_model_note")}
            </p>
          </div>
        </li>
        <li data-testid="tpa-step-zone">
          <span className="driver-tpa-icon" aria-hidden="true">
            <Layers size={20} />
          </span>
          <div>
            <strong>{t("drv10_tpa_step_zone")}</strong>
            <p className="driver-muted">{t("drv10_tpa_zone_desc")}</p>
          </div>
        </li>
      </ol>
      {arSupported && Number.isFinite(Number(target.lat)) && (
        <div className="driver-actions">
          <button
            type="button"
            className="driver-btn ghost"
            data-testid="tpa-ar-open"
            onClick={() => setAr(true)}
          >
            <Navigation size={18} /> {t("drv10_tpa_ar")}
          </button>
          <p className="driver-muted">{t("drv10_tpa_ar_note")}</p>
        </div>
      )}
      {ar && (
        <Suspense fallback={null}>
          <ArNavigator
            spj={null}
            stop={target}
            index={0}
            kicker={t("drv10_tpa_title")}
            orientationPermission="not-required"
            onClose={() => setAr(false)}
            onUseForm={() => setAr(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
