"""The week and the next three months ahead, with every input filled automatically.

Week: the city-wide daily forecast for today and the six days after it, the same
`build_outlook` frame the Tomorrow page reads (Open-Meteo weather, the official event
calendar, submitted permits, national holidays). A day Open-Meteo does not cover is
flagged `beyond_weather_forecast` (the model then uses 0 mm). Months: the Bantargebang
intake model (`ma12_calendar`, fitted on real weighing data) with its rolling-origin
backtest error and `within_backtested_horizon` per month. Nobody types an input.
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from app.api.state import _outlook_cache
from app.core.env import today
from app.forecast.baseline import build_outlook, day_drivers
from app.forecast.engine import forecast_monthly_intake
from app.forecast.forecast_metrics import monthly_backtest_metrics

OUTLOOK_DAYS = 7
OUTLOOK_MONTHS = 3
PROVENANCE = "MODEL OUTPUT"
_CACHE_TTL_S = 300.0


def _week() -> dict[str, Any]:
    base = build_outlook(days=OUTLOOK_DAYS)
    horizon = base["horizon"]
    source = base["weather"]["source"]
    days = []
    for i, iso in enumerate(horizon["dates"]):
        total = horizon["daily_total_tons"][i]
        forecast_input = horizon["daily_weather_input"][i] == "forecast"
        drivers, events_total = day_drivers(
            iso,
            days=OUTLOOK_DAYS,
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
    return {
        "days": days,
        "unit": "t/day",
        "quantity": "waste generated (timbulan) per day, all 42 kecamatan summed",
        "weather_source": source,
        "weather_window_note": (
            "Open-Meteo forecasts 7 days; a day it does not cover is flagged beyond_weather_forecast "
            "and the model uses 0 mm rain for it"
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
    backtest = monthly_backtest_metrics().get("landfill_month") or {}
    return {
        **result,
        "backtest": {
            key: backtest.get(key)
            for key in (
                "mape_model_pct",
                "mape_naive_pct",
                "strongest_naive",
                "period",
                "origins",
                "horizons_months",
                "target_class",
            )
        }
        if backtest
        else None,
        "provenance": PROVENANCE,
    }


def forecast_outlook() -> dict[str, Any]:
    """Seven days of city-wide tonnes per day and three months of Bantargebang intake."""
    return {
        "generated_for": today().isoformat(),
        "inputs_auto": True,
        "week": _week(),
        "monthly_intake": _months(),
        "provenance": PROVENANCE,
    }


def outlook_payload() -> dict[str, Any]:
    """`forecast_outlook()` shared for 5 minutes per forecast date (the route and Ana's tool)."""
    key = today().isoformat()
    now = time.time()
    if _outlook_cache["key"] != key or now - _outlook_cache["ts"] >= _CACHE_TTL_S:
        _outlook_cache["payload"] = forecast_outlook()
        _outlook_cache["key"] = key
        _outlook_cache["ts"] = now
    return _outlook_cache["payload"]
