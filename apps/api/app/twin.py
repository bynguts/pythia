"""Pythia Twin: the scene the 3D digital twin draws.

Pure assembly — callers pass in forecasts, fleet and facility payloads and get
one JSON scene back. Every layer carries its provenance so the twin can never
present modelled or simulated data as live observations.
"""
from __future__ import annotations

import math
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from app.cities import City
from app.units import TRUCK_CAPACITY_TONS

# Risk = spike against the district's own normal day: the same model, same date,
# no rain and no event. (The TPS capacity column is a proxy that 40 of 42
# kecamatan already exceed, so it cannot drive a daily alarm.)
CRITICAL_RATIO = 1.25
HIGH_RATIO = 1.10
ELEVATED_RATIO = 1.03

PROVENANCE = {
    "jakarta": {
        "districts": {"class": "MODEL_OUTPUT",
                      "source": "Prophet + XGBoost per kecamatan, SILIKA DLH 2023 baseline"},
        "tps": {"class": "REAL", "source": "SILIKA DLH — 1,081 TPS with coordinates"},
        "facilities": {"class": "REAL", "source": "OpenStreetMap (ODbL), verified centroids"},
        "trucks": {"class": "SIMULATED", "source": "Pilot fleet telemetry is simulated, not live GPS"},
        "landfill_queue": {"class": "SIMULATED",
                           "source": "Seeded discrete-event queue simulation at TPST Bantargebang"},
    },
    "hcmc": {
        "districts": {"class": "SIMULATED_DEMO_CITY",
                      "source": ("Citywide ~13,000 t/day allocated by 2019 census population; "
                                 "scenario uplifts are assumptions, no trained model")},
        "tps": {"class": "UNAVAILABLE", "source": "No public collection-point dataset loaded"},
        "facilities": {"class": "APPROXIMATE", "source": "Da Phuoc landfill, approximate centroid"},
        "trucks": {"class": "UNAVAILABLE", "source": "No fleet connected in the demo city"},
        "landfill_queue": {"class": "UNAVAILABLE", "source": "No weighbridge feed in the demo city"},
    },
}


def classify_risk(tons: float, normal_tons: float | None) -> str:
    ratio = tons / normal_tons if normal_tons else 1.0
    if ratio >= CRITICAL_RATIO:
        return "critical"
    if ratio >= HIGH_RATIO:
        return "high"
    if ratio >= ELEVATED_RATIO:
        return "elevated"
    return "normal"


def jakarta_districts(kecamatan_payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Map /api/predictions/kecamatan (with horizon) onto twin districts."""
    generated_for = kecamatan_payload.get("generated_for")
    targeted = set(kecamatan_payload.get("scenario", {}).get("targeted_kecamatan") or [])
    out = []
    for feature in kecamatan_payload.get("kecamatan", []):
        if feature.get("lat") is None or feature.get("lng") is None:
            continue
        series = feature.get("daily_series") or [
            {"date": generated_for, "predicted_tons": feature["predicted_tons"]}]
        out.append({
            "id": feature["slug"],
            "name": feature["kecamatan"].title(),
            "admin_area": feature.get("city"),
            "lat": feature["lat"],
            "lng": feature["lng"],
            "baseline_tons": feature.get("baseline_tons_per_day"),
            "series": [{"date": row["date"], "predicted_tons": row["predicted_tons"]}
                       for row in series],
            "interval_p10_p90": feature.get("prediction_interval_p10_p90"),
            "capacity_tons": feature.get("tps_capacity_ton_per_day"),
            "facility_readiness": feature.get("facility_readiness"),
            "model_available": feature.get("model_available"),
            "event_localized": feature["slug"] in targeted,
        })
    return out


def _with_risk(district: dict[str, Any], normal_series: list[float] | None) -> dict[str, Any]:
    series = []
    for i, row in enumerate(district["series"]):
        normal = normal_series[i] if normal_series else row["predicted_tons"]
        series.append({**row, "normal_tons": normal,
                       "risk": classify_risk(row["predicted_tons"], normal),
                       "trucks_required": math.ceil(row["predicted_tons"] / TRUCK_CAPACITY_TONS)})
    peak = max(series, key=lambda row: row["predicted_tons"])
    return {**district, "series": series, "today_tons": series[0]["predicted_tons"],
            "risk": series[0]["risk"], "peak_date": peak["date"], "peak_tons": peak["predicted_tons"]}


def truck_layer(trucks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for truck in trucks:
        position = truck.get("latest_position") or {}
        if position.get("lat") is None:
            continue
        out.append({
            "code": truck["truck_code"],
            "lat": position["lat"],
            "lng": position["lng"],
            "speed_kmh": position.get("speed_kmh"),
            "status": truck.get("status"),
            "deviated": bool((truck.get("deviation") or {}).get("violated")),
            "damaged": bool(truck.get("is_damaged")),
            "path": [[p["lng"], p["lat"]] for p in truck.get("actual_path") or []],
        })
    return out


def flow_layer(districts: list[dict[str, Any]], destination: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Today's haul from each district to the landfill (arc width ∝ tonnes)."""
    if destination is None:
        return []
    return [{"from": [d["lng"], d["lat"]], "to": [destination["lng"], destination["lat"]],
             "district": d["id"], "tons": d["today_tons"]} for d in districts]


def build_scene(city: City, districts: list[dict[str, Any]], *, scenario: dict[str, Any],
                facilities: list[dict[str, Any]], normal_days: list[dict[str, Any]] | None = None,
                trucks: list[dict[str, Any]] | None = None,
                tps: list[dict[str, Any]] | None = None,
                landfill_queue: dict[str, Any] | None = None) -> dict[str, Any]:
    """`normal_days` is the same district list forecast without rain or event."""
    normal = {d["id"]: [row["predicted_tons"] for row in d["series"]] for d in normal_days or []}
    districts = [_with_risk(d, normal.get(d["id"])) for d in districts]
    dates = [row["date"] for row in districts[0]["series"]] if districts else []
    daily_totals = [round(sum(d["series"][i]["predicted_tons"] for d in districts), 1)
                    for i in range(len(dates))]
    peak_index = max(range(len(dates)), key=daily_totals.__getitem__) if dates else 0
    landfill = next((f for f in facilities if f.get("kind") == "landfill"), None)
    return {
        "city": asdict(city),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "horizon": {"days": len(dates), "dates": dates, "daily_total_tons": daily_totals},
        "scenario": scenario,
        "summary": {
            "total_tons_today": daily_totals[0] if daily_totals else 0.0,
            "peak_date": dates[peak_index] if dates else None,
            "peak_total_tons": daily_totals[peak_index] if daily_totals else 0.0,
            "districts_at_risk": sum(1 for d in districts if d["risk"] in ("high", "critical")),
            "trucks_required_today": sum(d["series"][0]["trucks_required"] for d in districts),
        },
        "districts": districts,
        "facilities": facilities,
        "tps": tps or [],
        "trucks": truck_layer(trucks or []),
        "flows": flow_layer(districts, landfill),
        "landfill_queue": landfill_queue,
        "provenance": PROVENANCE[city.id],
        "units": {"tons": "metric tonnes per day",
                  "trucks_required": f"trucks at {TRUCK_CAPACITY_TONS:g} t per shift"},
    }
