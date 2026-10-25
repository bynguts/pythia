"""
engine.py — Pythia core logic.
Includes:
- Hybrid Predict (Prophet + XGBoost per district)
- Route Deviation Detection (Isolation Forest)
- Landfill Staggered Dispatch Simulator & OSRM ETA adjustments
- Crew Man-Hours, fuel, and facility requirements planner
"""

from __future__ import annotations

import calendar
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from math import asin, cos, exp, radians, sin, sqrt
from typing import Any
from uuid import uuid4

import joblib
import numpy as np
import pandas as pd

from app.core.env import today
from app.core.paths import MODELS_DIR, MONTHLY_CALENDAR_MODEL, REAL_DIR
from app.core.units import EVENT_WASTE_KG_PER_PERSON, resource_requirements
from app.fleet.queue_simulation import STAGGER_SLOT_MINUTES

# 42 Jakarta kecamatan (matches ml/scripts/train_models.py; models named by slug).
_KELURAHAN_SLUGS = [
    "gambir",
    "sawah_besar",
    "kemayoran",
    "senen",
    "cempaka_putih",
    "menteng",
    "tanah_abang",
    "johar_baru",
    "penjaringan",
    "tanjung_priok",
    "koja",
    "cilincing",
    "pademangan",
    "kelapa_gading",
    "cengkareng",
    "grogol_petamburan",
    "taman_sari",
    "tambora",
    "kebon_jeruk",
    "kali_deres",
    "palmerah",
    "kembangan",
    "tebet",
    "setiabudi",
    "mampang_prapatan",
    "pasar_minggu",
    "kebayoran_lama",
    "cilandak",
    "kebayoran_baru",
    "pancoran",
    "jagakarsa",
    "pesanggrahan",
    "matraman",
    "pulo_gadung",
    "jatinegara",
    "kramat_jati",
    "pasar_rebo",
    "cakung",
    "duren_sawit",
    "makasar",
    "ciracas",
    "cipayung",
]


@lru_cache(maxsize=128)
def _load_hybrid(kelurahan_slug: str) -> tuple[Any, Any] | None:
    p_path = MODELS_DIR / f"prophet_{kelurahan_slug}.joblib"
    x_path = MODELS_DIR / f"xgboost_{kelurahan_slug}.joblib"
    if not (p_path.exists() and x_path.exists()):
        return None
    try:
        return joblib.load(p_path), joblib.load(x_path)
    except Exception:
        # A silent fallback here made every district predict the flat 150 t
        # heuristic; log so a missing dependency (e.g. pyarrow) is visible.
        logging.getLogger(__name__).exception(
            "hybrid model for %s exists but failed to load; using fallback heuristic", kelurahan_slug
        )
        return None


@lru_cache(maxsize=4096)
def _prophet_yhat(kelurahan_slug: str, days: tuple[str, ...]) -> tuple[float, ...]:
    """Prophet baseline for the given ISO dates.

    Weather and event drivers only enter through the XGBoost residual, so this
    is shared by every scenario. Necessary: Prophet's predict (uncertainty
    sampling) dominated scenario recomputes — ~0.5 s per kecamatan call.
    """
    prophet_model, _ = _load_hybrid(kelurahan_slug)
    frame = pd.DataFrame({"ds": pd.to_datetime(list(days))})
    return tuple(float(v) for v in prophet_model.predict(frame)["yhat"])


def hybrid_models_loadable() -> bool:
    """Health probe: True when at least one on-disk hybrid pair unpickles."""
    return _load_hybrid(_KELURAHAN_SLUGS[0]) is not None


try:
    _ISOLATION_MODEL = joblib.load(MODELS_DIR / "isolation_forest_fleet.joblib")
except Exception:
    _ISOLATION_MODEL = None


# ═════════════════════════════════════════════════════════════════════
# 1. FLEET ROUTING & ANOMALY DETECTION (CASE 1)
# ═════════════════════════════════════════════════════════════════════


def _haversine_meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6371000.0  # Earth's radius in meters
    lat1, lon1 = radians(a[0]), radians(a[1])
    lat2, lon2 = radians(b[0]), radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    val = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * R * asin(sqrt(val))


def _latlng_to_local_m(point, origin) -> tuple[float, float]:
    """Equirectangular projection to local metres around origin (small-area ok)."""
    R = 6371000.0
    lat0 = radians(origin[0])
    x = radians(point[1] - origin[1]) * cos(lat0) * R
    y = radians(point[0] - origin[0]) * R
    return x, y


def _point_to_segment_m(p, a, b) -> float:
    """Shortest distance (metres) from point p to segment a-b."""
    px, py = _latlng_to_local_m(p, a)
    bx, by = _latlng_to_local_m(b, a)
    seg_len_sq = bx * bx + by * by
    if seg_len_sq == 0:
        return sqrt(px * px + py * py)
    t = max(0.0, min(1.0, (px * bx + py * by) / seg_len_sq))
    cx, cy = t * bx, t * by
    return sqrt((px - cx) ** 2 + (py - cy) ** 2)


