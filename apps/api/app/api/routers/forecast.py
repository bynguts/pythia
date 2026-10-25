"""Case 2 forecasting: kecamatan predictions, ML models, impact, weather, geo layers."""

from __future__ import annotations

import json
import math
import time
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from app.api.schemas import HybridPredictRequest
from app.api.state import _kecamatan_cache
from app.core.env import today
from app.core.paths import RAW_DIR
from app.core.units import UNIT_GLOSSARY
from app.fleet.data import build_predictions
from app.forecast.baseline import MAX_DAYS as MAX_BASELINE_DAYS
from app.forecast.baseline import build_outlook
from app.forecast.engine import (
    forecast_monthly_intake,
    forecast_waste_risk,
    list_hybrid_models,
    predict_waste_hybrid,
    predict_waste_hybrid_series,
)
from app.forecast.forecast_metrics import (
    monthly_backtest_metrics,
    suitability_details,
    suitability_labels,
)
from app.forecast.impact import build_impact_report
from app.forecast.real_data import (
    load_kecamatan_map,
    load_kelurahan_heatmap,
    load_official_events,
    load_real_tps_coordinates,
    load_real_wr_coordinates,
)
from app.forecast.twin import EVENT_REACH_BASIS, event_attendance_by_district
from app.forecast.weather import fetch_jakarta_weather_forecast

router = APIRouter()


