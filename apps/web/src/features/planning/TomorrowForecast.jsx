import { useState } from "react";
import { Calendar, CloudRain, Flag, MessageSquareText, OctagonX, Plus, Users, Wrench, X } from "lucide-react";
import { signedPercent } from "../../shared/hooks/useSnapshot.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Button, Card, Skeleton } from "../../shared/ui/index.js";
import { mentionedTruck } from "./tomorrowModel.js";

// Where an event driver comes from (GET /api/forecast/tomorrow `drivers[].source`).
const EVENT_SOURCE_KEYS = {
  "official calendar": "lx_event_src_official",
  "permit intake": "lx_event_src_permit",
};

const SOURCE_ICONS = {
  tpa_notice: OctagonX,
  workshop: Wrench,
  district_office: Users,
  other: MessageSquareText,
};

// City-wide waste tomorrow: the model's total, its change against today and the drivers
// the forecast filled in by itself (weather, events, holiday, weekday).
export function ForecastCard({ forecast, error }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const number = (value, digits = 0) =>
    Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: digits });

  if (!forecast) {
    return (
      <section className="tmr-fc" aria-labelledby="tmr-fc-title" data-testid="tmr-forecast">
        <div className="tmr-fc-top">
          <h2 className="tmr-fc-label" id="tmr-fc-title">
            {t("s3_fc_title")}
          </h2>
        </div>
        {error ? <p className="tmr-inline-error">{t("s3_fc_error")}</p> : <Skeleton rows={3} />}
      </section>
    );
  }

  const day = forecast.day ?? 0;
  const totals = forecast.horizon?.daily_total_tons || [];
  const deltaPct =
    day > 0 && totals[day - 1] > 0 ? ((totals[day] - totals[day - 1]) / totals[day - 1]) * 100 : null;
  const drivers = forecast.drivers || [];
  const normal = forecast.normal_day_tonnage_t || forecast.total_tonnage_t || 0;
  const pct = (tons, base) => (tons == null || !base ? null : (tons / base) * 100);
  const effect = (value) => {
    if (value == null) return { text: "—", tone: "is-muted" };
    const text = signedPercent(value);
    return { text, tone: text.startsWith("+") ? "is-up" : text.startsWith("−") ? "is-down" : "" };
  };

  const weather = drivers.find((d) => d.kind === "weather");
  const events = drivers.filter((d) => d.kind === "event");
  const holiday = drivers.find((d) => d.kind === "holiday");
  const weekday = drivers.find((d) => d.kind === "weekday");
  const rows = [];
  if (weather) {
    const mm = weather.detail?.rainfall_mm;
    rows.push({
      key: "weather",
      kind: "weather",
      icon: CloudRain,
      text: mm > 0 ? t("s3_why_rain").replace("{mm}", number(mm, 1)) : t("s3_why_dry"),
      title: t(
        weather.input_classification === "REAL_FORECAST_INPUT"
          ? "s3_why_rain_title"
          : "s3_why_rain_title_none",
      ),
      effect: effect(pct(weather.effect_tons, normal)),
    });
  }
  if (events.length) {
    events.forEach((event, index) => {
      const reason = event.effect_reason;
      rows.push({
        key: `event-${index}`,
        kind: "event",
        icon: Calendar,
        text: event.detail?.name || "—",
        title: reason ? t(`s3_why_${reason}`) : t(EVENT_SOURCE_KEYS[event.source] || "lx_event_src_other"),
        effect: reason
          ? { text: t("s3_why_not_modelled"), tone: "is-muted" }
          : effect(pct(event.effect_tons, forecast.total_tonnage_t)),
      });
    });
  } else {
    rows.push({
      key: "events",
      kind: "event",
      icon: Calendar,
      text: t("s3_why_no_events"),
      effect: effect(0),
    });
  }
  if (holiday) {
    rows.push({
      key: "holiday",
      kind: "holiday",
      icon: Flag,
      text: t("s3_why_holiday").replace("{name}", holiday.detail?.name || "—"),
      title: t("s3_why_holiday_title"),
      effect: effect(null),
    });
  } else if (weekday) {
    rows.push({
      key: "weekday",
      kind: "weekday",
      icon: Flag,
      text: t(weekday.detail?.weekend ? "s3_why_weekend" : "s3_why_workday"),
      // A weekday is the model's normal day; a weekend's effect is not separated.
      effect: weekday.detail?.weekend ? effect(null) : effect(0),
    });
  }

  const showWithEvents =
    forecast.with_events_total_t != null && forecast.with_events_total_t !== forecast.total_tonnage_t;

  return (
    <section
      className="tmr-fc"
      aria-labelledby="tmr-fc-title"
      data-testid="tmr-forecast"
      data-provenance="model"
      data-date={forecast.date}
    >
      <div className="tmr-fc-top">
        <h2 className="tmr-fc-label" id="tmr-fc-title" title={t("s3_model_title")}>
          {t("s3_fc_title")}
        </h2>
      </div>
      <div className="tmr-fc-value">
        <strong data-testid="plan-total" data-value={forecast.total_tonnage_t}>
          {number(forecast.total_tonnage_t)} t
        </strong>
        <span data-testid="tmr-forecast-delta">
          {deltaPct != null
            ? t("s3_fc_delta")
                .replace("{pct}", signedPercent(deltaPct))
                .replace("{n}", number(forecast.kecamatan_count))
            : t("s3_fc_districts").replace("{n}", number(forecast.kecamatan_count))}
        </span>
      </div>
      <ul className="tmr-why" data-testid="plan-drivers" data-date={forecast.date}>
        <li className="tmr-why-title" aria-hidden="true">
          {t("s3_why")}
        </li>
        {rows.map((row) => (
          <li key={row.key} data-testid="plan-driver" data-kind={row.kind} title={row.title}>
            <row.icon size={14} aria-hidden="true" />
            <span className="tmr-why-text">{row.text}</span>
            <span className={`tmr-why-effect ${row.effect.tone}`.trim()}>{row.effect.text}</span>
          </li>
        ))}
      </ul>
      {showWithEvents && (
        <p className="tmr-fc-note" data-testid="plan-driver-with-events">
          {t("s3_fc_with_events").replace("{t}", number(forecast.with_events_total_t))}
        </p>
      )}
    </section>
  );
}

