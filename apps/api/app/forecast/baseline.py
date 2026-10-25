"""The one "today" every workspace shows (Fleet, Twin, Prediksi, Rencana).

Today's baseline is the twin's own default frame: the trained per-kecamatan
series with today's Open-Meteo forecast weather and no event, risk measured
against the normal day (same model and date, dry, no event). The twin scene,
the forecast page and the planning page all read their "today" figures from
`build_outlook`, so a juror sees one tonnage, one at-risk count and one truck
need on every screen. A what-if (rain or an event on one day) goes through the
same function and comes back labelled `kind: "scenario"`.
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from app.core.env import today
from app.core.units import (
    CREW_SIZE_WORKERS,
    TRUCK_CAPACITY_TONS,
    UNIT_GLOSSARY,
    extra_trucks_for,
    resource_requirements,
    workers_for_crews,
)
from app.forecast.cities import VENUES, get_venue
from app.forecast.engine import AT_RISK_LEVELS, NORMAL_DAY_BASIS, rolling_rain_3d
from app.forecast.real_data import load_city_timbulan
from app.forecast.twin import _with_risk, event_attendance_by_district, jakarta_week
from app.forecast.weather import fetch_jakarta_weather_forecast, real_forecast_by_date

# The twin router's defaults for a day without a forecast (kept equal on purpose).
DEFAULT_TEMP_MAX_C = 31.0
DEFAULT_WIND_MAX_KMH = 10.0
MAX_DAYS = 30
BASELINE_LABEL = "today's forecast weather, no event"
# Necessary: one outlook runs 2 x 42 model series (~1-3 s); the forecast is daily
# resolution and the weather feed has its own 5-minute cache.
_CACHE_TTL_S = 300.0
_cache: dict[tuple, tuple[float, dict[str, Any]]] = {}


def fleet_counts() -> dict[str, Any]:
    """The pilot fleet's one denominator: units on duty out of all units (Fleet KPI basis)."""
    from app.fleet.data import get_dynamic_trucks

    trucks = get_dynamic_trucks()
    active = sum(1 for truck in trucks if truck.get("status") in {"active", "deviation"})
    return {
        "active": active,
        "total": len(trucks),
        "classification": "SIMULATED",
        "basis": "pilot fleet, simulated telemetry; active = on duty (on route or off corridor)",
    }


def gate_trips() -> dict[str, Any] | None:
    """TPA gate trips (rit) per normal day: the queue model's arrivals, a different count from trucks.

    `trucks_needed` counts truck units (tonnes / truck capacity per shift); a
    truck makes several gate trips a day, so the two are never the same number.
    """
    from app.fleet.queue_simulation import ARRIVALS_UNIT, bantargebang_daily_arrivals

    derived = bantargebang_daily_arrivals()
    if derived is None:
        return None
    trips, source = derived
    return {
        "trips_per_day": trips,
        "unit": ARRIVALS_UNIT,
        "day": "normal day (not scaled for rain or events)",
        "source": source,
        "classification": "REAL" if "ritasi" in source else "DERIVED",
    }


def tonnage_reference() -> dict[str, Any] | None:
    """The real city-wide generation figure the model's daily tonnage is read against.

    SIPSN's latest yearly daily average (timbulan, the same quantity the model
    forecasts). One forecast day sits above or below it: rain and events lift a
    day, and the landfill intake at Bantargebang is a different, lower quantity.
    """
    cities = load_city_timbulan()
    if not cities:
        return None
    return {
        "daily_tons": round(sum(info["daily_tons"] for info in cities.values()), 1),
        "year": next(iter(cities.values()))["year"],
        "quantity": "waste generated (timbulan), yearly average per day, all of DKI Jakarta",
        "source": "SIPSN KLHK",
        "classification": "REAL",
        "basis": (
            "the forecast is model output for one day: forecast rain or an event lifts it above "
            "the yearly average; landfill intake (Bantargebang weighing data) is a different, "
            "lower quantity"
        ),
    }