def distance_point_to_polyline_m(position, path) -> float:
    """Shortest distance (metres) from a position to a polyline route.

    Distance is measured to the nearest route SEGMENT, not the nearest
    waypoint — a truck mid-segment is on-route even if far from any vertex.
    """
    if not path:
        return float("inf")
    if len(path) == 1:
        return _haversine_meters(position, path[0])
    return min(_point_to_segment_m(position, path[i], path[i + 1]) for i in range(len(path) - 1))


def detect_route_deviation(
    assigned_path: list[tuple[float, float]],
    latest_position: tuple[float, float],
    speed_kmh: float = 30.0,
    threshold_meters: float = 500.0,
) -> dict[str, Any]:
    if not assigned_path:
        return {
            "violated": True,
            "distance_meters": 0,
            "ml_outlier": False,
            "ml_score": None,
            "rule_flags": ["no_assigned_route"],
            "confidence": 1.0,
            "severity": "unknown",
            "message": "No assigned route is available for comparison.",
        }

    distance = distance_point_to_polyline_m(latest_position, assigned_path)
    rule_flags: list[str] = []
    if distance > threshold_meters:
        rule_flags.append("off_corridor")
    if distance > threshold_meters * 2:
        rule_flags.append("far_off_corridor")

    ml_flagged = False
    ml_score: float | None = None
    if _ISOLATION_MODEL is not None:
        try:
            arr = np.array([[latest_position[0], latest_position[1], speed_kmh]])
            ml_flagged = bool(_ISOLATION_MODEL.predict(arr)[0] == -1)
            ml_score = float(_ISOLATION_MODEL.score_samples(arr)[0])
            if ml_flagged:
                rule_flags.append("ml_outlier")
        except Exception:
            pass

    heuristic_violated = distance > threshold_meters
    violated = heuristic_violated or ml_flagged

    # Severity: distance-driven rules are authoritative; ML alone is a warning.
    severity = "normal"
    if distance > threshold_meters * 2:
        severity = "critical"
    elif violated:
        severity = "warning"

    # Confidence: high when rule and ML agree, moderate when only one fires.
    if heuristic_violated and ml_flagged:
        confidence = 0.95
    elif heuristic_violated:
        confidence = 0.8
    elif ml_flagged:
        confidence = 0.5
    else:
        confidence = 0.9

    return {
        "violated": violated,
        "distance_meters": round(distance, 1),
        "ml_outlier": ml_flagged,
        "ml_score": round(ml_score, 4) if ml_score is not None else None,
        "rule_flags": rule_flags,
        "confidence": confidence,
        "severity": severity,
        "message": (
            f"Truck is {distance:.0f} meters from the assigned corridor."
            if violated
            else "Truck remains inside the assigned corridor."
        ),
    }


def detect_violation_types(
    speed_kmh: float,
    activity_state: str,
    deviation_violated: bool,
    deviation_meters: float,
) -> list[str]:
    """Classify operational violation types beyond route deviation.

    Each type maps to a real DLH enforcement concern; thresholds are demo
    constants documented for auditability.
    """
    types: list[str] = []
    if deviation_violated:
        types.append("route_deviation")
    if speed_kmh > 45.0 and activity_state in ("hauling_to_tpa", "returning"):
        types.append("abnormal_speed")  # >45 km/h on urban collection route
    if speed_kmh < 3.0 and activity_state == "hauling_to_tpa":
        types.append("unauthorized_idle")  # should be moving but stationary
    if activity_state == "maintenance_hold" and speed_kmh > 5.0:
        types.append("operating_while_damaged")  # damaged truck still moving
    return types


