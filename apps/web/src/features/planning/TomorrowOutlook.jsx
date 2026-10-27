import { useEffect, useRef, useState } from "react";
import { CloudRain } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Card, Segmented, Skeleton } from "../../shared/ui/index.js";
import "./outlook.css";

// Fallback when an older API omits `horizons_available`; the API's list wins.
const HORIZONS = [7, 14, 30];

// "2026-10-28" → a local Date on that day (no UTC shift).
function isoDate(iso, add = 0) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1 + add, day || 1);
}

// What moved one day, as quiet inline text: the weather input (rain and its effect against the
// same day dry, a dry day, or the dry-day baseline past the forecast window), then the calendar
// markers (events, a holiday, the weekend).
function dayFacts(day, t, number) {
  const weather = day.drivers.find((d) => d.kind === "weather");
  const normal = day.normal_tons;
  let input = null;
  if (day.beyond_weather_forecast) {
    input = { kind: "baseline", text: t("fh_dry_baseline"), title: t("fh_dry_baseline_title") };
  } else if (weather?.detail?.rainfall_mm > 0) {
    const effect = normal ? signedPercent((weather.effect_tons / normal) * 100) : null;
    input = {
      kind: "rain",
      text: `${number(weather.detail.rainfall_mm, 1)} mm${effect && effect !== "—" ? ` · ${effect}` : ""}`,
      title: t("s3_why_rain_title"),
    };
  } else if (weather) {
    input = { kind: "dry", text: t("ol_dry"), title: t("s3_why_rain_title") };
  }
  const marks = day.drivers
    .filter((d) => d.kind === "event")
    .map((event, index) => ({
      kind: `event-${index}`,
      text: event.detail?.name || "—",
      title: t("ol_event_title"),
    }));
  const holiday = day.drivers.find((d) => d.kind === "holiday");
  if (holiday)
    marks.push({ kind: "holiday", text: holiday.detail?.name || "—", title: t("s3_why_holiday_title") });
  const weekday = day.drivers.find((d) => d.kind === "weekday");
  if (!holiday && weekday?.detail?.weekend) marks.push({ kind: "weekend", text: t("ol_weekend") });
  return { input, marks };
}

