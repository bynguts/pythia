"""3D digital twin scene."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Query

from app.api.routers.fleet import command_center
from app.core.env import today
from app.core.units import TRUCK_CAPACITY_TONS
from app.fleet.data import tpa_queue_status_payload
from app.fleet.facilities import FACILITIES
from app.fleet.queue_simulation import (
    SCENARIO_SCALING_ASSUMPTION,
    WEIGHBRIDGE_LANES,
    lanes_assumption,
    scenario_queue_metric,
    staggered_peak_hour,
)
from app.forecast.baseline import build_outlook
from app.forecast.cities import (
    HCMC_LANDFILL,
    RAIN_UPLIFT_CAP,
    RAIN_UPLIFT_PER_MM,
    VENUES,
    get_city,
    get_venue,
    hcmc_district_forecasts,
)
from app.forecast.engine import (
    RAIN_3D_WINDOW_DAYS,
    TRAINING_RAIN_MAX_MM,
    forecast_monthly_intake,
    rain_response_block,
    rolling_rain_3d,
)
from app.forecast.real_data import load_real_tps_coordinates
from app.forecast.twin import (
    BRIEFING_SCENARIOS,
    briefing_scenario,
    event_attendance_by_district,
    event_block,
    jakarta_week,
)
from app.forecast.twin import build_scene as build_twin_scene
from app.forecast.weather import fetch_jakarta_weather_forecast, real_forecast_by_date

router = APIRouter()

# Longest horizon the scene serves; `day` indexes into it.
MAX_TWIN_DAYS = 14
# Every venue preset id of every city (forecast/cities.py is the one source).
VENUE_PATTERN = "^(" + "|".join(v.id for venues in VENUES.values() for v in venues) + ")$"
BRIEFING_PATTERN = "^(" + "|".join(BRIEFING_SCENARIOS) + ")$"
DEFAULT_TEMP_MAX_C = 31.0
DEFAULT_WIND_MAX_KMH = 10.0


# A what-if's rain counts on its own day only; forecast rain keeps the training's
# rolling 3-day sum (the next two days' rain_3d), labelled per day.
CARRY_OVER = {
    "scenario": False,
    "forecast": True,
    "label": (
        "A what-if's rain counts on its own day only. Forecast rain also enters the next "
        f"{RAIN_3D_WINDOW_DAYS - 1} days' {RAIN_3D_WINDOW_DAYS}-day rain sum (rain_3d), as in training."
    ),
}


def _hcmc_rain_response(max_rain_mm: float) -> dict[str, Any]:
    """The demo city's rain uplift: a stated assumption, no trained model."""
    return {
        "method": "assumption_capped",
        "label": (
            f"Demo city: rain uplift is an assumption, +{RAIN_UPLIFT_PER_MM * 100:g}% per mm capped at "
            f"+{RAIN_UPLIFT_CAP * 100:g}% (no trained model)."
        ),
        "rule_steps_mm": [],
        "rule_steps_percent": [],
        "grid_step_mm": None,
        "training_max_rain_mm": None,
        "max_rain_mm": float(max_rain_mm),
        "beyond_training_range": False,
        "held_at_mm": None,
    }


