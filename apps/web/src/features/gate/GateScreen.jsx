import { Check, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiPost } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { useConsole } from "../../app/console/useConsole.js";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Kpi,
  KpiStrip,
  Segmented,
  Skeleton,
  StatusDot,
  Tag,
} from "../../shared/ui/index.js";
import {
  addDays,
  boardWindow,
  currentSlot,
  isPeakSlot,
  jakartaClock,
  jakartaDay,
  laneClosure,
  latestArrivals,
  listTrucks,
  longestWait,
  nowMinutes,
  peakSlot,
  plannedTotal,
} from "./gateModel.js";
import { useGateData } from "./useGateData.js";
import "./gate.css";

const DISMISS_KEY = "pythia_gate_dismissed";

function readDismissed() {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]");
  } catch {
    return [];
  }
}

const minutes = (value, lang) =>
  value == null ? "—" : Number(value).toLocaleString(localeFor(lang), { maximumFractionDigits: 0 });

function WaitChart({ slots, capacity, nowMin, t, lang }) {
  const max = Math.max(1, ...slots.map((slot) => slot.expected_wait_min || 0));
  const live = nowMin == null ? null : currentSlot(slots, nowMin);
  return (
    <Card
      title={t("s4_chart_title")}
      titleId="gate-chart-title"
      className="gate-chart"
      aside={
        <span className="gate-legend" aria-hidden="true">
          <span className="gate-legend-item is-normal">{t("s4_legend_normal")}</span>
          <span className="gate-legend-item is-peak">{t("s4_legend_peak")}</span>
          {live && <span className="gate-legend-item is-now">{t("s4_legend_now")}</span>}
        </span>
      }
    >
      <div
        className="gate-bars"
        role="img"
        aria-label={t("s4_chart_label")}
        data-testid="gate-wait-chart"
        data-provenance="simulated"
        title={t("s4_sim_title")}
      >
        {slots.map((slot) => {
          const tone = slot === live ? "now" : isPeakSlot(slot, capacity) ? "peak" : "normal";
          return (
            <span
              key={slot.start}
              className={`gate-bar is-${tone}`}
              style={{ height: `${Math.max(4, ((slot.expected_wait_min || 0) / max) * 100)}%` }}
              title={`${slot.start} · ${minutes(slot.expected_wait_min, lang)} ${t("s4_min")}`}
            />
          );
        })}
      </div>
      <div className="gate-axis" aria-hidden="true">
        {slots.map((slot, index) => (
          <span key={slot.start} className={index >= slots.length - 3 ? "is-end" : undefined}>
            {slot.start.endsWith(":00") ? slot.start : ""}
          </span>
        ))}
      </div>
    </Card>
  );
}

function SlotBoard({ slots, capacity, nowMin, t, lang }) {
  const rows = boardWindow(slots, nowMin);
  const columns = [
    { key: "slot", label: t("s4_col_slot"), width: 120, render: (slot) => <strong>{slot.start}</strong> },
    {
      key: "trucks",
      label: t("s4_col_trucks"),
      render: (slot) =>
        (slot.planned_trucks || []).length ? (
          <span className="gate-chips">
            {slot.planned_trucks.map((code) => (
              <span key={code} className="gate-chip">
                {code}
              </span>
            ))}
          </span>
        ) : (
          <span className="gate-muted">—</span>
        ),
    },
    {
      key: "wait",
      label: t("s4_col_wait"),
      render: (slot) => {
        const peak = isPeakSlot(slot, capacity);
        return (
          <span className="gate-wait-cell">
            <StatusDot tone={peak ? "warn" : "ok"}>
              {minutes(slot.expected_wait_min, lang)} {t("s4_min")}
            </StatusDot>
            {peak && <Tag tone="warn">{t("s4_peak")}</Tag>}
          </span>
        );
      },
    },
  ];
  return (
    <Card
      title={t("s4_board_title")}
      titleId="gate-board-title"
      aside={t(nowMin == null ? "s4_board_first" : "s4_board_next")}
      flush
    >
      <DataTable
        testId="gate-slot-board"
        caption={t("s4_board_title")}
        columns={columns}
        rows={rows}
        rowKey={(slot) => slot.start}
        rowTone={(slot) => (isPeakSlot(slot, capacity) ? "warn" : undefined)}
        empty={<p className="gate-empty-note">{t("s4_board_empty")}</p>}
      />
    </Card>
  );
}