// What it takes, city-wide: trucks, crews, man-hours and bins from the forecast's
// per-district resource rows; the unit notes come from the API's units.
export function ResourcesCard({ forecast }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const number = (value) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: 0 });
  const rows = forecast?.kecamatan || [];
  const sum = (key) => (rows.length ? rows.reduce((total, row) => total + (Number(row[key]) || 0), 0) : null);
  const units = forecast?.units || {};
  const shiftHours = units.shift_hours ?? units.crew_shift_hours ?? null;
  const binTons = units.bin_capacity_tons ?? null;
  // Trucks, crews and man-hours divide tonnes by a full truck; real trips carry less.
  const capacityHint =
    units.truck_capacity_tons != null
      ? t("s3_res_capacity_title").replace("{t}", units.truck_capacity_tons)
      : undefined;
  const cells = [
    {
      key: "trucks",
      label: t("s3_res_trucks"),
      value: forecast ? forecast.trucks_needed : null,
      hint: capacityHint,
      note:
        units.truck_capacity_tons != null
          ? t("s3_res_truck_note").replace("{t}", units.truck_capacity_tons)
          : null,
    },
    {
      key: "crews",
      label: t("s3_res_crews"),
      value: forecast ? forecast.crews_needed : null,
      hint: capacityHint,
      note:
        units.crew_size_workers != null
          ? t("s3_res_crew_note").replace("{n}", units.crew_size_workers)
          : null,
    },
    {
      key: "manhours",
      label: t("s3_res_manhours"),
      value: sum("man_hours_required"),
      hint: capacityHint,
      note: shiftHours != null ? t("s3_res_shift_note").replace("{h}", shiftHours) : null,
    },
    {
      key: "bins",
      label: t("s3_res_bins"),
      value: sum("bins_required"),
      note: binTons != null ? t("s3_res_bin_note").replace("{t}", binTons.toLocaleString(locale)) : null,
    },
  ];
  return (
    <Card
      title={<span title={t("s3_res_units_title")}>{t("s3_res_title")}</span>}
      titleId="tmr-res-title"
      flush
      data-testid="tmr-resources"
      data-provenance="model"
    >
      <dl className="tmr-res">
        {cells.map((cell) => (
          <div key={cell.key} data-testid={`tmr-res-${cell.key}`} title={cell.hint}>
            <dt>{cell.label}</dt>
            <dd className="tmr-res-value">{number(cell.value)}</dd>
            {cell.note && <dd className="tmr-res-note">{cell.note}</dd>}
          </div>
        ))}
      </dl>
    </Card>
  );
}