@router.get("/api/predictions/kecamatan")
def predictions_kecamatan(
    rainfall_mm: float = Query(0.0, ge=0),
    event_attendance: int = Query(0, ge=0),
    is_weekend: bool = False,
    is_holiday: bool = False,
    target_date: date | None = None,
    event_lat: float | None = Query(None),
    event_lng: float | None = Query(None),
    horizon_days: int | None = Query(None, ge=2, le=30),
) -> dict[str, Any]:
    """Case 2 temporal-spatial map: per-kecamatan hybrid ML prediction over the
    real 42-kecamatan SILIKA baseline, with facility-readiness recommendation.

    Each kecamatan gets a Prophet+XGBoost model prediction (MODEL OUTPUT; the daily
    series it learned are calibrated-synthetic) plus operational needs
    (crews, man-hours, extra trucks) and a TPS capacity signal. When
    `horizon_days` is given, each kecamatan also carries a per-day model
    series (weekday/holiday drivers vary per day) plus horizon aggregates.
    """
    from fastapi.params import Query as FastAPIQuery

    if isinstance(horizon_days, FastAPIQuery):
        horizon_days = None
    cache_key = (
        rainfall_mm,
        event_attendance,
        is_weekend,
        is_holiday,
        target_date,
        event_lat,
        event_lng,
        horizon_days,
    )
    now = time.time()
    if _kecamatan_cache["key"] == cache_key and now - _kecamatan_cache["ts"] < 60.0:
        return _kecamatan_cache["payload"]

    kecs = load_kecamatan_map()

    # The twin's event geography (forecast/twin.py): the kecamatan whose real
    # boundary holds the venue or lies within the reach radius share the crowd.
    attendance_by_slug: dict[str, int] = {}
    if event_attendance > 0:
        elat = -6.2183 if (isinstance(event_lat, FastAPIQuery) or event_lat is None) else event_lat
        elng = 106.8022 if (isinstance(event_lng, FastAPIQuery) or event_lng is None) else event_lng
        attendance_by_slug = event_attendance_by_district(event_attendance, elat, elng)
    target_slugs = set(attendance_by_slug)

    features = []
    for k in kecs:
        current_attendance = attendance_by_slug.get(k["slug"], 0)
        pred = predict_waste_hybrid(
            kelurahan=k["slug"],
            rainfall_mm=rainfall_mm,
            is_weekend=is_weekend,
            is_holiday=is_holiday,
            event_attendance=current_attendance,
            target_date=target_date.isoformat() if target_date else None,
        )
        tons = pred["predicted_tons"]
        cap = k.get("tps_capacity_ton_per_day")
        facility_alert = bool(cap is not None and tons > cap)
        horizon_block: dict[str, Any] = {}
        if horizon_days:
            series = predict_waste_hybrid_series(
                k["slug"],
                days=horizon_days,
                rainfall_mm=rainfall_mm,
                event_attendance=current_attendance,
                start_date=(target_date.isoformat() if target_date else None),
            )
            horizon_block = {
                "horizon_avg_daily_tons": series["avg_daily_tons"],
                "horizon_total_tons": series["total_tons"],
                "horizon_peak_date": series["peak_date"],
                "horizon_peak_tons": series["peak_tons"],
                "daily_series": series["series"],
            }
        features.append(
            {
                **k,
                "predicted_tons": tons,
                **horizon_block,
                "model_available": pred["model_available"],
                "crews_required": pred["crews_required"],
                "workers_required": pred["workers_required"],
                "man_hours_required": pred["man_hours_required"],
                "bins_required": pred["bins_required"],
                "trucks_required": pred.get("trucks_required") or max(1, math.ceil(tons / 18)),
                "facility_over_capacity": facility_alert,
                "prophet_baseline_tons": pred.get("prophet_baseline_tons"),
                "xgboost_residual": pred.get("xgboost_residual"),
                "factor_attribution": pred.get("factor_attribution"),
                "factors": pred.get("factors"),
                "prediction_interval_p10_p90": pred.get("prediction_interval_p10_p90"),
                "co2_emissions_kg": pred.get("co2_emissions_kg"),
                "fuel_consumption_liters": pred.get("fuel_consumption_liters"),
                "daily_district_suitability": pred.get("daily_district_suitability"),
            }
        )
    features.sort(key=lambda f: f["predicted_tons"], reverse=True)
    total = sum(f["predicted_tons"] for f in features)
    # Necessary: each uncached build runs 42 model predicts (~1-3s), and 4
    # parallel workers can each issue one on mount; the 60s keyed cache keeps
    # repeated identical requests (the common case) at near-zero cost.
    _kecamatan_cache["key"] = cache_key
    _kecamatan_cache["ts"] = time.time()
    _kecamatan_cache["payload"] = {
        "generated_for": (target_date.isoformat() if target_date else today().isoformat()),
        "horizon_days": horizon_days or 1,
        "scenario": {
            "rainfall_mm": rainfall_mm,
            "event_attendance": event_attendance,
            "is_weekend": is_weekend,
            "is_holiday": is_holiday,
            "event_lat": event_lat,
            "event_lng": event_lng,
            # Which kecamatan the event attendance was localized to. Empty when
            # no attendance was supplied, so a bare location cannot look like
            # demand.
            "targeted_kecamatan": sorted(target_slugs),
            "attendance_by_kecamatan": attendance_by_slug,
            "event_reach_basis": EVENT_REACH_BASIS if attendance_by_slug else None,
        },
        "kecamatan_count": len(features),
        "total_predicted_tons": round(total, 1),
        "top_hotspots": features[:5],
        "kecamatan": features,
        "units": UNIT_GLOSSARY,
        # The baseline is real (SILIKA 2023); the daily series the hybrid learned are
        # calibrated-synthetic, so this source line must never read as observed data.
        "source": (
            "SILIKA DLH 2023 baseline + Prophet/XGBoost hybrid trained on calibrated-synthetic "
            "daily series anchored to SILIKA 2023 (MODEL OUTPUT, no daily accuracy claim)"
        ),
    }
    return _kecamatan_cache["payload"]


@router.get("/api/baseline/today")
def baseline_today(days: int = Query(7, ge=2, le=MAX_BASELINE_DAYS)) -> dict[str, Any]:
    """The one "today" every workspace shows: today's forecast weather, no event.

    The same frame as /api/twin/scene's default (forecast/baseline.py), so the
    twin, the forecast page and the planning page print identical figures.
    """
    return build_outlook(days=days)


