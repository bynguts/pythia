import { useEffect, useState } from "react";
import { apiGet } from "../../shared/api/client.js";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Card, Skeleton, Tag } from "../../shared/ui/index.js";
import "./outlook.css";

const MAX_CHIPS = 3;

// "2026-10-28" → a local Date on that day (no UTC shift).
function isoDate(iso, add = 0) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1 + add, day || 1);
}

// The chips that moved one day, in the order the operator reads them: missing weather,
// rain, events, holiday, weekend.
function dayChips(day, t, number) {
  const chips = [];
  const weather = day.drivers.find((d) => d.kind === "weather");
  const normal = day.normal_tons;
  if (day.beyond_weather_forecast) {
    chips.push({
      key: "noweather",
      text: t("ol_no_weather"),
      title: t("ol_no_weather_title"),
      tone: "is-warn",
    });
  } else if (weather?.detail?.rainfall_mm > 0) {
    const effect = normal ? signedPercent((weather.effect_tons / normal) * 100) : null;
    chips.push({
      key: "rain",
      text: `${t("ol_rain").replace("{mm}", number(weather.detail.rainfall_mm, 1))}${effect ? ` ${effect}` : ""}`,
      title: t("s3_why_rain_title"),
    });
  } else if (weather) {
    chips.push({ key: "dry", text: t("ol_dry"), title: t("s3_why_rain_title") });
  }
  day.drivers
    .filter((d) => d.kind === "event")
    .forEach((event, index) =>
      chips.push({
        key: `event-${index}`,
        text: t("ol_event").replace("{name}", event.detail?.name || "—"),
        title: t("ol_event_title"),
      }),
    );
  const holiday = day.drivers.find((d) => d.kind === "holiday");
  if (holiday)
    chips.push({ key: "holiday", text: holiday.detail?.name || "—", title: t("s3_why_holiday_title") });
  const weekday = day.drivers.find((d) => d.kind === "weekday");
  if (!holiday && weekday?.detail?.weekend) chips.push({ key: "weekend", text: t("ol_weekend") });
  return chips.slice(0, MAX_CHIPS);
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

// The week ahead (city-wide t/day with what moved each day) and the Bantargebang intake model's
// backtest on real weighing data: actual vs model per month, its error against the best simple
// rule and where the gain comes from. Next months show a figure only inside the backtested
// horizon. Every input fills itself; every figure comes from /api/forecast/outlook.
export function OutlookSection() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [outlook, setOutlook] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiGet("/forecast/outlook", { signal: controller.signal })
      .then(setOutlook)
      .catch((error) => error?.name !== "AbortError" && setFailed(true));
    return () => controller.abort();
  }, []);

  const number = (value, digits = 0) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: digits });
  // Percentages keep one decimal ("5.0%", not "5%") so model and rule read side by side.
  const pct = (value) =>
    value == null
      ? "—"
      : Number(value).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const days = outlook?.week?.days || [];
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
  const learned = outlook?.learned_correction;
  // "Nov 2026–Jan 2027", or one value when the list holds one.
  const span = (values) => (values.length > 1 ? `${values[0]}–${values.at(-1)}` : `${values[0]}`);
  const within = months.filter((m) => m.within_backtested_horizon);
  const beyond = months.filter((m) => !m.within_backtested_horizon);
  const rows = backtest?.one_month_ahead || [];
  const evidence =
    backtest?.mape_model_pct != null
      ? t("ol_evidence")
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
      : t("ol_evidence_none");

  return (
    <Card
      className="tmr-ol"
      title={t("ol_title")}
      titleId="tmr-ol-title"
      aside={t("ol_aside")}
      actions={
        <Tag tone="model" title={t("ol_model_title")}>
          {t("s3_model")}
        </Tag>
      }
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
          <h3 className="tmr-ol-label">{t("ol_week")}</h3>
          <ol className="tmr-ol-days" aria-label={t("ol_week_label")} data-testid="tmr-outlook-week">
            {days.map((day) => {
              const when = day.date === today ? "today" : day.date === tomorrow ? "tomorrow" : null;
              return (
                <li
                  key={day.date}
                  className={`tmr-ol-day${when ? ` is-${when}` : ""}`}
                  data-testid="tmr-outlook-day"
                  data-date={day.date}
                  data-when={when || ""}
                  data-value={day.total_tons}
                >
                  <span className="tmr-ol-day-name">
                    {when
                      ? t(when === "today" ? "ol_today" : "ol_tomorrow")
                      : isoDate(day.date).toLocaleDateString(locale, { weekday: "short" })}
                    <small>
                      {isoDate(day.date).toLocaleDateString(locale, { day: "numeric", month: "short" })}
                    </small>
                  </span>
                  <strong className="tmr-ol-value">{number(day.total_tons)} t</strong>
                  {day.corrected_tons != null && (
                    <span className="tmr-ol-corrected" data-testid="tmr-outlook-corrected">
                      {t("ol_corrected").replace("{t}", number(day.corrected_tons))}
                    </span>
                  )}
                  <span className="tmr-ol-chips">
                    {dayChips(day, t, number).map((chip) => (
                      <span
                        key={chip.key}
                        className={`tmr-ol-chip ${chip.tone || ""}`.trim()}
                        title={chip.title}
                        data-testid="tmr-outlook-chip"
                        data-kind={chip.key}
                      >
                        {chip.text}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ol>

          {learned && (
            <p
              className="tmr-ol-note"
              data-testid="tmr-outlook-learning"
              data-active={learned.active ? "true" : "false"}
              title={t("ol_learning_title").replace("{cap}", learned.clamp_pct ?? "—")}
            >
              {learned.active
                ? t("ol_learning")
                    .replace("{n}", number(learned.n_days))
                    .replace("{pct}", signedPercent(learned.pct))
                : [
                    t("ol_learning_off").replace("{min}", learned.min_days ?? "—"),
                    learned.n_days > 0
                      ? t("ol_learning_so_far").replace("{n}", number(learned.n_days))
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
          )}

          <h3 className="tmr-ol-label">{t("ol_months")}</h3>
          {rows.length > 0 && <BacktestChart rows={rows} t={t} number={number} monthLabel={monthLabel} />}
          <p className="tmr-ol-note" data-testid="tmr-outlook-evidence">
            {evidence}
          </p>
          {backtest?.lebaran_skill_pct != null && (
            <p className="tmr-ol-note" data-testid="tmr-outlook-lebaran">
              {t("ol_lebaran")
                .replace("{lebaran}", pct(backtest.lebaran_skill_pct))
                .replace("{normal}", pct(backtest.normal_skill_pct))}
            </p>
          )}
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
                    <span className="tmr-ol-day-name">{monthLabel(month.month)}</span>
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
              {t("ol_beyond")
                .replace("{months}", span(beyond.map((m) => monthLabel(m.month))))
                .replace("{h}", span(beyond.map((m) => m.horizon_months)))
                .replace("{through}", intake.fitted_through ? monthLabel(intake.fitted_through) : "—")
                .replace("{max}", maxHorizon)}
            </p>
          )}
          {!months.length && (
            <p className="tmr-ol-note" data-testid="tmr-outlook-months-unavailable">
              {t("ol_unavailable")}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