// Field facts: the only manual input. A fact that names a fleet truck can keep it out of
// tomorrow's plan (effect truck_unavailable); every other fact is recorded, not modelled.
export function FieldFactsCard({ facts, fleetCodes, canEdit, onAdd, onRemove }) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [hold, setHold] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const truck = mentionedTruck(text, fleetCodes);

  async function submit(event) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const effect = truck && hold ? { kind: "truck_unavailable", truck_code: truck } : null;
    const ok = await onAdd({ text: value, source: effect ? "workshop" : "other", effect });
    setBusy(false);
    if (ok) {
      setText("");
      setHold(true);
    } else {
      setError("s3_facts_error");
    }
  }

  async function remove(fact) {
    setError(null);
    if (!(await onRemove(fact))) setError("s3_facts_remove_error");
  }

  return (
    <Card
      title={t("s3_facts_title")}
      titleId="tmr-facts-title"
      aside={t("s3_facts_aside")}
      flush
      className="tmr-facts"
      data-testid="tmr-facts"
    >
      {facts == null ? (
        <Skeleton rows={2} />
      ) : facts.length === 0 ? (
        <p className="tmr-facts-empty">{t("s3_facts_empty")}</p>
      ) : (
        <ul className="tmr-facts-list">
          {facts.map((fact) => {
            const Icon = SOURCE_ICONS[fact.source] || SOURCE_ICONS.other;
            return (
              <li
                key={fact.id}
                className="tmr-fact"
                data-testid="tmr-fact"
                data-applied={fact.applied ? "true" : "false"}
                title={t(`lx_fact_note_${fact.effect?.kind || "none"}`)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="tmr-fact-text">
                  <strong>{fact.text}</strong>
                  <span>
                    {t(`s3_src_${fact.source}`)} ·{" "}
                    {t(fact.applied ? "s3_fact_applied" : "s3_fact_not_modelled")}
                  </span>
                </span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={X}
                    aria-label={t("s3_facts_remove").replace("{text}", fact.text)}
                    onClick={() => remove(fact)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit ? (
        <form className="tmr-fact-add" onSubmit={submit}>
          <label className="tmr-fact-input">
            <Plus size={14} aria-hidden="true" />
            <input
              type="text"
              value={text}
              maxLength={280}
              placeholder={t("s3_facts_placeholder")}
              aria-label={t("s3_facts_input_label")}
              data-testid="tmr-fact-input"
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
            {text.trim() && (
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                iconOnly
                icon={Plus}
                aria-label={t("s3_facts_add")}
                disabled={busy}
              />
            )}
          </label>
          {truck && (
            <label className="tmr-fact-hold">
              <input
                type="checkbox"
                checked={hold}
                data-testid="tmr-fact-hold"
                onChange={(event) => setHold(event.target.checked)}
              />
              {t("s3_facts_hold").replace("{code}", truck)}
            </label>
          )}
          {error && (
            <p className="tmr-inline-error" role="alert">
              {t(error)}
            </p>
          )}
        </form>
      ) : (
        <p className="tmr-facts-readonly">{t("s3_facts_readonly")}</p>
      )}
    </Card>
  );
}