@router.get("/api/baseline/scenario")
def baseline_scenario(
    rainfall_mm: float = Query(0.0, ge=0, le=300),
    event_attendance: int = Query(0, ge=0, le=2_000_000),
    venue: str | None = Query(None, max_length=40),
    event_lat: float | None = Query(None, ge=-90, le=90),
    event_lng: float | None = Query(None, ge=-180, le=180),
    target_date: date | None = Query(None, alias="date"),
    days: int = Query(7, ge=2, le=MAX_BASELINE_DAYS),
) -> dict[str, Any]:
    """A what-if on one day of the baseline week, labelled `kind: "scenario"`.

    Without rain or attendance this is that day's baseline (`kind: "baseline"`).
    """
    try:
        return build_outlook(
            days=days,
            target_date=target_date.isoformat() if target_date else None,
            rainfall_mm=rainfall_mm,
            event_attendance=event_attendance,
            venue=venue,
            event_lat=event_lat,
            event_lng=event_lng,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/api/events/official")
def official_events() -> list[dict[str, Any]]:
    """Real, officially-scraped Jakarta events (attendance may be unknown)."""
    return load_official_events()


@router.get("/api/predictions")
def predictions(
    date: str | None = Query(None, description="Filter predictions by date (YYYY-MM-DD)"),
    event_scale: float | None = Query(
        None, ge=0.5, le=3.0, description="Simulate an event multiplier (0.5x - 3.0x)"
    ),
) -> list[dict]:
    """
    Enhanced waste prediction endpoint supporting dynamic simulation and filtering.
    """
    preds = build_predictions()

    # Apply dynamic parameters
    if date:
        preds = [p for p in preds if p["date"] == date]

    if event_scale is not None:
        for p in preds:
            # Recalculate baseline waste under custom simulated event load
            new_attendance = int(85000 * event_scale) if p.get("spike_percent", 0) > 10 else 0
            risk = forecast_waste_risk(
                baseline_tons=p["baseline_tons"],
                rainfall_mm=42.0 if event_scale > 1.5 else 5.0,
                expected_attendance=new_attendance,
                is_weekend=p["date"] == date,
            )
            p.update(risk)

    return preds


@router.get("/api/geo/kelurahan-heatmap")
def kelurahan_heatmap(
    rainfall_mm: float = Query(0.0, ge=0),
    event_attendance: int = Query(0, ge=0),
    is_weekend: bool = False,
    is_holiday: bool = False,
    event_lat: float | None = Query(None),
    event_lng: float | None = Query(None),
) -> JSONResponse:
    """267-kelurahan risk heatmap joined to real SILIKA kecamatan baselines."""
    try:
        preds = predictions_kecamatan(
            rainfall_mm=rainfall_mm,
            event_attendance=event_attendance,
            is_weekend=is_weekend,
            is_holiday=is_holiday,
            event_lat=event_lat,
            event_lng=event_lng,
        )
        kec_predictions = {k["kecamatan"]: k["predicted_tons"] for k in preds["kecamatan"]}
        return JSONResponse(load_kelurahan_heatmap(kec_predictions))
    except (OSError, ValueError):
        fallback = RAW_DIR / "jakarta_kelurahan_heatmap.geojson"
        if fallback.exists():
            return JSONResponse(json.loads(fallback.read_text(encoding="utf-8")))
        raise HTTPException(
            status_code=404, detail="Kelurahan heatmap GeoJSON has not been generated."
        ) from None


@router.get("/api/facilities/gap-analysis")
def facility_gap_analysis(
    rainfall_mm: float = Query(0.0, ge=0),
    event_attendance: int = Query(0, ge=0),
    is_weekend: bool = False,
    outlook: bool = Query(False, description="Use today's baseline (or its what-if) as the demand"),
) -> dict[str, Any]:
    """Case 2 facility readiness: predicted demand vs TPS capacity proxy per
    kecamatan, with concrete new-site counts, extra trucks, and kelurahan
    siting candidates. Capacity is a labeled proxy, never official capacity.

    With `outlook=true` the demand is today's baseline (forecast/baseline.py),
    or its what-if when rain or attendance is given, so the facility tab
    prints the same kecamatan tonnes as the forecast tab.
    """
    from app.forecast.facility_planning import build_facility_gap_analysis

    if outlook:
        result_outlook = build_outlook(rainfall_mm=rainfall_mm, event_attendance=event_attendance)
        tons_by_slug = {row["slug"]: row["predicted_tons"] for row in result_outlook["kecamatan"]}
        kec_predictions = {
            k["kecamatan"]: tons_by_slug[k["slug"]] for k in load_kecamatan_map() if k["slug"] in tons_by_slug
        }
    else:
        preds = predictions_kecamatan(
            rainfall_mm=rainfall_mm,
            event_attendance=event_attendance,
            is_weekend=is_weekend,
        )
        kec_predictions = {k["kecamatan"]: k["predicted_tons"] for k in preds["kecamatan"]}
    result = build_facility_gap_analysis(kec_predictions)
    result["scenario"] = {
        "rainfall_mm": rainfall_mm,
        "event_attendance": event_attendance,
        "is_weekend": is_weekend,
        "outlook": result_outlook["kind"] if outlook else None,
        "date": result_outlook["date"] if outlook else None,
    }
    return result


@router.get("/api/weather")
def weather() -> dict:
    return fetch_jakarta_weather_forecast()


@router.get("/api/ml/models")
def ml_models_status() -> list[dict[str, Any]]:
    return list_hybrid_models()


@router.get("/api/ml/suitability")
def ml_suitability() -> dict[str, Any]:
    """Honest per-resolution suitability with validation-target classes (#18).

    Only the monthly landfill/city intake forecast is backtested on real data
    ('backtested_real', numbers from the training artifact in
    `monthly_backtest`); resolutions validated against the calibrated-synthetic
    district series are labeled 'synthetic_validated' with their evidence exposed.
    """
    return {
        # 'resolutions' key retained for existing frontend consumers.
        "resolutions": suitability_labels(),
        "details": suitability_details(),
        "monthly_backtest": monthly_backtest_metrics(),
        "note": "Daily per-district resolution is calibrated-synthetic and must not be presented as observed accuracy.",
    }


@router.get("/api/ml/monthly-intake")
def ml_monthly_intake(
    months: int = Query(3, ge=1, le=12),
    start_month: str | None = Query(None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
) -> dict[str, Any]:
    """Monthly Bantargebang intake forecast (t/day), the forecast backtested on real data.

    `start_month` (YYYY-MM) lets the UI ask for the months the operator is in; each
    month still carries `horizon_months` and `within_backtested_horizon`, so a month
    beyond the backtested 1-3 month horizon is flagged, never presented as validated.
    """
    result = forecast_monthly_intake(months, start_month=start_month)
    if any(m["horizon_months"] < 1 for m in result["months"]):
        raise HTTPException(
            status_code=422,
            detail=f"start_month must be after the last observed month ({result['fitted_through']}).",
        )
    return result


@router.get("/api/impact")
def impact_report() -> dict[str, Any]:
    """Reproducible impact metrics with per-metric provenance and honest labels."""
    return build_impact_report()


@router.post("/api/ml/predict")
def ml_predict_district(payload: HybridPredictRequest) -> dict[str, Any]:
    res = predict_waste_hybrid(
        kelurahan=payload.kelurahan,
        rainfall_mm=payload.precipitation_mm,
        temp_max_c=payload.temp_max_c,
        wind_max_kmh=payload.wind_max_kmh,
        is_weekend=payload.is_weekend,
        is_holiday=payload.is_holiday,
        event_attendance=payload.event_attendance,
        target_date=payload.target_date.isoformat() if payload.target_date else None,
    )
    return res


@router.post("/api/ml/predict-all")
def ml_predict_all(
    precipitation_mm: float = 0.0,
    temp_max_c: float = 31.0,
    wind_max_kmh: float = 10.0,
    is_weekend: bool = False,
    is_holiday: bool = False,
    event_attendance: int = 0,
    target_date: date | None = None,
) -> list[dict[str, Any]]:
    models = list_hybrid_models()
    results = []
    for m in models:
        res = predict_waste_hybrid(
            kelurahan=m["kelurahan"],
            rainfall_mm=precipitation_mm,
            temp_max_c=temp_max_c,
            wind_max_kmh=wind_max_kmh,
            is_weekend=is_weekend,
            is_holiday=is_holiday,
            event_attendance=event_attendance,
            target_date=target_date.isoformat() if target_date else None,
        )
        results.append(res)
    return results


@router.get("/api/geo/tps-coordinates")
def get_tps_coordinates() -> dict[str, Any]:
    """Returns all 1,081 official TPS locations as a GeoJSON FeatureCollection."""
    tps_list = load_real_tps_coordinates()
    features = []
    for t in tps_list:
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [t["lng"], t["lat"]]},
                "properties": {"name": t["name"], "kecamatan": t["kecamatan"], "kelurahan": t["kelurahan"]},
            }
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "source": "Official SILIKA 2023 coordinates",
        "total": len(features),
    }


@router.get("/api/geo/wr-coordinates")
def get_wr_coordinates() -> dict[str, Any]:
    """Returns all official Wajib Retribusi locations as a GeoJSON FeatureCollection."""
    wr_list = load_real_wr_coordinates()
    features = []
    for w in wr_list:
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [w["lng"], w["lat"]]},
                "properties": {
                    "name": w["name"],
                    "type": w["jns"],
                    "kecamatan": w["kec"],
                    "kelurahan": w["kel"],
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "source": "Official SILIKA Wajib Retribusi 2023 coordinates",
        "total": len(features),
    }