def _weather_block(
    mode: str,
    source: dict[str, Any] | None,
    dates: list[str],
    rain: list[float],
    inputs: list[str],
    rain_3d: list[float] | None = None,
    city: str = "jakarta",
) -> dict[str, Any]:
    """Which rain each horizon day used, and where it came from. Forecast is never observed.

    `rain_3d` is the 3-day rain sum each day's model row saw (None: no model, own rain).
    """
    model = city == "jakarta"
    rain_3d = rain_3d if rain_3d is not None else list(rain)
    days = [
        {
            "date": d,
            "rainfall_mm": r,
            "input": i,
            "rain_3d_mm": r3,
            "carried_rain_mm": round(max(0.0, r3 - r), 2),
            "beyond_training_range": model and r > TRAINING_RAIN_MAX_MM,
        }
        for d, r, i, r3 in zip(dates, rain, inputs, rain_3d, strict=True)
    ]
    normal_day = "the same forecast without rain and without event (dry)"
    max_rain = max(rain, default=0.0)
    common = {
        "normal_day": normal_day,
        "days": days,
        "carry_over": CARRY_OVER,
        "snapshot": bool(source and source.get("snapshot")),
        "rain_response": rain_response_block(max_rain) if model else _hcmc_rain_response(max_rain),
    }
    if mode == "none":
        return {
            "mode": mode,
            "source": "none",
            "class": "NOT_USED",
            "kind": None,
            "fetched_at": None,
            "label": "Rain input: none requested (dry) except a scenario day",
            **common,
        }
    if source is None:
        return {
            "mode": mode,
            "source": "not_applicable",
            "class": "UNAVAILABLE",
            "kind": None,
            "fetched_at": None,
            "label": "No weather forecast for the demo city: rain assumed 0 mm except a scenario day",
            **common,
        }
    if not any(i == "forecast" for i in inputs):
        return {
            "mode": mode,
            "source": "unavailable",
            "class": "UNAVAILABLE",
            "kind": None,
            "fetched_at": None,
            "label": "Open-Meteo forecast unreachable: rain assumed 0 mm (dry) except a scenario day",
            **common,
        }
    fetched_at = source.get("fetched_at")
    kind = f"forecast snapshot fetched at {fetched_at}" if common["snapshot"] else "daily forecast"
    return {
        "mode": mode,
        "source": "open-meteo",
        # A real forecast INPUT (not an observation); the districts stay MODEL OUTPUT.
        "class": "REAL_FORECAST_INPUT",
        "kind": "forecast",
        "fetched_at": fetched_at,
        "label": f"Rain input: Open-Meteo {kind} (forecast, not observed weather); districts: MODEL OUTPUT",
        **common,
    }


def _landfill_intake_reference(month: str) -> dict[str, Any] | None:
    """The validated monthly Bantargebang intake level for `month` (a different quantity)."""
    result = forecast_monthly_intake(1, start_month=month)
    if not result.get("available") or not result.get("months"):
        return None
    row = result["months"][0]
    return {
        "quantity": "landfill_intake",
        "label": "Bantargebang landfill intake (weighbridge tonnage), monthly mean per day",
        "month": row["month"],
        "tons_per_day": row["tons_per_day"],
        "classification": result["classification"],
        "validation": result["validation"],
        "fitted_through": result["fitted_through"],
        "horizon_months": row["horizon_months"],
        "within_backtested_horizon": row["within_backtested_horizon"],
        "note": (
            "Waste generated in the districts and tonnage weighed in at the landfill are different "
            "quantities; the twin's district tonnes are generated waste."
        ),
    }


def _peak_hour_pair(queue: dict[str, Any]) -> dict[str, Any] | None:
    """The beacon's modelled peak hour without stagger, and the same hour with it."""
    trucks, hour = queue.get("trucks_per_day"), queue.get("modelled_hour")
    if not trucks or hour is None:
        return None
    return {
        "unstaggered": {
            "hour": hour,
            "mean_wait_minutes": queue.get("avg_wait_minutes"),
            "queue_trucks_mean": queue.get("queue_trucks_mean"),
            "queue_trucks_max": queue.get("queue_trucks_max"),
            "classification": "SIMULATED",
        },
        "staggered": staggered_peak_hour(int(trucks), int(hour)),
    }


def _queue_day_basis(
    rain_input: str, rain_mm: float, event_today: bool, day_date: str, metric: dict[str, Any] | None
) -> dict[str, Any]:
    """Why the selected day's queue differs from the normal day (or that it does not).

    Carries both truck counts, so a reader can tell the twin beacon (this day,
    scaled) from the Fleet KPI (the normal day, see fleet.data) at a glance.
    """
    metric = metric or {}
    counts = {
        "date": day_date,
        "trucks_per_day": metric.get("trucks_per_day"),
        "normal_trucks_per_day": (metric.get("normal_day") or {}).get("trucks_per_day"),
        "tonnage_ratio": (metric.get("scaling") or {}).get("tonnage_ratio", 1.0),
    }
    if event_today or rain_input == "scenario":
        basis, label = "scenario", "what-if scenario day, scaled from the normal day"
    elif rain_input == "forecast" and rain_mm > 0:
        basis, label = (
            "forecast_weather",
            "Open-Meteo forecast rain day (forecast input), scaled from the normal day",
        )
    else:
        basis, label = "normal_day", "normal day: no rain, no event"
    return {"id": basis, "label": label, "normal_day": "same model and date without rain or event", **counts}