def capacity_recommendation(at_risk: list[dict[str, Any]], day: int, fleet: dict[str, Any]) -> dict[str, Any]:
    """Extra trucks for the at-risk kecamatan, clamped to what the fleet can field.

    The extra is the tonnage above each at-risk kecamatan's normal day, in
    canonical truckloads (units.py). The fleet can only add the units that are
    not already on duty (`fleet_reserve`); the rest is a shortfall, never a
    recommendation to add trucks the fleet does not have.
    """
    extra = sum(
        extra_trucks_for(d["series"][day]["predicted_tons"], d["series"][day]["normal_tons"]) for d in at_risk
    )
    reserve = max(0, int(fleet["total"]) - int(fleet["active"]))
    deployable = min(extra, reserve)
    return {
        "extra_trucks_needed": extra,
        "extra_crews_needed": extra,
        "extra_workers_needed": workers_for_crews(extra),
        "fleet_reserve": reserve,
        "deployable_trucks": deployable,
        "shortfall_trucks": extra - deployable,
        "basis": (
            f"tonnage above the normal day in at-risk kecamatan, {TRUCK_CAPACITY_TONS:g} t per truck "
            "per shift; reserve = pilot units not on duty"
        ),
    }


def _day_index(target: str | None, start: date, days: int) -> int:
    if not target:
        return 0
    index = (date.fromisoformat(target) - start).days
    if not 0 <= index < days:
        raise ValueError(f"date must be within {days} days from {start.isoformat()}")
    return index