def recommend_routes(routes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compliant = [r for r in routes if r.get("permit_compliant", False)]
    scored = []
    for route in compliant:
        score = route["eta_minutes"] * 0.55 + route["traffic_level"] * 35 + route["flood_risk"] * 45
        scored.append(
            {
                **route,
                "score": round(score, 2),
                "reason": (
                    "recommended because it is permit-compliant, has the lowest combined "
                    f"ETA/traffic/flood risk score ({score:.1f})"
                ),
            }
        )
    return sorted(scored, key=lambda item: item["score"])


def estimate_tpa_queue_wait(waiting_trucks: int, throughput_per_hour: int = 30) -> dict[str, Any]:
    """
    Calculate TPA queue status dynamically.
    Throughput is standard 30 trucks/hour (2 minutes per truck dump time).
    """
    wait_minutes = round((waiting_trucks / throughput_per_hour) * 60)

    status = "green"
    if wait_minutes >= 90:
        status = "red"
    elif wait_minutes >= 45:
        status = "yellow"

    recommendation = (
        "Delay departures of non-essential trucks by 30-45 minutes to relieve Bantargebang gridlock."
    )
    if status == "green":
        recommendation = "Green corridor clear. Normal dispatch speed approved."
    elif status == "yellow":
        recommendation = (
            f"Stagger dispatch cycles by {STAGGER_SLOT_MINUTES} minutes to flatten landfill load spike."
        )

    return {
        "trucks_waiting": waiting_trucks,
        "estimated_wait_minutes": wait_minutes,
        "throughput_trucks_per_hour": throughput_per_hour,
        "status": status,
        "recommendation": recommendation,
    }


def simulate_staggered_dispatch(active_trucks: int | None = None) -> dict[str, Any]:
    """Staggered-dispatch impact, read from the one TPA queue metric (gsc P0-5).

    The wait figures are the cached daily Bantargebang simulation (real daily
    arrival count, labelled assumptions). `active_trucks` only sizes the
    departure-slot plan; it defaults to one shift's share of the daily arrivals.
    """
    from app.fleet.queue_simulation import (
        FIRST_SHIFT_START_HOUR,
        SHIFTS_PER_DAY,
        queue_minutes_per_truck,
        stagger_slot_count,
    )

    metric = queue_minutes_per_truck()
    if metric is None:
        metric = queue_minutes_per_truck(max(1, active_trucks or 1))
    fleet = (
        active_trucks if active_trucks and active_trucks > 0 else metric["trucks_per_day"] // SHIFTS_PER_DAY
    )
    slot_minutes = metric["recommended_stagger_minutes"]
    slots = stagger_slot_count()
    schedule = []
    for k in range(min(slots, fleet)):
        departure = FIRST_SHIFT_START_HOUR * 60 + k * slot_minutes
        schedule.append(
            {
                "slot_index": k + 1,
                "suggested_departure": f"{departure // 60:02d}:{departure % 60:02d}",
                "trucks_in_slot": fleet // slots + (1 if k < fleet % slots else 0),
                "slot_status": "planned",
                "tpa_wait_est_minutes": metric["staggered_mean"],
            }
        )

    b_wait = metric["baseline_mean"]
    s_wait = metric["staggered_mean"]
    reduction = round(((b_wait - s_wait) / b_wait) * 100, 1) if b_wait > 0 else 0.0
    return {
        "baseline_wait_minutes": b_wait,
        "baseline_p95_minutes": metric["baseline_p95"],
        "baseline_queue_trucks": metric["baseline_max_queue"],
        "optimized_wait_minutes": s_wait,
        "optimized_p95_minutes": metric["staggered_p95"],
        "optimized_queue_trucks": metric["staggered_max_queue"],
        "queue_reduction_percent": reduction,
        "recommended_stagger_minutes": slot_minutes,
        "wait_ci95": metric["staggered_ci95"],
        "baseline_ci95": metric["baseline_ci95"],
        "trucks_per_day": metric["trucks_per_day"],
        "fleet_per_shift": fleet,
        "seed": metric["seed"],
        "replications": metric["replications"],
        "classification": metric["classification"],
        "source": metric["source"],
        "method": "seeded discrete-event queue simulation",
        "minutes_per_truck": metric,
        "dispatch_slots": schedule,
    }


# ═════════════════════════════════════════════════════════════════════
# 2. WASTE FORECAST — HEURISTIC (deterministic, test-validated)
# ═════════════════════════════════════════════════════════════════════


def forecast_waste_risk(
    baseline_tons: float,
    rainfall_mm: float,
    expected_attendance: int,
    is_weekend: bool,
) -> dict[str, Any]:
    spike = 0.0
    factors: list[str] = []

    if rainfall_mm >= 30:
        spike += 0.16
        factors.append("Heavy rainfall adds flood-related waste and slows collection (+16%).")
    elif rainfall_mm >= 10:
        spike += 0.08
        factors.append("Rainfall may slow collection and increase wet waste (+8%).")

    if expected_attendance >= 50_000:
        spike += 0.18
        factors.append("Large permitted event increases waste around crowded areas (+18%).")
    elif expected_attendance >= 10_000:
        spike += 0.09
        factors.append("Medium event increases localized waste generation (+9%).")

    if is_weekend:
        spike += 0.07
        factors.append("Weekend activity raises commercial and public-space waste (+7%).")

    spike_percent = round(spike * 100)
    predicted_tons = round(baseline_tons * (1 + spike), 1)
    risk_level = "normal"
    if spike_percent >= 30:
        risk_level = "critical"
    elif spike_percent >= 20:
        risk_level = "high"
    elif spike_percent >= 10:
        risk_level = "watch"

    # Operational requirements in the canonical units (app.core.units): one truck
    # carries TRUCK_CAPACITY_TONS, one crew rides one truck, man-hours are
    # person-hours. Every producer in the backend shares this block.
    resources = resource_requirements(predicted_tons, baseline_tons=baseline_tons)

    return {
        "baseline_tons": baseline_tons,
        "predicted_tons": predicted_tons,
        "spike_percent": spike_percent,
        "risk_level": risk_level,
        "factors": factors or ["No unusual driver detected."],
        **resources,
        "fuel_consumption_liters": round(predicted_tons * 1.8, 1),
        "co2_emissions_kg": round(predicted_tons * 1.8 * 2.68, 1),  # 2.68 kg CO2 per liter solar
    }


# ═════════════════════════════════════════════════════════════════════
# 3. WASTE FORECAST — HYBRID ML (Prophet + XGBoost per kelurahan)
# ═════════════════════════════════════════════════════════════════════


# Training builds rain_3d as the rolling 3-day rainfall SUM (ml/scripts/train_models.py
# rain_3d). A scenario holds rainfall constant, so the matching serving value is 3 x rain.
RAIN_3D_WINDOW_DAYS = 3


def scenario_rain_3d(rainfall_mm: float) -> float:
    """rain_3d for a constant-rain scenario, consistent with the training definition."""
    return round(float(rainfall_mm) * RAIN_3D_WINDOW_DAYS, 2)


def rolling_rain_3d(rain_by_day: tuple[float, ...]) -> list[float]:
    """rain_3d for per-day rain: the training's rolling 3-day sum ending on the day
    (min_periods=1, so the first days sum what the horizon holds)."""
    return [
        round(sum(rain_by_day[max(0, i - RAIN_3D_WINDOW_DAYS + 1) : i + 1]), 2)
        for i in range(len(rain_by_day))
    ]


# ── The rain response (gsc teardown v3 #7) ────────────────────────────────
# The daily training target is calibrated-synthetic: SILIKA level x a hand-set
# planning rule (+8% from 10 mm, +16% from 30 mm of same-day rain, nothing below
# 10 mm, no multi-day effect) x 5% noise (ml/scripts/train_models.py build_dataset).
# Read raw, the trees reproduce that rule with their noise: 3-8 mm LOWERED the
# city by about 3%, 80 mm gave fewer districts at risk than 50 mm, and nothing
# moves above the wettest training day. So the served rain effect is the model's
# own response read on a whole-mm grid, held non-decreasing (running maximum) and
# never below the dry normal day; above the training range it is held at the
# training maximum. Every payload that carries a rain effect states this.
RAIN_RULE_STEPS_MM = (10.0, 30.0)
RAIN_RULE_STEPS_PERCENT = (8, 16)
# Wettest day / 3-day sum in the training weather (ml/data/raw/open_meteo_jakarta_history_5y.json,
# as written to training_dataset_kecamatan.csv; parity-tested when the CSV is present).
TRAINING_RAIN_MAX_MM = 96.7
TRAINING_RAIN_3D_MAX_MM = 123.7
RAIN_GRID_STEP_MM = 1.0


def rain_grid(rain_mm: float) -> list[float]:
    """The rain values the response reads for `rain_mm`: every whole mm up to it, capped
    at the training maximum (which joins the grid once reached). The grid only grows
    with `rain_mm`, so a running maximum over it can never fall as rain rises."""
    top = min(max(float(rain_mm), 0.0), TRAINING_RAIN_MAX_MM)
    grid = [float(g) for g in range(int(top) + 1)]
    if rain_mm >= TRAINING_RAIN_MAX_MM:
        grid.append(TRAINING_RAIN_MAX_MM)
    return grid


def rain_response_block(max_rain_mm: float) -> dict[str, Any]:
    """How the served rain effect is formed, for a request whose wettest day is `max_rain_mm`."""
    beyond = float(max_rain_mm) > TRAINING_RAIN_MAX_MM
    steps = " and ".join(
        f"+{p}% from {mm:g} mm" for mm, p in zip(RAIN_RULE_STEPS_MM, RAIN_RULE_STEPS_PERCENT, strict=True)
    )
    return {
        "method": "model_monotone",
        "label": (
            f"Rain effect: the trained model's response read on a {RAIN_GRID_STEP_MM:g} mm grid, held "
            "non-decreasing and never below the dry normal day. The training target was built from a "
            f"planning rule ({steps}), so rain above {RAIN_RULE_STEPS_MM[-1]:g} mm adds no learned "
            "effect (assumption, not learned)."
        ),
        "rule_steps_mm": list(RAIN_RULE_STEPS_MM),
        "rule_steps_percent": list(RAIN_RULE_STEPS_PERCENT),
        "grid_step_mm": RAIN_GRID_STEP_MM,
        "training_max_rain_mm": TRAINING_RAIN_MAX_MM,
        "max_rain_mm": float(max_rain_mm),
        "beyond_training_range": beyond,
        "held_at_mm": TRAINING_RAIN_MAX_MM if beyond else None,
    }


def _monotone_rain_residuals(
    xgboost_model: Any, rows: list[dict[str, Any]], carried: list[float], rain_3d_per_mm: float
) -> tuple[np.ndarray, np.ndarray]:
    """(residual, rain effect) per feature row, with the rain response made monotone.

    Each row is read at its dry point (no rain, rain_3d 0: the normal day's residual)
    and along its own rain line: precipitation g, rain_3d = carried + rain_3d_per_mm x g,
    for g on `rain_grid`. The rain effect is the running maximum of (line - dry),
    floored at 0. One predict call for every row and grid point.
    """
    batch: list[dict[str, Any]] = []
    spans: list[tuple[int, int]] = []
    for row, carry in zip(rows, carried, strict=True):
        start = len(batch)
        batch.append({**row, "precipitation_mm": 0.0, "rain_3d": 0.0})
        for g in rain_grid(row["precipitation_mm"]):
            batch.append({**row, "precipitation_mm": g, "rain_3d": round(carry + rain_3d_per_mm * g, 2)})
        spans.append((start, len(batch)))
    predicted = xgboost_model.predict(pd.DataFrame(batch, columns=list(rows[0])))
    dry = np.array([predicted[a] for a, _b in spans], dtype=float)
    effect = np.array([max(0.0, float(np.max(predicted[a + 1 : b] - predicted[a]))) for a, b in spans])
    return dry + effect, effect


# ── The one risk definition (gsc teardown #5) ────────────────────────────
# A day's spike is its forecast against the same district's normal day: the
# same model, the same date, no rain and no event. Fleet and Twin both classify
# with spike_risk, so "spike" and "at risk" mean the same thing on every screen.
# (The TPS capacity column is a proxy that 40 of 42 kecamatan already exceed,
# so it cannot drive a daily alarm.)
RISK_CRITICAL_RATIO = 1.25
RISK_HIGH_RATIO = 1.10
RISK_ELEVATED_RATIO = 1.03
AT_RISK_LEVELS = frozenset({"high", "critical"})
NORMAL_DAY_BASIS = "same model, same date, no rain and no event"


def spike_risk(tons: float, normal_tons: float | None) -> tuple[float, str]:
    """(spike percent vs the normal day, risk level) for one forecast day."""
    ratio = tons / normal_tons if normal_tons else 1.0
    if ratio >= RISK_CRITICAL_RATIO:
        level = "critical"
    elif ratio >= RISK_HIGH_RATIO:
        level = "high"
    elif ratio >= RISK_ELEVATED_RATIO:
        level = "elevated"
    else:
        level = "normal"
    return round((ratio - 1.0) * 100, 1), level


@lru_cache(maxsize=1024)
def predict_waste_hybrid(
    kelurahan: str,
    rainfall_mm: float = 0,
    temp_max_c: float = 31.0,
    wind_max_kmh: float = 10.0,
    is_weekend: bool = False,
    is_holiday: bool = False,
    event_attendance: int = 0,
    target_date: str | None = None,
) -> dict[str, Any]:
    slug = kelurahan.lower().replace(" ", "_")
    models = _load_hybrid(slug)

    if models is None:
        # Fallback when a model file is missing: coarse heuristic, clearly labeled.
        day = pd.Timestamp(target_date or today())
        fallback_baseline = 150.0
        prophet_pred = fallback_baseline * (1.05 if is_weekend else 1.0)
        residual_pred = (rainfall_mm * 1.2) + (event_attendance * 0.0012)
        predicted_tons = max(0.0, round(float(prophet_pred + residual_pred), 1))

        # Calculate requirements
        resources = resource_requirements(predicted_tons)

        return {
            "kelurahan": kelurahan,
            "model_available": False,
            "prophet_baseline_tons": round(float(prophet_pred), 1),
            "xgboost_residual": round(float(residual_pred), 1),
            "predicted_tons": predicted_tons,
            "prediction_interval_p10_p90": [round(predicted_tons * 0.6, 1), round(predicted_tons * 1.4, 1)],
            "daily_district_suitability": "not_supported_fallback_heuristic",
            "factor_attribution": {
                "rainfall_tons": round(rainfall_mm * 1.2, 1),
                "event_tons": round(event_attendance * 0.0012, 1),
                "weekend_tons": round(fallback_baseline * 0.05, 1) if is_weekend else 0.0,
                "holiday_tons": 0.0,
                "prophet_baseline_tons": round(fallback_baseline, 1),
            },
            "features_used": {
                "precipitation_mm": rainfall_mm,
                "temp_max_c": temp_max_c,
                "wind_max_kmh": wind_max_kmh,
                "is_weekend": int(is_weekend),
                "is_holiday": int(is_holiday),
                "event_attendance": event_attendance,
                "day_of_week": day.weekday(),
                "month_of_year": day.month,
                "day_of_month": day.day,
                "is_payday": 0,
                "rain_3d": scenario_rain_3d(rainfall_mm),
            },
            "factors": ["Model files missing; loaded robust statistical fallback heuristics for demo."],
            **resources,
            "fuel_consumption_liters": round(predicted_tons * 1.8, 1),
            "co2_emissions_kg": round(predicted_tons * 1.8 * 2.68, 1),
        }

    _, xgboost_model = models
    # Daily model: forecast the calendar day (midnight), same as the series path.
    from_date = pd.Timestamp(target_date or today()).normalize()

    # Prophet baseline prediction
    prophet_pred = _prophet_yhat(slug, (from_date.strftime("%Y-%m-%d"),))[0]

    # XGBoost residual correction — feature order must match ml/scripts/train_models.py
    feature_row = {
        "precipitation_mm": rainfall_mm,
        "temp_max_c": temp_max_c,
        "wind_max_kmh": wind_max_kmh,
        "is_weekend": int(is_weekend),
        "is_holiday": int(is_holiday),
        "event_attendance": event_attendance,
        "day_of_week": from_date.weekday(),
        "month_of_year": from_date.month,
        "day_of_month": from_date.day,
        "is_payday": int(from_date.day in (1, 2, 25, 26, 27, 28)),
        "rain_3d": scenario_rain_3d(rainfall_mm),
    }
    X_features = pd.DataFrame([feature_row])
    raw_residual = float(xgboost_model.predict(X_features)[0])
    # A constant-rain scenario: rain_3d = 3 x rain, so the rain line is (g, 3g).
    adjusted, rain_effect = _monotone_rain_residuals(
        xgboost_model, [feature_row], [0.0], float(RAIN_3D_WINDOW_DAYS)
    )
    residual_pred = float(adjusted[0])

    # Per-driver attribution: marginal tons lost when each dynamic driver is
    # zeroed (leave-one-out on the residual model). This is the visible proof
    # that weather/event/calendar data actually drives the forecast. Rain is
    # the monotone rain effect itself (see _monotone_rain_residuals).
    attribution: dict[str, float] = {"rainfall_tons": round(float(rain_effect[0]), 1)}
    for key, label in (
        ("event_attendance", "event_tons"),
        ("is_weekend", "weekend_tons"),
        ("is_holiday", "holiday_tons"),
    ):
        zeroed = dict(feature_row)
        zeroed[key] = 0
        marginal = raw_residual - float(xgboost_model.predict(pd.DataFrame([zeroed]))[0])
        attribution[label] = round(marginal, 1)
    attribution["prophet_baseline_tons"] = round(float(prophet_pred), 1)

    # The XGBoost residual was trained on calibrated-synthetic daily data where
    # the event_attendance feature carried negligible signal (coefficient ~0).
    # To make the hybrid respond to permitted events as the PRD specifies — and
    # to stay consistent with the permit-intake endpoint — apply the documented
    # per-capita event overlay (1.2 kg/person) on top of the model output.
    event_overlay = event_attendance * EVENT_WASTE_KG_PER_PERSON / 1000.0
    attribution["event_tons"] = round(event_overlay, 1)

    predicted_tons = max(0.0, round(float(prophet_pred) + float(residual_pred) + event_overlay, 1))

    factors: list[str] = []
    if rainfall_mm >= 30:
        factors.append(f"Heavy rainfall (+{round(residual_pred):.0f}t residual correction from XGBoost).")
    elif rainfall_mm >= 10:
        factors.append("Moderate rainfall contributing to wet-waste increase.")
    if event_attendance >= 50_000:
        factors.append(f"Major event ({event_attendance:,} attendees) spiking localized volume.")
    elif event_attendance >= 10_000:
        factors.append(f"Moderate event ({event_attendance:,} attendees) adding to baseline.")
    if is_weekend:
        factors.append("Weekend cycle activated (Prophet weekly seasonality).")
    if is_holiday:
        factors.append(
            "National holiday detected — reduced commercial waste, possible spike from public gatherings."
        )

    # Requirements calculations (canonical units, app.core.units)
    resources = resource_requirements(predicted_tons)

    # Honest uncertainty band: daily-district resolution is calibrated-synthetic,
    # so expose a wide interval and a suitability flag instead of a point claim.
    lo = round(predicted_tons * 0.75, 1)
    hi = round(predicted_tons * 1.25, 1)

    return {
        "kelurahan": kelurahan,
        "model_available": True,
        "prophet_baseline_tons": round(float(prophet_pred), 1),
        "xgboost_residual": round(float(residual_pred), 1),
        "predicted_tons": predicted_tons,
        "prediction_interval_p10_p90": [lo, hi],
        "daily_district_suitability": "not_supported_calibrated_synthetic",
        "factor_attribution": attribution,
        "features_used": dict(X_features.iloc[0]),
        "rain_response": rain_response_block(rainfall_mm),
        "factors": factors or ["Prophet baseline trend stable; no exceptional drivers."],
        **resources,
        "fuel_consumption_liters": round(predicted_tons * 1.8, 1),
        "co2_emissions_kg": round(predicted_tons * 1.8 * 2.68, 1),
    }


@lru_cache(maxsize=1)
def _holiday_dates() -> frozenset[str]:
    """Real 2026 Indonesian national holidays (api-hari-libur) as ISO dates.

    Dates outside 2026 simply miss the set and are treated as non-holidays —
    the series output labels this window explicitly.
    """
    import json as _json

    path = REAL_DIR / "hari_libur_indonesia_2026.json"
    if not path.exists():
        return frozenset()
    try:
        payload = _json.loads(path.read_text(encoding="utf-8"))
        return frozenset(str(e.get("date")) for e in payload.get("data", []) if e.get("date"))
    except (ValueError, OSError):
        return frozenset()


@lru_cache(maxsize=512)
def predict_waste_hybrid_series(
    kelurahan: str,
    days: int = 7,
    rainfall_mm: float | tuple[float, ...] = 0.0,
    temp_max_c: float | tuple[float, ...] = 31.0,
    wind_max_kmh: float | tuple[float, ...] = 10.0,
    event_attendance: int | tuple[int, ...] = 0,
    start_date: str | None = None,
    rain_3d: tuple[float, ...] | None = None,
) -> dict[str, Any]:
    """Multi-day forecast series for one kecamatan (Case 2 temporal mapping).

    Prophet is evaluated once over the whole date range (vectorized), XGBoost
    corrects each day with per-day drivers: real weekday/weekend cycle and the
    real 2026 holiday calendar vary per day. Weather and event inputs are either
    one value held constant across the horizon (a scenario) or a tuple with one
    value per day, so a forecast week or a one-day what-if moves only its own
    days. Per-day rain feeds `rain_3d` as the training's rolling 3-day sum, so a
    rainy day also carries into the next two days' rain_3d, as the model learned;
    an explicit per-day `rain_3d` overrides that sum (the twin passes one so a
    what-if's rain counts on its own day only). The rain effect is the monotone
    response of `_monotone_rain_residuals`. Event attendance adds the documented
    per-capita overlay, as in `predict_waste_hybrid`.
    """
    days = max(1, min(int(days), 30))
    slug = kelurahan.lower().replace(" ", "_")
    start = pd.Timestamp(start_date or today()).normalize()
    dates = [start + pd.Timedelta(days=i) for i in range(days)]
    holidays = _holiday_dates()
    weekend_flags = [bool(d.weekday() >= 5) for d in dates]
    holiday_flags = [d.strftime("%Y-%m-%d") in holidays for d in dates]
    per_day = any(isinstance(v, tuple) for v in (rainfall_mm, temp_max_c, wind_max_kmh, event_attendance))

    def daily(value: Any) -> list[Any]:
        if isinstance(value, tuple):
            if len(value) < days:
                raise ValueError(f"per-day input has {len(value)} values for {days} days")
            return list(value[:days])
        return [value] * days

    rain, temp, wind, attendance = (
        daily(v) for v in (rainfall_mm, temp_max_c, wind_max_kmh, event_attendance)
    )
    if rain_3d is not None:
        rain_3d_by_day = [float(v) for v in daily(tuple(rain_3d))]
        rain_3d_per_mm = 1.0
    elif isinstance(rainfall_mm, tuple):
        rain_3d_by_day = rolling_rain_3d(tuple(rain))
        rain_3d_per_mm = 1.0
    else:
        rain_3d_by_day = [scenario_rain_3d(r) for r in rain]
        rain_3d_per_mm = float(RAIN_3D_WINDOW_DAYS)
    # Rain of the earlier days inside each day's rain_3d (0 for a constant scenario).
    carried = [
        max(0.0, round(r3 - rain_3d_per_mm * r, 2)) for r3, r in zip(rain_3d_by_day, rain, strict=True)
    ]

    models = _load_hybrid(slug)
    if models is not None:
        _, xgboost_model = models
        yhat = np.array(_prophet_yhat(slug, tuple(d.strftime("%Y-%m-%d") for d in dates)))
        # Feature order must match ml/scripts/train_models.py.
        rows = [
            {
                "precipitation_mm": rain[i],
                "temp_max_c": temp[i],
                "wind_max_kmh": wind[i],
                "is_weekend": int(weekend_flags[i]),
                "is_holiday": int(holiday_flags[i]),
                "event_attendance": attendance[i],
                "day_of_week": d.weekday(),
                "month_of_year": d.month,
                "day_of_month": d.day,
                "is_payday": int(d.day in (1, 2, 25, 26, 27, 28)),
                "rain_3d": rain_3d_by_day[i],
            }
            for i, d in enumerate(dates)
        ]
        residuals, _effect = _monotone_rain_residuals(xgboost_model, rows, carried, rain_3d_per_mm)
        overlay = [a * EVENT_WASTE_KG_PER_PERSON / 1000.0 for a in attendance]
        model_available = True
    else:
        base = 150.0
        yhat = np.array([base] * days, dtype=float)
        residuals = np.array(
            [
                (r * 1.2) + (a * 0.003) + (base * 0.05 if w else 0.0)
                for r, a, w in zip(rain, attendance, weekend_flags, strict=True)
            ]
        )
        overlay = [0.0] * days
        model_available = False

    series = []
    for i, d in enumerate(dates):
        tons = max(0.0, round(float(yhat[i]) + float(residuals[i]) + overlay[i], 1))
        series.append(
            {
                "date": d.strftime("%Y-%m-%d"),
                "predicted_tons": tons,
                "is_weekend": weekend_flags[i],
                "is_holiday": holiday_flags[i],
                "rainfall_mm": float(rain[i]),
                "rain_3d_mm": float(rain_3d_by_day[i]),
                "event_attendance": int(attendance[i]),
            }
        )
    peak = max(series, key=lambda r: r["predicted_tons"])
    total = round(sum(r["predicted_tons"] for r in series), 1)
    return {
        "kelurahan": kelurahan,
        "model_available": model_available,
        "days": days,
        "series": series,
        "total_tons": total,
        "avg_daily_tons": round(total / days, 1),
        "peak_date": peak["date"],
        "peak_tons": peak["predicted_tons"],
        "inputs_per_day": per_day,
        "scenario_note": (
            "Weekday/weekend and the real 2026 holiday calendar vary per day; "
            + (
                "rainfall and event attendance are given per day (each row states its own inputs)."
                if per_day
                else "rainfall and event-attendance scenario inputs are held constant "
                "across the horizon (scenario, not observed weather)."
            )
        ),
    }


def list_hybrid_models() -> list[dict[str, Any]]:
    results = []
    for slug in _KELURAHAN_SLUGS:
        p_exists = (MODELS_DIR / f"prophet_{slug}.joblib").exists()
        x_exists = (MODELS_DIR / f"xgboost_{slug}.joblib").exists()
        results.append(
            {
                "kelurahan": slug.replace("_", " ").title(),
                "slug": slug,
                "prophet_available": p_exists,
                "xgboost_available": x_exists,
                "hybrid_available": p_exists and x_exists,
            }
        )
    return results


# ═════════════════════════════════════════════════════════════════════
# 3b. MONTHLY LANDFILL INTAKE (the forecast validated on real data)
# ═════════════════════════════════════════════════════════════════════


@lru_cache(maxsize=1)
def _monthly_calendar_model() -> dict[str, Any] | None:
    """monthly_calendar_model.json from ml/scripts/train_models.py, or None if absent."""
    if not MONTHLY_CALENDAR_MODEL.exists():
        return None
    try:
        return json.loads(MONTHLY_CALENDAR_MODEL.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        logging.getLogger(__name__).exception("monthly calendar model exists but failed to load")
        return None


def monthly_calendar_features(
    year: int,
    month: int,
    eid_dates: list[str],
    window: tuple[int, int] = (7, 7),
    ramadan_days: int = 30,
) -> tuple[float, float]:
    """(ramadan_fraction, mudik_fraction) of the month's days.

    Mudik = Idul Fitri -before..+after days; Ramadan = the `ramadan_days` before Idul Fitri,
    minus the mudik window. Mirrors train_models.month_calendar_features (parity-tested).
    """
    before, after = window
    eids = [pd.Timestamp(e) for e in eid_dates]
    n_days = calendar.monthrange(year, month)[1]
    ram = mud = 0
    for day in range(1, n_days + 1):
        d = pd.Timestamp(year, month, day)
        if any(e - pd.Timedelta(days=before) <= d <= e + pd.Timedelta(days=after) for e in eids):
            mud += 1
        if any(e - pd.Timedelta(days=ramadan_days) <= d < e - pd.Timedelta(days=before) for e in eids):
            ram += 1
    return ram / n_days, mud / n_days


def forecast_monthly_intake(months: int = 3, start_month: str | None = None) -> dict[str, Any]:
    """Bantargebang intake forecast in t/day per month (12-month level x calendar factor).

    Deterministic: months are counted from `start_month` (YYYY-MM), by default the month
    after the last observed month, never from the wall clock. Only horizons 1-3 months
    after the last observed month were backtested; later months are flagged.
    """
    base = {
        "classification": "MODEL OUTPUT",
        "validation": "rolling-origin backtest on real Bantargebang intake",
        "unit": "t/day",
        "daily_district_suitability": "not_supported_calibrated_synthetic",
    }
    model = _monthly_calendar_model()
    if model is None:
        return {**base, "available": False, "months": [], "reason": "monthly_calendar_model.json missing"}

    last = pd.Period(model["fitted_through"], freq="M")
    start = pd.Period(start_month, freq="M") if start_month else last + 1
    window = tuple(model["mudik_window_days"])
    eid_records = model["idul_fitri"]
    eid_dates = [r["date"] for r in eid_records]
    backtested = model["backtested_horizon_months"]
    out = []
    for i in range(max(1, min(int(months), 12))):
        p = start + i
        ram, mud = monthly_calendar_features(p.year, p.month, eid_dates, window, model["ramadan_days"])
        factor = exp(model["a_ramadan"] * ram + model["b_mudik"] * mud)
        horizon = (p - last).n
        # Idul Fitri dates whose Ramadan or mudik window touches this month.
        touching = [
            r
            for r in eid_records
            if monthly_calendar_features(p.year, p.month, [r["date"]], window, model["ramadan_days"])
            != (0.0, 0.0)
        ]
        out.append(
            {
                "month": str(p),
                "tons_per_day": round(exp(model["level_log"]) * factor, 1),
                "calendar_factor": round(factor, 4),
                "ramadan_fraction": round(ram, 4),
                "mudik_fraction": round(mud, 4),
                "horizon_months": horizon,
                "within_backtested_horizon": horizon in backtested,
                "idul_fitri_date_unverified": any(not r["verified"] for r in touching),
            }
        )
    return {
        **base,
        "available": True,
        "model": model["model"],
        "target": model["target"],
        "fitted_through": model["fitted_through"],
        "backtested_horizon_months": backtested,
        "months": out,
    }


# ═════════════════════════════════════════════════════════════════════
# 4. DISPATCH CENTER
# ═════════════════════════════════════════════════════════════════════


@dataclass
class DispatchCenter:
    _dispatches: list[dict[str, Any]] = field(default_factory=list)

    def create_dispatch(self, truck_code: str, instruction: str, manager_id: str) -> dict[str, Any]:
        dispatch = {
            "id": str(uuid4()),
            "truck_code": truck_code,
            "instruction": instruction,
            "manager_id": manager_id,
            "field_status": "PENDING",
            "confirmed_note": "",
            "created_at": datetime.now(UTC).isoformat(),
            "confirmed_at": None,
        }
        self._dispatches.append(dispatch)
        return dispatch

    def confirm(self, dispatch_id: str, status: str, note: str = "") -> dict[str, Any]:
        for dispatch in self._dispatches:
            if dispatch["id"] == dispatch_id:
                dispatch["field_status"] = status
                dispatch["confirmed_note"] = note
                dispatch["confirmed_at"] = datetime.now(UTC).isoformat()
                return dispatch
        raise KeyError(f"Dispatch {dispatch_id} was not found.")

    def pending_for_truck(self, truck_code: str) -> list[dict[str, Any]]:
        return [
            d for d in self._dispatches if d["truck_code"] == truck_code and d["field_status"] == "PENDING"
        ]

    def audit_log(self) -> list[dict[str, Any]]:
        return list(self._dispatches)