// One day in reading order: name and date, tonnes, the learned figure, what moved it.
function DayFacts({ day, when, t, number, locale }) {
  const { input, marks } = dayFacts(day, t, number);
  const date = isoDate(day.date);
  return (
    <>
      <span className="tmr-ol-cell-day">
        {when
          ? t(when === "today" ? "ol_today" : "ol_tomorrow")
          : date.toLocaleDateString(locale, { weekday: "short" })}
        <small>{date.toLocaleDateString(locale, { day: "numeric", month: "short" })}</small>
      </span>
      <strong className="tmr-ol-value">{number(day.total_tons)} t</strong>
      {day.corrected_tons != null && (
        <span className="tmr-ol-corrected" data-testid="tmr-outlook-corrected">
          {t("ol_corrected").replace("{t}", number(day.corrected_tons))}
        </span>
      )}
      {input && (
        <span
          className={`tmr-ol-cell-input is-${input.kind}`}
          title={input.title}
          data-testid="tmr-outlook-input"
          data-kind={input.kind}
        >
          {input.kind === "rain" && <CloudRain size={12} strokeWidth={2} aria-hidden="true" />}
          {input.text}
        </span>
      )}
      {marks.length > 0 && (
        <span className="tmr-ol-cell-marks">
          {marks.map((mark) => (
            <span key={mark.kind} title={mark.title} data-testid="tmr-outlook-mark" data-kind={mark.kind}>
              {mark.text}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

// Tick step for the backtest chart: the smallest of 500 / 1,000 / 2,000 t that gives at most
// five gridline intervals over the data.
function ticksFor(values) {
  let step = 500;
  const bounds = () => [
    Math.floor(Math.min(...values) / step) * step,
    Math.ceil(Math.max(...values) / step) * step,
  ];
  while ((bounds()[1] - bounds()[0]) / step > 5) step *= 2;
  const [lo, hi] = bounds();
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  return { lo, hi: hi > lo ? hi : lo + step, ticks };
}

// Actual weighed intake vs the model's one-month-ahead forecast for every backtested month,
// Lebaran months shaded. The SVG stretches to the plot box (strokes do not scale); labels and
// the hovered month's markers are HTML so they never distort. A hidden table carries the rows.
function BacktestChart({ rows, t, number, monthLabel }) {
  const n = rows.length;
  const [active, setActive] = useState(n - 1);
  const { lo, hi, ticks } = ticksFor(rows.flatMap((r) => [r.actual, r.model]));
  const x = (i) => ((i + 0.5) / n) * 100;
  const y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
  const line = (key) => rows.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r[key])}`).join("");
  const at = Math.min(active, n - 1);
  const row = rows[at];
  return (
    <figure className="tmr-ol-bt" data-testid="tmr-outlook-backtest">
      <div className="tmr-ol-bt-legend" aria-hidden="true">
        <span className="tmr-ol-bt-key is-actual">{t("ol_bt_actual")}</span>
        <span className="tmr-ol-bt-key is-model">{t("ol_bt_model")}</span>
        <span className="tmr-ol-bt-key is-lebaran">{t("ol_bt_lebaran")}</span>
      </div>
      <div className="tmr-ol-bt-plot" aria-hidden="true" onPointerLeave={() => setActive(n - 1)}>
        {ticks.map((v) => (
          <span key={v} className="tmr-ol-bt-tick" style={{ top: `${y(v)}%` }}>
            {number(v)}
          </span>
        ))}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
          {rows.map((r, i) =>
            r.lebaran ? (
              <rect
                key={r.month}
                className="tmr-ol-bt-band"
                x={(i / n) * 100}
                width={100 / n}
                y="0"
                height="100"
              />
            ) : null,
          )}
          {ticks.map((v) => (
            <line key={v} className="tmr-ol-bt-grid" x1="0" x2="100" y1={y(v)} y2={y(v)} />
          ))}
          <line className="tmr-ol-bt-guide" x1={x(at)} x2={x(at)} y1="0" y2="100" />
          <path className="tmr-ol-bt-actual" d={line("actual")} />
          <path className="tmr-ol-bt-model" d={line("model")} />
          {rows.map((r, i) => (
            <rect
              key={r.month}
              className="tmr-ol-bt-hit"
              x={(i / n) * 100}
              width={100 / n}
              y="0"
              height="100"
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </svg>
        <span className="tmr-ol-bt-dot is-actual" style={{ left: `${x(at)}%`, top: `${y(row.actual)}%` }} />
        <span className="tmr-ol-bt-dot is-model" style={{ left: `${x(at)}%`, top: `${y(row.model)}%` }} />
      </div>
      <div className="tmr-ol-bt-axis" aria-hidden="true">
        <span>{monthLabel(rows[0].month)}</span>
        <span>{monthLabel(rows[n - 1].month)}</span>
      </div>
      <p className="tmr-ol-bt-readout" data-testid="tmr-outlook-backtest-readout" aria-hidden="true">
        {t("ol_bt_readout")
          .replace("{month}", monthLabel(row.month))
          .replace("{actual}", number(row.actual))
          .replace("{model}", number(row.model))}
        {row.lebaran ? ` · ${t("ol_bt_lebaran")}` : ""}
      </p>
      {/* A table ignores the 1px sr-only box, so the wrapper clips it. */}
      <div className="sr-only">
        <table>
          <caption>{t("ol_months_label")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("ol_bt_month")}</th>
              <th scope="col">{t("ol_bt_actual")}</th>
              <th scope="col">{t("ol_bt_model")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month} data-testid="tmr-outlook-backtest-row" data-month={r.month}>
                <th scope="row">
                  {monthLabel(r.month)}
                  {r.lebaran ? ` (${t("ol_bt_lebaran")})` : ""}
                </th>
                <td>{number(r.actual)}</td>
                <td>{number(r.model)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

// The horizon's total, average per day, peak day and trucks at the peak, every figure (and the
// truck capacity behind the count) from the API; the learned figure sits under the raw one.
function HorizonSummary({ summary, n, t, number, dayLabel }) {
  const items = [
    {
      key: "total",
      label: t("fh_total").replace("{n}", n),
      value: `${number(summary.total_tons)} t`,
      adjusted: summary.corrected_total_tons,
    },
    {
      key: "avg",
      label: t("fh_avg"),
      value: `${number(summary.avg_tons_per_day)} t`,
      adjusted: summary.corrected_avg_tons_per_day,
    },
    {
      key: "peak",
      label: t("fh_peak"),
      value: `${number(summary.peak_tons)} t`,
      sub: dayLabel(summary.peak_date),
      adjusted: summary.corrected_peak_tons,
    },
    {
      key: "trucks",
      label: t("fh_peak_trucks"),
      value: number(summary.peak_trucks_needed),
      sub: t("fh_trucks_unit"),
      title: t("fh_peak_trucks_title").replace("{cap}", number(summary.truck_capacity_tons)),
    },
  ];
  return (
    <dl className="tmr-ol-sum" data-testid="tmr-outlook-summary" data-provenance="model">
      {items.map((item) => (
        <div
          key={item.key}
          className="tmr-ol-sum-item"
          data-testid={`tmr-outlook-sum-${item.key}`}
          title={item.title}
        >
          <dt>{item.label}</dt>
          <dd>
            <strong className="tmr-ol-sum-value">{item.value}</strong>
            {item.sub && <span className="tmr-ol-sum-sub">{item.sub}</span>}
            {item.adjusted != null && (
              <span className="tmr-ol-corrected" data-testid="tmr-outlook-sum-adjusted">
                {t("fh_adjusted").replace("{t}", number(item.adjusted))}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// Every day of the horizon as a column above or below the horizon's average (the axis reads
// absolute t/day), so a few-percent day-to-day swing stays visible without truncated bars.
// Days past the weather window are dashed. Pointer or arrow keys pick the day the readout
// explains; a hidden table carries every row.
function DailyChart({ days, summary, today, tomorrow, t, number, locale, dayLabel }) {
  const n = days.length;
  const first = days.findIndex((d) => d.date === tomorrow);
  const [active, setActive] = useState(first >= 0 ? first : 0);
  const avg = summary.avg_tons_per_day;
  const devs = days.map((d) => d.total_tons - avg);
  // The data's own range plus a tenth of headroom; the axis labels the top, average and bottom.
  const spread = Math.max(...devs.map(Math.abs), 1);
  const lo = Math.min(0, ...devs) - spread * 0.1;
  const hi = Math.max(0, ...devs) + spread * 0.1;
  const y = (v) => ((hi - v) / (hi - lo)) * 100;
  const beyondFrom = days.findIndex((d) => d.beyond_weather_forecast);
  const at = Math.min(active, n - 1);
  const day = days[at];
  const when = day.date === today ? "today" : day.date === tomorrow ? "tomorrow" : null;
  const onKeyDown = (event) => {
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n - 1 }[event.key];
    if (next == null) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(n - 1, next)));
  };
  return (
    <figure className="tmr-ol-chart" data-testid="tmr-outlook-chart" data-days={n}>
      <div className="tmr-ol-bt-legend" aria-hidden="true">
        <span className="tmr-ol-chart-key">{t("fh_key_forecast")}</span>
        {beyondFrom >= 0 && <span className="tmr-ol-chart-key is-beyond">{t("fh_key_beyond")}</span>}
        <span className="tmr-ol-chart-key is-avg">
          {t("fh_chart_avg").replace("{t}", `${number(avg)} t`)}
        </span>
      </div>
      {beyondFrom > 0 && (
        <p className="tmr-ol-chart-cut-label" aria-hidden="true">
          {/* A margin in % resolves against the label row, which spans the plot's width. */}
          <span style={{ marginLeft: `${(beyondFrom / n) * 100}%` }}>
            {t("fh_axis_beyond").replace("{date}", dayLabel(days[beyondFrom].date))}
          </span>
        </p>
      )}
      <div
        className="tmr-ol-chart-plot"
        tabIndex={0}
        role="group"
        aria-label={t("fh_chart_hint")}
        aria-describedby="tmr-ol-readout"
        onKeyDown={onKeyDown}
        data-testid="tmr-outlook-chart-plot"
      >
        {[hi, 0, lo].map((v) => (
          <span key={v} className="tmr-ol-bt-tick" style={{ top: `${y(v)}%` }} aria-hidden="true">
            {number(avg + v)}
          </span>
        ))}
        <span className="tmr-ol-chart-avg" style={{ top: `${y(0)}%` }} aria-hidden="true" />
        {beyondFrom > 0 && (
          <span
            className="tmr-ol-chart-cut"
            style={{ left: `${(beyondFrom / n) * 100}%` }}
            aria-hidden="true"
            data-testid="tmr-outlook-chart-cut"
          />
        )}
        <div
          className="tmr-ol-chart-cols"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
          aria-hidden="true"
        >
          {days.map((d, i) => (
            <div
              key={d.date}
              className="tmr-ol-chart-col"
              onPointerEnter={() => setActive(i)}
              onClick={() => setActive(i)}
            >
              <span
                className={`tmr-ol-chart-bar${d.beyond_weather_forecast ? " is-beyond" : ""}${i === at ? " is-active" : ""}`}
                style={{ top: `${y(Math.max(devs[i], 0))}%`, height: `${Math.abs(y(devs[i]) - y(0))}%` }}
                data-testid="tmr-outlook-bar"
                data-date={d.date}
                data-value={d.total_tons}
                data-beyond={d.beyond_weather_forecast ? "true" : "false"}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="tmr-ol-bt-axis" aria-hidden="true">
        <span>{dayLabel(days[0].date)}</span>
        <span>{dayLabel(days[n - 1].date)}</span>
      </div>
      <div
        className="tmr-ol-chart-readout"
        id="tmr-ol-readout"
        aria-live="polite"
        data-testid="tmr-outlook-readout"
        data-date={day.date}
      >
        <DayFacts day={day} when={when} t={t} number={number} locale={locale} />
      </div>
      {/* A table ignores the 1px sr-only box, so the wrapper clips it. */}
      <div className="sr-only">
        <table>
          <caption>{t("fh_days_label").replace("{n}", n)}</caption>
          <thead>
            <tr>
              <th scope="col">{t("fh_col_date")}</th>
              <th scope="col">{t("fh_col_tons")}</th>
              <th scope="col">{t("fh_col_adjusted")}</th>
              <th scope="col">{t("fh_col_weather")}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} data-testid="tmr-outlook-row" data-date={d.date}>
                <th scope="row">{dayLabel(d.date)}</th>
                <td>{number(d.total_tons)}</td>
                <td>{d.corrected_tons != null ? number(d.corrected_tons) : "—"}</td>
                <td>{t(d.beyond_weather_forecast ? "fh_weather_no" : "fh_weather_yes")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

// The weighbridge loop as its own panel: status, the correction in force, the weighed days it
// uses and its cap, all from `learned_correction`. Before day `min_days` it names the day the
// correction starts, never a figure.
function LearningPanel({ learned, t, number, dayLabel }) {
  const { active } = learned;
  const windowDays = learned.window_days ?? "—";
  const cap = learned.clamp_pct ?? "—";
  const minDays = learned.min_days ?? "—";
  const items = [
    {
      key: "status",
      label: t("fh_learn_status"),
      value: active
        ? t("fh_learn_active").replace("{n}", number(learned.n_days ?? 0))
        : t("fh_learn_waiting")
            .replace("{min}", minDays)
            .replace("{n}", number(learned.n_days ?? 0)),
    },
    {
      key: "correction",
      label: t("fh_learn_correction"),
      value: active ? signedPercent(learned.pct) : t("fh_learn_correction_from").replace("{min}", minDays),
    },
    {
      key: "days",
      label: t("fh_learn_days"),
      value: t("fh_learn_days_value")
        .replace("{n}", number(learned.n_days ?? 0))
        .replace("{window}", windowDays),
      sub:
        learned.since && learned.last_day
          ? t("fh_learn_since")
              .replace("{from}", dayLabel(learned.since))
              .replace("{to}", dayLabel(learned.last_day))
          : null,
    },
    { key: "cap", label: t("fh_learn_cap"), value: t("fh_learn_cap_value").replace("{cap}", cap) },
  ];
  return (
    <section
      className="tmr-ol-learn"
      aria-labelledby="tmr-ol-learn-title"
      data-testid="tmr-outlook-learning"
      data-active={active ? "true" : "false"}
      data-provenance={learned.classification || ""}
    >
      <h3 className="tmr-ol-learn-title" id="tmr-ol-learn-title">
        {t("fh_learn_title")}
      </h3>
      <dl className="tmr-ol-learn-grid">
        {items.map((item) => (
          <div key={item.key} className="tmr-ol-learn-item" data-testid={`tmr-outlook-learn-${item.key}`}>
            <dt>{item.label}</dt>
            <dd>
              {item.value}
              {item.sub && <small>{item.sub}</small>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="tmr-ol-note" data-testid="tmr-outlook-learn-basis">
        {active
          ? t("fh_learn_basis").replace("{window}", windowDays).replace("{cap}", cap)
          : t("fh_learn_waiting_basis").replace("{min}", minDays)}
        {active && learned.clamped && learned.unclamped_factor != null && (
          <span data-testid="tmr-outlook-learn-clamped">
            {" "}
            {t("fh_learn_clamped")
              .replace("{cap}", cap)
              .replace("{raw}", signedPercent((learned.unclamped_factor - 1) * 100))}
          </span>
        )}
      </p>
    </section>
  );
}

// The days ahead (7 as a calm strip, 14 or 30 as a chart, each with its total, average, peak and
// trucks at the peak), what the weighbridge has taught the forecast, and the Bantargebang intake
// model's backtest on real weighing data. Every input fills itself; every figure comes from
// /api/forecast/outlook. Provenance stays on data-provenance and the heading tooltips.
export function OutlookSection() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [horizon, setHorizon] = useState(7);
  // {days: payload} and {days: true} per horizon; the 7-day payload also carries the months.
  const [byDays, setByDays] = useState({});
  const [failedDays, setFailedDays] = useState({});
  const pending = useRef(new Map());
  const controller = useRef(null);

  const load = (n) => {
    if (!pending.current.has(n)) {
      const request = apiGet(`/forecast/outlook?days=${n}`, { signal: controller.current?.signal })
        .then((payload) => setByDays((prev) => ({ ...prev, [n]: payload })))
        .catch((error) => {
          if (pending.current.get(n) === request) pending.current.delete(n);
          if (error?.name !== "AbortError") setFailedDays((prev) => ({ ...prev, [n]: true }));
        });
      pending.current.set(n, request);
    }
    return pending.current.get(n);
  };

  // The week first; the longer horizons are fetched right after so the switch answers at once
  // (the API caches each horizon for 5 minutes).
  useEffect(() => {
    controller.current = new AbortController();
    const requests = pending.current;
    load(7)
      .then(() => load(14))
      .then(() => load(30));
    return () => {
      controller.current.abort();
      requests.clear();
    };
  }, []);

  const outlook = byDays[7] || null;
  const failed = Boolean(failedDays[7]);
  const current = byDays[horizon] || null;
  const choose = (value) => {
    const n = Number(value);
    setHorizon(n);
    if (!byDays[n]) {
      setFailedDays((prev) => ({ ...prev, [n]: false }));
      load(n);
    }
  };

  const number = (value, digits = 0) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: digits });
  // Percentages keep one decimal ("5.0%", not "5%") so model and rule read side by side.
  const pct = (value) =>
    value == null
      ? "—"
      : Number(value).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const days = current?.week?.days || [];
  const summary = current?.week?.summary;
  const horizons = outlook?.horizons_available || HORIZONS;
  const dayLabel = (iso) =>
    isoDate(iso).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  const beyondFrom = days.find((d) => d.beyond_weather_forecast);
  const intake = outlook?.monthly_intake;
  const months = intake?.available ? intake.months : [];
  const backtest = intake?.backtest;
  const maxHorizon = intake?.backtested_horizon_months?.at(-1) ?? "—";
  const today = outlook?.generated_for;
  const tomorrow = today
    ? (() => {
        const next = isoDate(today);
        next.setDate(next.getDate() + 1);
        return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
      })()
    : null;
  const monthLabel = (ym) =>
    isoDate(`${ym}-01`).toLocaleDateString(locale, { month: "short", year: "numeric" });
  const learned = current?.learned_correction || outlook?.learned_correction;
  // "Nov 2026–Jan 2027", or one value when the list holds one.
  const span = (values) => (values.length > 1 ? `${values[0]}–${values.at(-1)}` : `${values[0]}`);
  const within = months.filter((m) => m.within_backtested_horizon);
  const beyond = months.filter((m) => !m.within_backtested_horizon);
  const rows = backtest?.one_month_ahead || [];
  const evidence =
    backtest?.mape_model_pct != null
      ? t("fh_months_proof")
          .replace("{n}", number(backtest.n_target_months))
          .replace(
            "{period}",
            backtest.first_origin && backtest.last_origin
              ? `${monthLabel(backtest.first_origin)}–${monthLabel(backtest.last_origin)}`
              : backtest.period || "—",
          )
          .replace("{mape}", pct(backtest.mape_model_pct))
          .replace("{naive}", pct(backtest.mape_naive_pct))
          .replace("{max}", maxHorizon)
      : t("fh_months_pending");

  return (
    <Card
      className="tmr-ol"
      title={t("ol_title")}
      titleId="tmr-ol-title"
      aside={t("ol_aside")}
      data-testid="tmr-outlook"
      data-provenance="model"
    >
      {!outlook && !failed && <Skeleton rows={3} label={t("ol_loading")} />}
      {failed && (
        <p className="tmr-inline-error" data-testid="tmr-outlook-error">
          {t("ol_error")}
        </p>
      )}
      {outlook && (
        <>
          <div className="tmr-ol-head">
            <h3 className="tmr-ol-label" data-testid="tmr-outlook-days-heading" title={t("ol_model_title")}>
              {t("fh_days_heading").replace("{n}", horizon)}
            </h3>
            <Segmented
              className="tmr-ol-switch"
              label={t("fh_horizon_label")}
              value={String(horizon)}
              options={horizons.map((n) => ({
                value: String(n),
                label: t("fh_horizon_option").replace("{n}", n),
                testId: `tmr-outlook-horizon-${n}`,
              }))}
              onChange={choose}
            />
          </div>
          {!current && !failedDays[horizon] && (
            <Skeleton rows={2} label={t("fh_loading_days").replace("{n}", horizon)} />
          )}
          {!current && failedDays[horizon] && (
            <p className="tmr-inline-error" data-testid="tmr-outlook-days-error">
              {t("fh_error_days").replace("{n}", horizon)}
            </p>
          )}
          {current && (
            <div className="tmr-ol-range" data-testid="tmr-outlook-range" data-days={days.length}>
              {summary && (
                <HorizonSummary summary={summary} n={days.length} t={t} number={number} dayLabel={dayLabel} />
              )}
              {days.length <= 7 || !summary ? (
                <ol
                  className="tmr-ol-strip"
                  aria-label={t("fh_days_label").replace("{n}", days.length)}
                  data-testid="tmr-outlook-week"
                >
                  {days.map((day) => {
                    const when = day.date === today ? "today" : day.date === tomorrow ? "tomorrow" : null;
                    return (
                      <li
                        key={day.date}
                        className={`tmr-ol-cell${when ? ` is-${when}` : ""}${day.beyond_weather_forecast ? " is-beyond" : ""}`}
                        data-testid="tmr-outlook-day"
                        data-date={day.date}
                        data-when={when || ""}
                        data-value={day.total_tons}
                      >
                        <DayFacts day={day} when={when} t={t} number={number} locale={locale} />
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <DailyChart
                  key={horizon}
                  days={days}
                  summary={summary}
                  today={today}
                  tomorrow={tomorrow}
                  t={t}
                  number={number}
                  locale={locale}
                  dayLabel={dayLabel}
                />
              )}
              <p className="tmr-ol-note" data-testid="tmr-outlook-weather-window">
                {beyondFrom && summary
                  ? t("fh_weather_window")
                      .replace("{with}", summary.days_with_weather_forecast)
                      .replace("{from}", dayLabel(beyondFrom.date))
                  : t("fh_weather_all")}
              </p>
            </div>
          )}

          {learned && <LearningPanel learned={learned} t={t} number={number} dayLabel={dayLabel} />}

          <h3 className="tmr-ol-label tmr-ol-months-label" title={t("ol_model_title")}>
            {t("ol_months")}
          </h3>
          {rows.length > 0 && <BacktestChart rows={rows} t={t} number={number} monthLabel={monthLabel} />}
          <p className="tmr-ol-note">
            <span data-testid="tmr-outlook-evidence">{evidence}</span>
            {backtest?.lebaran_skill_pct != null && (
              <span data-testid="tmr-outlook-lebaran">
                {" "}
                {t("fh_months_lebaran")
                  .replace("{lebaran}", pct(backtest.lebaran_skill_pct))
                  .replace("{normal}", pct(backtest.normal_skill_pct))}
              </span>
            )}
          </p>
          {within.length > 0 && (
            <>
              <h3 className="tmr-ol-label">{t("ol_next")}</h3>
              <ol className="tmr-ol-months" aria-label={t("ol_next")} data-testid="tmr-outlook-months">
                {within.map((month) => (
                  <li
                    key={month.month}
                    className="tmr-ol-month"
                    data-testid="tmr-outlook-month"
                    data-month={month.month}
                    data-within="true"
                  >
                    <span className="tmr-ol-cell-day">{monthLabel(month.month)}</span>
                    <strong className="tmr-ol-value">
                      {number(month.tons_per_day)} {t("hon_mi_unit")}
                    </strong>
                    <span className="tmr-ol-horizon">{t("ol_within").replace("{max}", maxHorizon)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {beyond.length > 0 && (
            <p className="tmr-ol-note" data-testid="tmr-outlook-months-beyond">
              {t("fh_months_more")
                .replace("{months}", span(beyond.map((m) => monthLabel(m.month))))
                .replace("{max}", maxHorizon)}
            </p>
          )}
          {!months.length && (
            <p className="tmr-ol-note" data-testid="tmr-outlook-months-unavailable">
              {t("fh_months_unavailable")}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
