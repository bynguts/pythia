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

// The week ahead (city-wide t/day with what moved each day) and the next three months of
// Bantargebang intake with the error the model scored on real weighing data. Every input
// fills itself; every figure and its evidence come from /api/forecast/outlook.
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
  const evidence =
    backtest?.mape_model_pct != null
      ? t("ol_evidence")
          .replace("{mape}", number(backtest.mape_model_pct, 1))
          .replace("{period}", backtest.period || "—")
          .replace("{naive}", number(backtest.mape_naive_pct, 1))
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

          <h3 className="tmr-ol-label">{t("ol_months")}</h3>
          {months.length ? (
            <ol className="tmr-ol-months" aria-label={t("ol_months_label")} data-testid="tmr-outlook-months">
              {months.map((month) => (
                <li
                  key={month.month}
                  className="tmr-ol-month"
                  data-testid="tmr-outlook-month"
                  data-month={month.month}
                  data-within={month.within_backtested_horizon ? "true" : "false"}
                >
                  <span className="tmr-ol-day-name">{monthLabel(month.month)}</span>
                  <strong className="tmr-ol-value">
                    {number(month.tons_per_day)} {t("hon_mi_unit")}
                  </strong>
                  <span className="tmr-ol-horizon">
                    {(month.within_backtested_horizon ? t("ol_within") : t("ol_beyond"))
                      .replace("{h}", month.horizon_months)
                      .replace("{max}", maxHorizon)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="tmr-ol-note" data-testid="tmr-outlook-months-unavailable">
              {t("ol_unavailable")}
            </p>
          )}
          <p className="tmr-ol-note" data-testid="tmr-outlook-evidence">
            {evidence}
            {intake?.fitted_through &&
              ` · ${t("ol_fitted").replace("{month}", monthLabel(intake.fitted_through))}`}
          </p>
        </>
      )}
    </Card>
  );
}