function RecHead({ t }) {
  return (
    <header className="gate-rec-head">
      <Sparkles size={15} aria-hidden="true" />
      <h2 id="gate-rec-title">{t("s4_rec_label")}</h2>
      <Tag tone="model" title={t("s4_model_title")}>
        {t("s4_model")}
      </Tag>
    </header>
  );
}

function Recommendation({ board, onChanged, t, lang }) {
  const { permissions } = useConsole();
  const canDispatch = permissions.includes("dispatch:create");
  const [dismissed, setDismissed] = useState(readDismissed);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const recs = (board.recommendations || []).filter((rec) => !dismissed.includes(rec.id));
  const open = recs.filter((rec) => !rec.accepted);
  const impact = board.impact;

  if (recs.length === 0) {
    const reason = (board.recommendations || []).length
      ? "s4_rec_dismissed"
      : board.reason === "no_approved_plan"
        ? "w12_gate_no_plan"
        : board.reason === "saturated"
          ? "w12_gate_saturated"
          : "w12_gate_no_holds";
    return (
      <section className="ui-card gate-rec" aria-labelledby="gate-rec-title" data-testid="gate-slot-recs">
        <RecHead t={t} />
        <p className="gate-rec-quiet" data-testid="gate-slot-empty">
          {t(reason).replace("{slots}", (board.saturated_slots || []).join(", "))}
        </p>
      </section>
    );
  }

  const trucks = [...new Set(recs.map((rec) => rec.truck_code))];
  const holds = recs.map((rec) => rec.hold_minutes);
  const low = Math.min(...holds);
  const high = Math.max(...holds);
  const hold = low === high ? String(low) : `${low}–${high}`;
  const names = listTrucks(trucks, localeFor(lang));
  const slotList = recs.map((rec) => `${rec.truck_code} ${t("s4_at")} ${rec.to_slot}`).join(", ");
  const everySent = open.length === 0;

  async function accept() {
    setSending(true);
    setFailed(false);
    try {
      for (const rec of open) {
        await apiPost(`/gate/slots/recommendations/${encodeURIComponent(rec.id)}/accept`);
      }
    } catch {
      setFailed(true);
    }
    setSending(false);
    onChanged();
  }

  function dismiss() {
    const next = [...dismissed, ...recs.map((rec) => rec.id)];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the dismissal lasts until the page reloads.
    }
  }

  return (
    <section className="ui-card gate-rec" aria-labelledby="gate-rec-title" data-testid="gate-slot-recs">
      <RecHead t={t} />
      <h3 className="gate-rec-title" data-testid="gate-slot-rec">
        {t("s4_rec_title").replace("{trucks}", names).replace("{minutes}", hold)}
      </h3>
      {impact && !everySent && (
        <dl className="gate-impact" data-testid="gate-impact">
          <div>
            <dt>{t("s4_impact_peak")}</dt>
            <dd>
              {minutes(impact.peak_wait_before, lang)} {t("s4_min")} <span aria-hidden="true">→</span>{" "}
              <strong>
                {minutes(impact.peak_wait_after, lang)} {t("s4_min")}
              </strong>
            </dd>
          </div>
          <div>
            <dt>{t("s4_impact_longest")}</dt>
            <dd>
              {minutes(impact.longest_wait_before, lang)} {t("s4_min")} <span aria-hidden="true">→</span>{" "}
              <strong>
                {minutes(impact.longest_wait_after, lang)} {t("s4_min")}
              </strong>
            </dd>
          </div>
        </dl>
      )}
      {everySent ? (
        <p className="gate-rec-sent" data-testid="gate-slot-accepted">
          <Check size={15} aria-hidden="true" /> {t("w12_gate_sent")}
        </p>
      ) : (
        <>
          <p className="gate-rec-note">
            {t(trucks.length === 2 ? "s4_rec_explain_two" : "s4_rec_explain")
              .replace("{n}", trucks.length)
              .replace("{slots}", slotList)}
          </p>
          <div className="gate-rec-actions">
            {canDispatch && (
              <Button
                variant="primary"
                icon={Check}
                onClick={accept}
                disabled={sending}
                data-testid="gate-slot-accept"
              >
                {t("s4_accept")}
              </Button>
            )}
            <Button onClick={dismiss} data-testid="gate-slot-dismiss">
              {t("s4_dismiss")}
            </Button>
          </div>
        </>
      )}
      {failed && (
        <p className="gate-rec-error" role="alert">
          {t("w12_gate_apply_failed")}
        </p>
      )}
    </section>
  );
}