def _day_scoped(normal: list[dict[str, Any]], scenario: list[dict[str, Any]], day: int):
    """Normal-day rows everywhere, the scenario's rows on its own day only."""
    by_id = {d["id"]: d for d in scenario}
    out = []
    for district in normal:
        what_if = by_id.get(district["id"], district)
        series = [what_if["series"][i] if i == day else row for i, row in enumerate(district["series"])]
        out.append({**what_if, "series": series})
    return out


def _briefing_column(outlook: dict[str, Any], lanes: int | None = None) -> dict[str, Any]:
    """The three briefing numbers of one outlook (forecast/baseline.py) plus its TPA queue.

    The queue is the twin beacon's day-0 metric: trips scaled by this day's tonnes
    against its normal day (queue_simulation.scenario_queue_metric), SIMULATED;
    `lanes` below the assumed set is the lane-closed what-if.
    """
    queue = scenario_queue_metric(
        outlook["total_tonnage_t"], outlook["normal_day_tonnage_t"], lanes=lanes or WEIGHBRIDGE_LANES
    )
    return {
        "date": outlook["date"],
        "total_tonnage_t": outlook["total_tonnage_t"],
        "trucks_needed": outlook["trucks_needed"],
        "kecamatan_at_risk": outlook["kecamatan_at_risk"],
        "kecamatan_count": outlook["kecamatan_count"],
        "queue_minutes_per_truck": queue["baseline_mean"] if queue else None,
        "queue_trips_per_day": queue["trucks_per_day"] if queue else None,
        "weighbridge_lanes": lanes or WEIGHBRIDGE_LANES,
    }


@router.get("/api/twin/scenarios")
def twin_scenarios() -> dict[str, Any]:
    """The decision room's briefing scenarios (at most three), by id, for Twin, XR and Rencana."""
    return {
        "date": today().isoformat(),
        "scenarios": [briefing_scenario(scenario_id) for scenario_id in BRIEFING_SCENARIOS],
    }


@router.get("/api/twin/briefing")
def twin_briefing(scenario: str | None = Query(None, pattern=BRIEFING_PATTERN)) -> dict[str, Any]:
    """Today's baseline next to one briefing scenario on the same day (Jakarta).

    `before` is the canonical "today" (forecast/baseline.build_outlook, the frame
    Prediksi and Rencana print); `after` is the same call with the scenario's rain
    or crowd, or null without a scenario. Tonnes and trucks are MODEL OUTPUT; the
    queue is SIMULATED.
    """
    spec = briefing_scenario(scenario) if scenario else None
    base = build_outlook(days=7)
    what_if = (
        build_outlook(
            days=7,
            rainfall_mm=spec["rainfall_mm"],
            event_attendance=spec["event_attendance"],
            venue=spec["venue"],
        )
        if spec
        else None
    )
    return {
        "date": base["date"],
        "scenario": spec,
        "before": _briefing_column(base),
        "after": _briefing_column(what_if, spec["weighbridge_lanes"]) if what_if else None,
        "classification": {"tonnage": "MODEL_OUTPUT", "trucks": "MODEL_OUTPUT", "queue": "SIMULATED"},
        "basis": {
            "before": base["label"],
            "scenario": spec["basis"] if spec else None,
            "trucks": f"{TRUCK_CAPACITY_TONS:g} t per truck per shift, summed per kecamatan",
            "queue": (
                f"{SCENARIO_SCALING_ASSUMPTION}; {lanes_assumption(spec['weighbridge_lanes'])}"
                if spec and spec["weighbridge_lanes"]
                else SCENARIO_SCALING_ASSUMPTION
            ),
        },
    }


