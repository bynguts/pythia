"""The next 7, 14 or 30 days and the next three months ahead, with every input filled automatically.

Days (`week`, the key Ana's tool reads, holds whichever horizon was asked): the city-wide
daily forecast for today and the days after it, the same `build_outlook` frame the Tomorrow
page reads (Open-Meteo weather, the official event calendar, submitted permits, national
holidays), with the horizon's total, average per day and peak day (trucks at peak from
app/core/units.py). Open-Meteo serves 16 forecast days; a later day is flagged
`beyond_weather_forecast` and the model is fed 0 mm rain and the default 31 °C / 10 km/h
for it (no climatology). Months: the Bantargebang
intake model (`ma12_calendar`, calendar-adjusted 12-month level fitted on real weighing
data) with `within_backtested_horizon` per month, and its rolling-origin backtest: the
pooled error against the strongest naive rule, split into Lebaran and normal months, and
actual vs the one-month-ahead forecast per backtested month. Nobody types an input.
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from app.api.state import _outlook_cache
from app.core.env import today
from app.core.units import TRUCK_CAPACITY_TONS, resource_requirements
from app.forecast.baseline import DEFAULT_TEMP_MAX_C, DEFAULT_WIND_MAX_KMH, build_outlook, day_drivers
from app.forecast.engine import forecast_monthly_intake
from app.forecast.forecast_metrics import load_forecast_evaluation
from app.forecast.learning import corrected, learned_correction

OUTLOOK_DAYS = 7
OUTLOOK_HORIZONS = (7, 14, 30)
OUTLOOK_MONTHS = 3
PROVENANCE = "MODEL OUTPUT"
_CACHE_TTL_S = 300.0


def _week(n_days: int = OUTLOOK_DAYS) -> dict[str, Any]:
    base = build_outlook(days=n_days)
    horizon = base["horizon"]
    source = base["weather"]["source"]
    days = []
    for i, iso in enumerate(horizon["dates"]):
        total = horizon["daily_total_tons"][i]
        forecast_input = horizon["daily_weather_input"][i] == "forecast"
        drivers, events_total = day_drivers(
            iso,
            days=n_days,
            total_t=total,
            normal_t=horizon["daily_normal_tons"][i],
            rainfall_mm=horizon["daily_rainfall_mm"][i],
            weather_class="REAL_FORECAST_INPUT" if forecast_input else "NOT_OBSERVED",
            weather_source=source,
        )
        days.append(
            {
                "date": iso,
                "weekday": date.fromisoformat(iso).weekday(),
                "total_tons": total,
                "normal_tons": horizon["daily_normal_tons"][i],
                "with_events_total_t": round(total + events_total, 1),
                "kecamatan_at_risk": horizon["daily_kecamatan_at_risk"][i],
                "beyond_weather_forecast": not forecast_input,
                "drivers": drivers,
                "provenance": PROVENANCE,
            }
        )
    totals = [d["total_tons"] for d in days]
    peak = max(range(len(totals)), key=totals.__getitem__)
    # Trucks at the peak the way build_outlook counts them: per-kecamatan truckloads, summed.
    peak_trucks = sum(
        resource_requirements(row["series"][peak]["predicted_tons"])["trucks_required"]
        for row in base["kecamatan"]
    )
    return {
        "days": days,
        "horizon_days": n_days,
        "summary": {
            "total_tons": round(sum(totals), 1),
            "avg_tons_per_day": round(sum(totals) / len(totals), 1),
            "peak_date": days[peak]["date"],
            "peak_tons": totals[peak],
            "peak_trucks_needed": peak_trucks,
            "truck_capacity_tons": TRUCK_CAPACITY_TONS,
            "trucks_basis": (
                f"each kecamatan's tonnes on the peak day / {TRUCK_CAPACITY_TONS:g} t per truck per shift, "
                "rounded up and summed"
            ),
            "days_with_weather_forecast": sum(not d["beyond_weather_forecast"] for d in days),
            "days_beyond_weather_forecast": sum(d["beyond_weather_forecast"] for d in days),
            "provenance": PROVENANCE,
        },
        "unit": "t/day",
        "quantity": "waste generated (timbulan) per day, all 42 kecamatan summed",
        "weather_source": source,
        "weather_window_note": (
            "Open-Meteo serves up to 16 forecast days (today + 15); a day it does not cover is flagged "
            f"beyond_weather_forecast and the model is fed 0 mm rain, {DEFAULT_TEMP_MAX_C:g} °C max "
            f"temperature and {DEFAULT_WIND_MAX_KMH:g} km/h wind for it (fixed defaults, not climatology)"
        ),
        "basis": (
            "Prophet + XGBoost per kecamatan trained on calibrated-synthetic daily series anchored to "
            "SILIKA 2023; no daily accuracy is claimed"
        ),
        "provenance": PROVENANCE,
    }


def _months() -> dict[str, Any]:
    first = today().replace(day=1)
    next_month = (first + timedelta(days=32)).replace(day=1)
    result = forecast_monthly_intake(OUTLOOK_MONTHS, start_month=next_month.strftime("%Y-%m"))
    if any(m["horizon_months"] < 1 for m in result["months"]):
        # The clock is still inside the observed data: start after the last observed month.
        result = forecast_monthly_intake(OUTLOOK_MONTHS)
    landfill = ((load_forecast_evaluation() or {}).get("resolutions") or {}).get("landfill_month") or {}
    backtest = None
    if landfill:
        backtest = {
            key: landfill.get(key)
            for key in (
                "mape_model_pct",
                "mape_naive_pct",
                "strongest_naive",
                "period",
                "origins",
                "first_origin",
                "last_origin",
                "n_target_months",
                "horizons_months",
                "target_class",
            )
        }
        # Where the gain over the naive rule comes from: Ramadan/Lebaran months vs the rest.
        lebaran = landfill.get("calendar_months") or {}
        backtest["lebaran_months"] = lebaran.get("months", [])
        backtest["lebaran_skill_pct"] = lebaran.get("skill_pct")
        backtest["normal_skill_pct"] = (landfill.get("normal_months") or {}).get("skill_pct")
        backtest["one_month_ahead"] = landfill.get("one_month_ahead") or []
    return {**result, "backtest": backtest, "provenance": PROVENANCE}


def forecast_outlook(days: int = OUTLOOK_DAYS) -> dict[str, Any]:
    """`days` (7, 14 or 30) of city-wide tonnes per day and three months of Bantargebang intake."""
    if days not in OUTLOOK_HORIZONS:
        raise ValueError(f"days must be one of {', '.join(map(str, OUTLOOK_HORIZONS))}")
    return {
        "generated_for": today().isoformat(),
        "inputs_auto": True,
        "horizon_days": days,
        "horizons_available": list(OUTLOOK_HORIZONS),
        "week": _week(days),
        "monthly_intake": _months(),
        "provenance": PROVENANCE,
    }


def outlook_payload(days: int = OUTLOOK_DAYS) -> dict[str, Any]:
    """`forecast_outlook(days)` shared for 5 minutes per forecast date and horizon (the route and
    Ana's tool), with the weighbridge-learned correction (app/forecast/learning.py)."""
    key = today().isoformat()
    now = time.time()
    if _outlook_cache["key"] != key or _outlook_cache["payload"] is None:
        # One entry per horizon, {days: (ts, payload)}, dropped when the forecast date turns.
        _outlook_cache.update(key=key, ts=now, payload={})
    entry = _outlook_cache["payload"].get(days)
    if entry is None or now - entry[0] >= _CACHE_TTL_S:
        entry = (now, forecast_outlook(days))
        _outlook_cache["payload"][days] = entry
    payload = entry[1]
    # The learned correction moves with every weighed day, so it is applied after the cache,
    # next to (never instead of) each day's raw model value.
    correction = learned_correction()
    week = payload["week"]
    days_out = [{**day, "corrected_tons": corrected(day["total_tons"], correction)} for day in week["days"]]
    summary = {
        **week["summary"],
        "corrected_total_tons": corrected(week["summary"]["total_tons"], correction),
        "corrected_avg_tons_per_day": corrected(week["summary"]["avg_tons_per_day"], correction),
        "corrected_peak_tons": corrected(week["summary"]["peak_tons"], correction),
    }
    return {
        **payload,
        "week": {**week, "days": days_out, "summary": summary},
        "learned_correction": correction,
    }
