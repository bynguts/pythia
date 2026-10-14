"""3D digital twin scene."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.api.routers.fleet import command_center
from app.api.routers.forecast import predictions_kecamatan
from app.api.routers.operations import get_tpa_queue_status
from app.fleet.facilities import FACILITIES
from app.forecast.cities import HCMC_LANDFILL, get_city, hcmc_district_forecasts
from app.forecast.real_data import load_real_tps_coordinates
from app.forecast.twin import build_scene as build_twin_scene
from app.forecast.twin import jakarta_districts as twin_jakarta_districts

router = APIRouter()


@router.get("/api/twin/scene")
def twin_scene(
    city: str = Query("jakarta", pattern="^(jakarta|hcmc)$"),
    days: int = Query(7, ge=2, le=14),
    rainfall_mm: float = Query(0.0, ge=0, le=300),
    event_attendance: int = Query(0, ge=0, le=2_000_000),
    event_lat: float | None = Query(None, ge=-90, le=90),
    event_lng: float | None = Query(None, ge=-180, le=180),
) -> dict[str, Any]:
    """Everything the 3D digital twin draws for one city, with per-layer provenance.

    Jakarta uses the trained per-kecamatan forecast (via the cached kecamatan
    endpoint), the simulated pilot fleet and the real SILIKA TPS points. Ho Chi
    Minh City is a labelled demo city (population-share allocation, no model).
    """
    scenario = {
        "rainfall_mm": rainfall_mm,
        "event_attendance": event_attendance,
        "event_lat": event_lat,
        "event_lng": event_lng,
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
    return build_twin_scene(
        get_city("jakarta"),
        kecamatan_forecast(rainfall_mm, event_attendance),
        scenario=scenario,
        facilities=facilities,
        normal_days=kecamatan_forecast(0.0, 0),
        trucks=command_center()["trucks"],
        tps=load_real_tps_coordinates(),
        landfill_queue=get_tpa_queue_status(scenario="live"),
    )