function Arrivals({ safety, t, lang }) {
  const rows = latestArrivals(safety?.trucks);
  const simulated = safety && safety.classification !== "OBSERVED";
  return (
    <Card
      title={t("s4_arrivals_title")}
      titleId="gate-arrivals-title"
      className="gate-arrivals"
      aside={
        simulated ? (
          <span data-provenance="simulated" title={t("s4_sim_title")}>
            {t("s4_arrivals_sim")}
          </span>
        ) : (
          t("s4_arrivals_driver_app")
        )
      }
      flush
    >
      {rows.length === 0 ? (
        <p className="gate-empty-note">{t("s4_arrivals_empty")}</p>
      ) : (
        <ul className="gate-arrival-list" data-testid="gate-arrivals">
          {rows.map((truck) => (
            <li key={truck.truck_code}>
              <time className="gate-muted">{jakartaClock(truck.gate_arrived_at)}</time>
              <strong>{truck.truck_code}</strong>
              <StatusDot tone={truck.gate_state === "alert" ? "warn" : "ok"}>
                {t("s4_waited").replace("{n}", minutes(truck.gate_wait_minutes, lang))}
              </StatusDot>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Kpis({ day, board, safety, recap, queue, t, lang, nowMin }) {
  const slots = board?.slots || [];
  const simulatedGate = safety && safety.classification !== "OBSERVED";
  const modelTag = (
    <Tag tone="model" title={t("s4_model_title")}>
      {t("s4_model")}
    </Tag>
  );
  const peak = peakSlot(slots);
  const peakKpi = (
    <Kpi
      testId="gate-kpi-peak"
      label={t("s4_kpi_peak")}
      tag={modelTag}
      value={peak ? peak.start : "—"}
      sub={peak ? t("s4_per_truck_wait").replace("{n}", minutes(peak.expected_wait_min, lang)) : null}
    />
  );

  if (day === "tomorrow") {
    const plan = plannedTotal(slots);
    const mean = board?.modelled_wait?.mean_per_truck_min;
    const impact = board?.impact;
    return (
      <KpiStrip label={t("s4_kpis_label")}>
        <Kpi
          testId="gate-kpi-mean"
          label={t("s4_kpi_mean")}
          tag={modelTag}
          value={mean == null ? "—" : minutes(mean, lang)}
          unit={mean == null ? null : t("s4_min")}
          sub={t("s4_per_truck")}
        />
        <Kpi
          testId="gate-kpi-planned"
          label={t("s4_kpi_planned")}
          value={plan || "—"}
          sub={t("s4_planned_sub")}
        />
        {peakKpi}
        <Kpi
          testId="gate-kpi-longest"
          label={t("s4_kpi_longest_planned")}
          tag={modelTag}
          value={impact ? minutes(impact.longest_wait_before, lang) : "—"}
          unit={impact ? t("s4_min") : null}
          sub={t("s4_longest_planned_sub")}
        />
      </KpiStrip>
    );
  }

  const live = currentSlot(slots, nowMin);
  const useBoard = live && board.reason !== "no_approved_plan";
  const queueWait = useBoard ? live.expected_wait_min : queue?.avg_wait_minutes;
  const waiting = useBoard ? Math.round(live.queue_carried_in || 0) : queue?.trucks_in_queue;
  const arrived = recap?.actual?.ritasi;
  const planned = recap?.forecast?.planned_trips ?? (plannedTotal(slots) || null);
  const longest = longestWait(safety?.trucks);
  const limit = safety?.gate_alert_at_minutes;
  return (
    <KpiStrip label={t("s4_kpis_label")}>
      <Kpi
        testId="gate-kpi-queue"
        label={t("s4_kpi_queue")}
        tag={modelTag}
        value={queueWait == null ? "—" : minutes(queueWait, lang)}
        unit={queueWait == null ? null : t("s4_min")}
        sub={waiting == null ? t("s4_per_truck") : t("s4_per_truck_waiting").replace("{n}", waiting)}
      />
      <Kpi
        testId="gate-kpi-arrived"
        label={t("s4_kpi_arrived")}
        value={arrived ?? "—"}
        sub={planned ? t("s4_of_planned").replace("{n}", planned) : null}
      />
      {peakKpi}
      <Kpi
        testId="gate-kpi-longest"
        label={t("s4_kpi_longest")}
        tag={
          simulatedGate ? (
            <Tag data-provenance="simulated" title={t("s4_sim_title")}>
              {t("s4_simulated")}
            </Tag>
          ) : null
        }
        value={longest ? minutes(longest.gate_wait_minutes, lang) : "—"}
        unit={longest ? t("s4_min") : null}
        sub={
          longest
            ? `${longest.truck_code} ${t("s4_at")} ${jakartaClock(longest.gate_arrived_at) || "—"}${limit ? ` · ${t("s4_limit").replace("{n}", limit)}` : ""}`
            : t("s4_no_arrivals")
        }
      />
    </KpiStrip>
  );
}

export function GateScreen() {
  const { t, lang } = useLanguage();
  const { setSubtitle } = useConsole();
  const [day, setDay] = useState("today");
  const todayIso = jakartaDay();
  const isoDay = day === "today" ? todayIso : addDays(todayIso, 1);
  const { board, safety, recap, queue, facts, loading, failed, reload } = useGateData(day, isoDay);
  const nowMin = day === "today" ? nowMinutes() : null;
  const slots = board?.slots || [];
  const closure = laneClosure(facts?.facts);

  useEffect(() => {
    const label = new Intl.DateTimeFormat(localeFor(lang), {
      timeZone: "Asia/Jakarta",
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date());
    setSubtitle(`${t("s4_facility")} · ${label}`);
    return () => setSubtitle(null);
  }, [lang, t, setSubtitle]);

  const subtitle = useMemo(() => {
    const parts = [t("s4_facility")];
    if (closure) parts.push(t("s4_lane_closed").replace("{from}", closure.from).replace("{to}", closure.to));
    parts.push(t("s4_slots_note").replace("{n}", board?.slot_minutes || 15));
    return parts.join(" · ");
  }, [t, closure, board?.slot_minutes]);

  return (
    <div className="gate-page" data-testid="gate-page">
      <header className="gate-head">
        <div>
          <h1>{t("s4_title")}</h1>
          <p className="gate-sub">{subtitle}</p>
        </div>
        <Segmented
          label={t("s4_day_label")}
          value={day}
          onChange={setDay}
          options={[
            { value: "today", label: t("s4_today"), testId: "gate-day-today" },
            { value: "tomorrow", label: t("s4_tomorrow"), testId: "gate-day-tomorrow" },
          ]}
        />
      </header>

      {failed && !board ? (
        <ErrorState title={t("s4_error_title")} reason={t("s4_error_reason")} onRetry={reload} />
      ) : loading && !board ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <Kpis
            day={day}
            board={board}
            safety={safety}
            recap={recap}
            queue={queue}
            t={t}
            lang={lang}
            nowMin={nowMin}
          />
          <div className="gate-grid">
            <div className="gate-main">
              {slots.length === 0 ? (
                <Card title={t("s4_chart_title")} titleId="gate-chart-title">
                  <EmptyState
                    title={t("s4_no_board_title")}
                    body={t(board?.reason === "no_approved_plan" ? "w12_gate_no_plan" : "s4_no_board_body")}
                    testId="gate-no-board"
                  />
                </Card>
              ) : (
                <>
                  <WaitChart
                    slots={slots}
                    capacity={board.capacity_per_slot}
                    nowMin={nowMin}
                    t={t}
                    lang={lang}
                  />
                  <SlotBoard
                    slots={slots}
                    capacity={board.capacity_per_slot}
                    nowMin={nowMin}
                    t={t}
                    lang={lang}
                  />
                </>
              )}
            </div>
            <aside className="gate-side">
              {board && <Recommendation key={isoDay} board={board} onChanged={reload} t={t} lang={lang} />}
              {day === "today" && <Arrivals safety={safety} t={t} lang={lang} />}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
