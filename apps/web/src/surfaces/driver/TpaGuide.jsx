import { useEffect, useState } from "react";
import { Camera, Flag, Info, Navigation } from "lucide-react";
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { enqueueDriverOperation, OutboxStorageFullError } from "./DriverOutbox.js";
import { clockTime, mapsDirectionsUrl } from "./driverHelpers.js";
import { destinationTarget, useGateSlot, usePhonePosition } from "./RouteOverview.jsx";
import { ShiftSummary } from "./ShiftSummary.jsx";
import { etaLabelKey, postQueueable, readPhoto, straightLineEta, useDriverTrip } from "./tripApi.js";
import { WeighTicket } from "./WeighTicket.jsx";
import "./driver-trip.css";

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
      .then((raw) => {
        if (cancelled || !raw || typeof raw !== "object") return;
        const body = { ...raw, fetched_at: new Date().toISOString() };
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

// The modelled queue applies only to the facility it was modelled for.
export function tpaQueueFor(queue, destination) {
  if (!queue || !destination) return null;
  return queue.facility_name === destination ? queue : null;
}

function wholeMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function gateKey(spjId) {
  return `pythia_gate_${spjId}`;
}

function readGateAt(spjId) {
  if (!spjId) return null;
  try {
    return localStorage.getItem(gateKey(spjId));
  } catch {
    return null;
  }
}

// "10:00" today as a Date, or null.
function todayAt(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!match) return null;
  const d = new Date();
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d;
}

function useMinuteTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

// S6iuB: the landfill gate. Slot (the plan's model output), expected wait (the
// modelled peak hour, labelled), when to leave (straight-line estimate from the
// phone's GPS), then "I'm at the gate" and the weigh-ticket camera. With stops
// still open (`spj` null) it shows the same card and says what is left first.
// After the receipt it shows the shift summary (`doneScreen`).
export function TpaScreen({
  driver,
  spj,
  routeSpj,
  stopsLeft,
  destinations,
  doneScreen,
  onReceiptDone,
  onDoneBack,
  history,
  instructionFeed,
  safety,
  online,
  pending,
  flushing,
  lastSync,
  say,
  onSignOut,
}) {
  const { t, lang } = useLanguage();
  const trip = spj || routeSpj;
  const queue = tpaQueueFor(useTpaQueue(), trip?.destination);
  const planSlot = useGateSlot(driver?.truck_code, instructionFeed?.list);
  const position = usePhonePosition();
  const tripFeed = useDriverTrip(driver?.truck_code, position);
  const gateSlot = tripFeed.gateSlot || planSlot;
  const now = useMinuteTick();
  const [gateAt, setGateAt] = useState(() => readGateAt(spj?.spj_id));
  const [ticket, setTicket] = useState(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    setGateAt(readGateAt(spj?.spj_id));
    setTicket(null);
  }, [spj?.spj_id]);

  if (doneScreen) {
    return (
      <ShiftSummary
        history={history}
        receipt={doneScreen.receipt}
        spjId={doneScreen.spjId}
        safety={safety}
        online={online}
        pending={pending}
        flushing={flushing}
        lastSync={lastSync}
        onBack={onDoneBack}
        onSignOut={onSignOut}
      />
    );
  }

  if (!trip) {
    return (
      <section className="drt-screen" data-testid="tpa-waiting">
        <h1 className="drt-h1">{t("drv11_tpa_wait_title")}</h1>
        <p className="drt-note">{t("drv_no_spj_desc")}</p>
      </section>
    );
  }

  const target = destinationTarget(trip, destinations);
  const point = Number.isFinite(Number(target.lat)) && target.lat !== null ? target : queue || target;
  const drive = tripFeed.tpaEta || straightLineEta(position, point);
  // The modelled wait of this truck's own slot on the gate board, else the
  // modelled peak-hour wait of the queue model.
  const boardSlots = tripFeed.queue?.slots || [];
  const mySlot = boardSlots.find((s) => s.start === gateSlot?.start);
  const wait = wholeMinutes(mySlot ? mySlot.expected_wait_min : queue?.avg_wait_minutes);
  const maxLoad = Math.max(0, ...boardSlots.map((s) => Number(s.load) || 0));
  const meanLoad = boardSlots.reduce((sum, s) => sum + (Number(s.load) || 0), 0) / (boardSlots.length || 1);
  const ahead = Number.isFinite(Number(queue?.queue_trucks_mean))
    ? Math.round(queue.queue_trucks_mean)
    : null;
  const hour = Number.isInteger(queue?.modelled_hour) ? String(queue.modelled_hour).padStart(2, "0") : null;
  const waited = gateAt ? wholeMinutes((now - Date.parse(gateAt)) / 60000) : null;
  const slotStart = todayAt(gateSlot?.start);
  const departAt = todayAt(gateSlot?.departAt);
  const leaveBy =
    departAt || (slotStart && drive ? new Date(slotStart.getTime() - drive.minutes * 60000) : null);
  const leaveNow = !leaveBy || leaveBy.getTime() <= now;
  const arriveAt = drive ? clockTime(new Date(now + drive.minutes * 60000).toISOString()) : null;
  const mapsHref = mapsDirectionsUrl({ lat: point.lat, lng: point.lng, name: trip.destination });

  const arriveAtGate = async () => {
    const at = new Date().toISOString();
    const path = "/safety/gate-arrival";
    const data = { spj_id: spj.spj_id, arrived_at: at };
    try {
      await postQueueable(path, data);
    } catch (err) {
      if (!err?.network) {
        say(err.message);
        return;
      }
      try {
        await enqueueDriverOperation({ path, data, label: t("drv6_gate_arrive") });
        say(t("drv_queued_offline"));
      } catch (queueErr) {
        say(
          queueErr instanceof OutboxStorageFullError ? t("drv6_storage_full") : t("drv6_gate_failed"),
          8000,
        );
        return;
      }
    }
    try {
      localStorage.setItem(gateKey(spj.spj_id), at);
    } catch {
      // The server (or the queue) holds the arrival; the flag is cosmetic.
    }
    setGateAt(at);
  };

  const takeTicket = async (file) => {
    if (!file || reading) return;
    setReading(true);
    try {
      setTicket(await readPhoto(file));
    } catch (err) {
      say(err.message);
    } finally {
      setReading(false);
    }
  };

  let adviceTitle;
  let adviceSub;
  if (!spj) {
    adviceTitle = t("d2_tpa_after_stops");
    adviceSub = t("drv11_tpa_wait_desc").replace("{n}", stopsLeft);
  } else if (gateAt) {
    adviceTitle = t("d2_tpa_at_gate_title");
    adviceSub =
      waited === null
        ? t("drv6_gate_arrived").replace("{time}", clockTime(gateAt) || "—")
        : t("d2_tpa_waited")
            .replace("{time}", clockTime(gateAt) || "—")
            .replace("{n}", waited);
  } else {
    adviceTitle = leaveNow
      ? t("d2_tpa_leave_now")
      : t("d2_tpa_leave_at").replace("{time}", clockTime(leaveBy.toISOString()));
    adviceSub = drive
      ? t("d2_tpa_drive").replace("{n}", drive.minutes).replace("{time}", arriveAt)
      : t("d2_tpa_drive_none");
  }

  const advice = (
    <>
      <Navigation size={18} aria-hidden="true" />
      <span>
        <strong>{adviceTitle}</strong>
        <small
          data-testid={gateAt ? "tpa-waited" : undefined}
          title={!gateAt && spj && drive ? t(etaLabelKey(drive.source)) : undefined}
        >
          {adviceSub}
        </small>
      </span>
    </>
  );

  return (
    <section
      className="drt-screen is-fill"
      data-testid={spj ? "delivery-card" : "tpa-waiting"}
      data-spj-id={spj?.spj_id}
    >
      <h1 className="drt-h1" data-testid="destination-card">
        {trip.destination}
      </h1>

      <div className="drt-slot" data-testid="tpa-guide">
        <div className="drt-slot-row">
          <div data-testid="tpa-slot" title={gateSlot ? t("d2_model_output") : undefined}>
            <span className="drt-slot-k">{t("d2_tpa_slot")}</span>
            <span className="drt-slot-time">{gateSlot?.start || "—"}</span>
          </div>
          <div data-testid="tpa-queue-eta" data-provenance={wait === null ? undefined : "simulated"}>
            <span className="drt-slot-k">{t("d2_tpa_wait")}</span>
            <span className="drt-slot-wait">
              {wait === null ? "—" : t("drv10_tpa_eta_value").replace("{n}", wait)}
            </span>
          </div>
        </div>
        {mapsHref && !gateAt ? (
          <a
            className="drt-advice"
            href={mapsHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="destination-maps"
            aria-label={`${adviceTitle}. ${adviceSub}. ${t("drv6_maps_open_aria").replace("{name}", trip.destination)}`}
          >
            {advice}
          </a>
        ) : (
          <div className="drt-advice">{advice}</div>
        )}
        {wait !== null && (
          <p className="drt-model" data-testid="tpa-model-note" title={queue?.label || undefined}>
            <Info size={12} aria-hidden="true" />
            {t("d2_tpa_model").replace(
              "{time}",
              clockTime(queue?.fetched_at) || clockTime(new Date(now).toISOString()),
            )}
          </p>
        )}
      </div>

      <section className="drt-card" aria-labelledby="drt-queue-title">
        <h2 className="drt-queue-title" id="drt-queue-title">
          {boardSlots.length > 0 ? t("d2_tpa_queue_title_2h") : t("d2_tpa_queue_title")}
        </h2>
        {boardSlots.length > 0 ? (
          <div data-testid="tpa-queue-bars" data-provenance="simulated" title={t("d2_tpa_bars_model")}>
            <div className="drt-bars" role="img" aria-label={t("d2_tpa_bars_aria")}>
              {boardSlots.map((s) => (
                <span
                  key={s.start}
                  className={s === mySlot ? "is-mine" : Number(s.load) > meanLoad ? "is-busy" : undefined}
                  style={{ height: `${maxLoad ? Math.max(12, (Number(s.load) / maxLoad) * 100) : 12}%` }}
                  title={t("d2_tpa_bar_title")
                    .replace("{start}", s.start)
                    .replace("{end}", s.end)
                    .replace("{n}", wholeMinutes(s.expected_wait_min) ?? "—")}
                />
              ))}
            </div>
            <div className="drt-axis" aria-hidden="true">
              {boardSlots
                .filter((_, i) => i % 2 === 0)
                .map((s) => (
                  <span key={s.start}>{s.start}</span>
                ))}
            </div>
          </div>
        ) : queue ? (
          <p className="drt-note" data-testid="tpa-queue-ahead" data-provenance="simulated">
            {ahead === null
              ? "—"
              : t("d2_tpa_queue_peak")
                  .replace("{hour}", hour || "—")
                  .replace("{n}", ahead.toLocaleString(localeFor(lang)))}
          </p>
        ) : (
          <p className="drt-note">{t("d2_tpa_queue_none")}</p>
        )}
      </section>

      <div className="drt-spacer" />

      {!spj ? null : !gateAt ? (
        <button type="button" className="drt-btn is-dark" data-testid="gate-arrival" onClick={arriveAtGate}>
          <Flag size={18} aria-hidden="true" /> {t("d2_tpa_at_gate")}
        </button>
      ) : (
        <>
          <p className="drt-at-gate" data-testid="gate-arrived">
            {t("drv6_gate_arrived").replace("{time}", clockTime(gateAt) || "—")}
          </p>
          <label
            className="drt-btn is-primary drt-camera"
            data-testid="receipt-camera"
            aria-disabled={reading || undefined}
          >
            <input
              id="receipt-photo"
              data-testid="receipt-input"
              type="file"
              accept="image/*"
              capture="environment"
              className="drt-file"
              disabled={reading}
              onChange={(e) => {
                takeTicket(e.target.files?.[0]);
                e.target.value = ""; // permit choosing the same image again
              }}
            />
            <Camera size={20} aria-hidden="true" /> {t("d2_tpa_ticket_camera")}
          </label>
        </>
      )}

      {ticket && spj && (
        <WeighTicket
          spj={spj}
          photo={ticket}
          online={online}
          pending={pending}
          flushing={flushing}
          onBack={() => setTicket(null)}
          onDone={(receipt) => {
            setTicket(null);
            onReceiptDone(receipt, spj.spj_id);
          }}
          say={say}
        />
      )}
    </section>
  );
}