@router.get("/api/twin/scene")
def twin_scene(
    city: str = Query("jakarta", pattern="^(jakarta|hcmc)$"),
    days: int = Query(7, ge=2, le=MAX_TWIN_DAYS),
    rainfall_mm: float = Query(0.0, ge=0, le=300),
    event_attendance: int = Query(0, ge=0, le=2_000_000),
    event_lat: float | None = Query(None, ge=-90, le=90),
    event_lng: float | None = Query(None, ge=-180, le=180),
    venue: str | None = Query(None, pattern=VENUE_PATTERN),
    day: int = Query(0, ge=0, le=MAX_TWIN_DAYS - 1),
    scenario_day: int | None = Query(None, ge=0, le=MAX_TWIN_DAYS - 1),
    weather: str = Query("forecast", pattern="^(forecast|none)$"),
) -> dict[str, Any]:
    """Everything the 3D digital twin draws for one city, with per-layer provenance.

    Jakarta uses the trained per-kecamatan model, the simulated pilot fleet and
    the real SILIKA TPS points. Ho Chi Minh City is a labelled demo city
    (population-share allocation, no model).

    Base week: with `weather=forecast` (default) each Jakarta day uses the real
    Open-Meteo daily rain forecast (temperature and wind too), so the first frame
    shows this week's risk; when Open-Meteo is unreachable every day is assumed
    dry and `weather` says so. `weather=none` keeps every day dry.

    What-if: `rainfall_mm` (> 0 replaces that day's rain) and the event apply to
    ONE day only, `scenario_day` (default: `day`); every other day keeps the base
    week. Risk compares each day with its normal day: same model, same date, no
    rain, no event (engine.spike_risk, the definition Fleet uses too).

    `venue` (a preset id from `forecast/cities.py`, ignored when it belongs to
    another city) places the event when no explicit coordinates are given;
    `scenario.venue` names it only when the event sits on the preset's coordinates.
    `day` selects the horizon day the scenario-scaled TPA queue metric and the
    flow arcs describe; the landfill beacon shows the modelled peak hour of that day.
    """
    preset = get_venue(city, venue)
    if preset and event_attendance and event_lat is None and event_lng is None:
        event_lat, event_lng = preset.lat, preset.lng
    at_preset = bool(preset and event_attendance and (event_lat, event_lng) == (preset.lat, preset.lng))
    day = min(day, days - 1)
    what_if_day = min(day if scenario_day is None else scenario_day, days - 1)
    start = today()
    dates = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    # An event without coordinates sits at the city's first venue preset.
    place = (event_lat, event_lng)
    if event_attendance and None in place:
        place = (VENUES[city][0].lat, VENUES[city][0].lng)
    scenario = {
        "rainfall_mm": rainfall_mm,
        "event_attendance": event_attendance,
        "event_lat": event_lat,
        "event_lng": event_lng,
        "venue": preset.id if at_preset else None,
        "day": day,
        # The what-if (rain > 0 and/or event) applies to this day only.
        "scenario_day": what_if_day,
        "scenario_date": dates[what_if_day],
        "weather": weather,
        "event": event_block(event_attendance, place[0], place[1], what_if_day, dates[what_if_day])
        if city == "jakarta"
        else None,
    }

    if city == "hcmc":
        normal_days = hcmc_district_forecasts(days)
        what_if = hcmc_district_forecasts(days, rainfall_mm, event_attendance, event_lat, event_lng)
        districts = _day_scoped(normal_days, what_if, what_if_day)
        if event_attendance:
            localized = [d for d in what_if if d["event_localized"]]
            scenario["event"] = {
                "lat": place[0],
                "lng": place[1],
                "radius_m": None,
                "day": what_if_day,
                "date": dates[what_if_day],
                "attendance": event_attendance,
                "districts": [d["id"] for d in localized],
                "basis": "demo city: the whole crowd lands in the district nearest the venue",
            }
        rain = [rainfall_mm if i == what_if_day and rainfall_mm > 0 else 0.0 for i in range(days)]
        inputs = ["scenario" if r > 0 else "assumed_dry" for r in rain]
        landfill = {**HCMC_LANDFILL, "kind": "landfill"}
        return build_twin_scene(
            get_city("hcmc"),
            districts,
            scenario=scenario,
            facilities=[landfill],
            normal_days=normal_days,
            weather=_weather_block(weather, None, dates, rain, inputs, city="hcmc"),
        )

    source = fetch_jakarta_weather_forecast() if weather == "forecast" else None
    forecast = real_forecast_by_date(source) if source else {}
    rain = [forecast.get(d, {}).get("rainfall_mm", 0.0) for d in dates]
    inputs = ["forecast" if d in forecast else "assumed_dry" for d in dates]
    # The base week's rolling 3-day rain sum; a what-if replaces its own day's rain
    # inside that day's sum only, so it never carries into the next days.
    rain_3d = rolling_rain_3d(tuple(rain))
    if rainfall_mm > 0:
        rain_3d[what_if_day] = round(rain_3d[what_if_day] - rain[what_if_day] + rainfall_mm, 2)
        rain[what_if_day] = rainfall_mm
        inputs[what_if_day] = "scenario"
    if forecast:
        temp: float | tuple[float, ...] = tuple(
            forecast.get(d, {}).get("temp_max_c", DEFAULT_TEMP_MAX_C) for d in dates
        )
        wind: float | tuple[float, ...] = tuple(
            forecast.get(d, {}).get("wind_max_kmh", DEFAULT_WIND_MAX_KMH) for d in dates
        )
    else:
        temp, wind = DEFAULT_TEMP_MAX_C, DEFAULT_WIND_MAX_KMH
    events = {
        slug: tuple(attendance if i == what_if_day else 0 for i in range(days))
        for slug, attendance in (
            event_attendance_by_district(event_attendance, *place) if event_attendance else {}
        ).items()
    }
    districts = jakarta_week(
        days,
        rain=tuple(rain),
        temp=temp,
        wind=wind,
        events=events,
        start=start.isoformat(),
        rain_3d=tuple(rain_3d),
    )
    normal_days = jakarta_week(days, rain=(0.0,) * days, temp=temp, wind=wind, start=start.isoformat())

    facilities = [
        {
            "name": facility.name,
            "lat": facility.lat,
            "lng": facility.lng,
            "kind": "landfill" if facility.name == "TPST Bantargebang" else "processing",
        }
        for facility in FACILITIES.values()
        if facility.is_ground_truth
    ]

    def day_tons(rows: list[dict[str, Any]]) -> float:
        return sum(d["series"][day]["predicted_tons"] for d in rows if len(d["series"]) > day)

    # gsc P0-5: the one metric, scaled to this scenario's selected day (cached per
    # trucks/day, deterministic for its seed). The beacon fields beside it are
    # that same day's modelled peak hour, so beacon and headline share day and model.
    metric = scenario_queue_metric(day_tons(districts), day_tons(normal_days))
    queue = tpa_queue_status_payload(trucks_per_day=metric["trucks_per_day"] if metric else None)
    return build_twin_scene(
        get_city("jakarta"),
        districts,
        scenario=scenario,
        facilities=facilities,
        normal_days=normal_days,
        trucks=command_center()["trucks"],
        tps=load_real_tps_coordinates(),
        landfill_queue={
            **queue,
            "minutes_per_truck": metric,
            # The beacon's peak hour without stagger, next to the same hour with it.
            "peak_hour": _peak_hour_pair(queue),
            # What the selected day's queue was scaled by, so a forecast-rain day is
            # never read as the normal day (minutes_per_truck.normal_day is that one).
            "day_basis": _queue_day_basis(
                inputs[day], rain[day], bool(event_attendance) and day == what_if_day, dates[day], metric
            ),
        },
        weather=_weather_block(weather, source, dates, rain, inputs, rain_3d),
        landfill_intake=_landfill_intake_reference(start.strftime("%Y-%m")),
    )
