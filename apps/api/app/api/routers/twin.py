"""3D digital twin scene."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.api.routers.fleet import command_center
from app.api.routers.forecast import predictions_kecamatan
from app.fleet.data import tpa_queue_status_payload
from app.fleet.facilities import FACILITIES
from app.fleet.queue_simulation import scenario_queue_metric
from app.forecast.cities import HCMC_LANDFILL, VENUES, get_city, get_venue, hcmc_district_forecasts
from app.forecast.real_data import load_real_tps_coordinates
from app.forecast.twin import build_scene as build_twin_scene
from app.forecast.twin import jakarta_districts as twin_jakarta_districts

router = APIRouter()

# Longest horizon the scene serves; `day` indexes into it.
MAX_TWIN_DAYS = 14
# Every venue preset id of every city (forecast/cities.py is the one source).
VENUE_PATTERN = "^(" + "|".join(v.id for venues in VENUES.values() for v in venues) + ")$"


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
) -> dict[str, Any]:
    """Everything the 3D digital twin draws for one city, with per-layer provenance.

    Jakarta uses the trained per-kecamatan forecast (via the cached kecamatan
    endpoint), the simulated pilot fleet and the real SILIKA TPS points. Ho Chi
    Minh City is a labelled demo city (population-share allocation, no model).

    `venue` (a preset id from `forecast/cities.py`, ignored when it belongs to
    another city) places the event when no explicit coordinates are given;
    `scenario.venue` names it only when the event sits on the preset's coordinates.
    `day` selects the horizon day the scenario-scaled TPA queue metric describes;
    the landfill beacon shows the modelled peak hour of that same day.
    """
    preset = get_venue(city, venue)
    if preset and event_attendance and event_lat is None and event_lng is None:
        event_lat, event_lng = preset.lat, preset.lng
    at_preset = bool(preset and event_attendance and (event_lat, event_lng) == (preset.lat, preset.lng))
    day = min(day, days - 1)
    scenario = {
        "rainfall_mm": rainfall_mm,
        "event_attendance": event_attendance,
        "event_lat": event_lat,
        "event_lng": event_lng,
        "venue": preset.id if at_preset else None,
        "day": day,
    }
    if city == "hcmc":
        districts = hcmc_district_forecasts(days, rainfall_mm, event_attendance, event_lat, event_lng)
        landfill = {**HCMC_LANDFILL, "kind": "landfill"}
        return build_twin_scene(
            get_city("hcmc"),
            districts,
            scenario=scenario,
            facilities=[landfill],
            normal_days=hcmc_district_forecasts(days),
        )

    def kecamatan_forecast(rain: float, attendance: int) -> list[dict[str, Any]]:
        return twin_jakarta_districts(
            predictions_kecamatan(
                rainfall_mm=rain,
                event_attendance=attendance,
                is_weekend=False,
                is_holiday=False,
                target_date=None,
                event_lat=event_lat,
                event_lng=event_lng,
                horizon_days=days,
            )
        )

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
    districts = kecamatan_forecast(rainfall_mm, event_attendance)
    normal_days = kecamatan_forecast(0.0, 0)

    def day_tons(rows: list[dict[str, Any]]) -> float:
        return sum(d["series"][day]["predicted_tons"] for d in rows if len(d["series"]) > day)

    # gsc P0-5: the one metric, scaled to this scenario's selected day (cached per
    # trucks/day, deterministic for its seed). The beacon fields beside it are
    # that same day's modelled peak hour, so beacon and headline share day and model.
    metric = scenario_queue_metric(day_tons(districts), day_tons(normal_days))
    return build_twin_scene(
        get_city("jakarta"),
        districts,
        scenario=scenario,
        facilities=facilities,
        normal_days=normal_days,
        trucks=command_center()["trucks"],
        tps=load_real_tps_coordinates(),
        landfill_queue={
            **tpa_queue_status_payload(trucks_per_day=metric["trucks_per_day"] if metric else None),
            "minutes_per_truck": metric,
        },
    )