def build_outlook(
    *,
    days: int = 7,
    target_date: str | None = None,
    rainfall_mm: float = 0.0,
    event_attendance: int = 0,
    venue: str | None = None,
    event_lat: float | None = None,
    event_lng: float | None = None,
) -> dict[str, Any]:
    """Today's baseline, or a what-if on one day of the same forecast week.

    Inputs mirror /api/twin/scene with `weather=forecast`: per-day Open-Meteo
    rain, temperature and wind, the rolling 3-day rain sum, and a what-if that
    replaces only its own day's rain and adds its crowd on that day only.
    """
    days = max(2, min(int(days), MAX_DAYS))
    start = today()
    day = _day_index(target_date, start, days)
    what_if = rainfall_mm > 0 or event_attendance > 0
    preset = get_venue("jakarta", venue)
    if event_attendance and (event_lat is None or event_lng is None):
        place = preset or VENUES["jakarta"][0]
        event_lat, event_lng = place.lat, place.lng

    key = (start, days, day, rainfall_mm, event_attendance, event_lat, event_lng)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _CACHE_TTL_S:
        return hit[1]

    dates = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    source = fetch_jakarta_weather_forecast()
    forecast = real_forecast_by_date(source)
    rain = [forecast.get(d, {}).get("rainfall_mm", 0.0) for d in dates]
    inputs = ["forecast" if d in forecast else "assumed_dry" for d in dates]
    rain_3d = rolling_rain_3d(tuple(rain))
    if rainfall_mm > 0:
        rain_3d[day] = round(rain_3d[day] - rain[day] + rainfall_mm, 2)
        rain[day] = rainfall_mm
        inputs[day] = "scenario"
    if forecast:
        temp: float | tuple[float, ...] = tuple(
            forecast.get(d, {}).get("temp_max_c", DEFAULT_TEMP_MAX_C) for d in dates
        )
        wind: float | tuple[float, ...] = tuple(
            forecast.get(d, {}).get("wind_max_kmh", DEFAULT_WIND_MAX_KMH) for d in dates
        )
    else:
        temp, wind = DEFAULT_TEMP_MAX_C, DEFAULT_WIND_MAX_KMH
    crowd = event_attendance_by_district(event_attendance, event_lat, event_lng) if event_attendance else {}
    events = {slug: tuple(n if i == day else 0 for i in range(days)) for slug, n in crowd.items()}

    week = jakarta_week(
        days,
        rain=tuple(rain),
        temp=temp,
        wind=wind,
        events=events,
        start=start.isoformat(),
        rain_3d=tuple(rain_3d),
    )
    normal_week = jakarta_week(days, rain=(0.0,) * days, temp=temp, wind=wind, start=start.isoformat())
    normal = {d["id"]: [row["predicted_tons"] for row in d["series"]] for d in normal_week}
    districts = [_with_risk(d, normal.get(d["id"])) for d in week]

    def row(d: dict[str, Any]) -> dict[str, Any]:
        cell = d["series"][day]
        resources = resource_requirements(cell["predicted_tons"])
        capacity = d.get("capacity_tons")
        return {
            "slug": d["id"],
            "kecamatan": d["name"],
            "city": d["admin_area"],
            "predicted_tons": cell["predicted_tons"],
            "normal_tons": cell["normal_tons"],
            "spike_percent": cell["spike_percent"],
            "risk_level": cell["risk"],
            "trucks_required": resources["trucks_required"],
            "crews_required": resources["crews_required"],
            "workers_required": resources["workers_required"],
            "man_hours_required": resources["man_hours_required"],
            "bins_required": resources["bins_required"],
            "capacity_tons": capacity,
            "facility_readiness": d.get("facility_readiness"),
            "facility_over_capacity": bool(capacity is not None and cell["predicted_tons"] > capacity),
            "event_attendance": cell.get("event_attendance", 0),
            "series": [{"date": s["date"], "predicted_tons": s["predicted_tons"]} for s in d["series"]],
        }

    rows = sorted((row(d) for d in districts), key=lambda r: r["predicted_tons"], reverse=True)
    at_risk = [d for d in districts if d["series"][day]["risk"] in AT_RISK_LEVELS]
    total = round(sum(r["predicted_tons"] for r in rows), 1)
    normal_total = round(sum(r["normal_tons"] for r in rows), 1)
    trucks = sum(r["trucks_required"] for r in rows)
    fleet = fleet_counts()
    payload = {
        "kind": "scenario" if what_if else "baseline",
        "label": "what-if scenario on the forecast week" if what_if else BASELINE_LABEL,
        "date": dates[day],
        "day": day,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_tonnage_t": total,
        "normal_day_tonnage_t": normal_total,
        "kecamatan_count": len(rows),
        "kecamatan_at_risk": len(at_risk),
        # Per-kecamatan truckloads (a truck does not split across kecamatan), as the twin sums them.
        "trucks_needed": trucks,
        "trucks_basis": (
            f"truck units: each kecamatan's tonnes / {TRUCK_CAPACITY_TONS:g} t per truck per shift, "
            "rounded up and summed; not TPA gate trips (see gate_trips)"
        ),
        "gate_trips": gate_trips(),
        "crews_needed": trucks,
        "workers_needed": workers_for_crews(trucks),
        "fleet": fleet,
        "recommendation": capacity_recommendation(at_risk, day, fleet),
        "weather": {
            "rainfall_mm": rain[day],
            "input": inputs[day],
            "class": "REAL_FORECAST_INPUT" if inputs[day] == "forecast" else "NOT_OBSERVED",
            "source": "open-meteo" if forecast else "unavailable",
        },
        "event": (
            {
                "attendance": event_attendance,
                "lat": event_lat,
                "lng": event_lng,
                "venue": preset.id if preset else None,
                "kecamatan": sorted(crowd),
            }
            if crowd
            else None
        ),
        "scenario": (
            {
                "rainfall_mm": rainfall_mm,
                "event_attendance": event_attendance,
                "venue": venue,
                "date": dates[day],
            }
            if what_if
            else None
        ),
        "horizon": {
            "dates": dates,
            "daily_total_tons": [
                round(sum(d["series"][i]["predicted_tons"] for d in districts), 1) for i in range(days)
            ],
            "daily_kecamatan_at_risk": [
                sum(1 for d in districts if d["series"][i]["risk"] in AT_RISK_LEVELS) for i in range(days)
            ],
        },
        "kecamatan": rows,
        "risk_basis": f"forecast vs the normal day ({NORMAL_DAY_BASIS})",
        "units": {
            **UNIT_GLOSSARY,
            "truck_capacity_tons": TRUCK_CAPACITY_TONS,
            "crew_size_workers": CREW_SIZE_WORKERS,
            "tons": "waste generated (timbulan) per day, not landfill intake",
        },
        "tonnage_reference": tonnage_reference(),
        "provenance": {
            "tonnage": "MODEL_OUTPUT",
            "weather": "REAL_FORECAST_INPUT" if forecast else "UNAVAILABLE",
            "fleet": "SIMULATED",
        },
    }
    if what_if:
        base = build_outlook(days=days, target_date=dates[day])
        payload["baseline"] = {
            key: base[key]
            for key in ("total_tonnage_t", "kecamatan_at_risk", "trucks_needed", "crews_needed")
        }
    if len(_cache) > 64:  # scenario keys are user-chosen; keep the cache bounded
        _cache.clear()
    _cache[key] = (time.time(), payload)
    return payload
