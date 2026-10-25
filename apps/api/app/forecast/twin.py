"""Pythia Twin: the scene the 3D digital twin draws.

Pure assembly — callers pass in forecasts, fleet and facility payloads and get
one JSON scene back. Every layer carries its provenance so the twin can never
present modelled or simulated data as live observations.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from app.core.paths import DISTRICT_OUTLINES
from app.core.units import (
    CREW_SIZE_WORKERS,
    EVENT_WASTE_KG_PER_PERSON,
    TRUCK_CAPACITY_TONS,
    resource_requirements,
)
from app.fleet.queue_simulation import WEIGHBRIDGE_LANES
from app.forecast.cities import VENUES, City
from app.forecast.engine import (
    AT_RISK_LEVELS,
    NORMAL_DAY_BASIS,
    RISK_CRITICAL_RATIO,
    RISK_ELEVATED_RATIO,
    RISK_HIGH_RATIO,
    distance_point_to_polyline_m,
    predict_waste_hybrid_series,
    spike_risk,
)
from app.forecast.real_data import load_kecamatan_map

# Risk = spike against the district's own normal day (engine.spike_risk, the one
# definition Fleet uses too). Kept here under their old names for callers.
CRITICAL_RATIO = RISK_CRITICAL_RATIO
HIGH_RATIO = RISK_HIGH_RATIO
ELEVATED_RATIO = RISK_ELEVATED_RATIO

# An event's crowd waste lands in the kecamatan whose outline holds the venue and
# in every kecamatan whose boundary lies within this distance of it (REAL
# boundaries), shared equally. A planning assumption, stated in the payload.
EVENT_REACH_RADIUS_M = 1000.0
EVENT_REACH_BASIS = (
    f"assumption: {EVENT_WASTE_KG_PER_PERSON:g} kg per attendee, shared equally by the kecamatan whose "
    f"real boundary holds the venue or lies within {EVENT_REACH_RADIUS_M / 1000:g} km of it"
)
# What the district tonnes are, so they are never read as landfill intake.
GENERATED_WASTE_QUANTITY = {
    "id": "waste_generated",
    "label": "Waste generated (timbulan) per kecamatan per day, model output over the SILIKA DLH 2023 baseline",
    "not": "landfill intake: the tonnage weighed in at TPST Bantargebang is a different quantity",
}

# The decision room's weekly briefing (gsc wave 10): at most three what-ifs, each one
# the forecast and queue models really compute. Twin, the XR table and Rencana read
# them by id, so all three show one scenario with one set of numbers.
BRIEFING_SCENARIOS: dict[str, dict[str, Any]] = {
    "heavy_rain": {
        "rainfall_mm": 50.0,
        "event_attendance": 0,
        "venue": None,
        "weighbridge_lanes": None,
        "basis": "50 mm of rain on the day (BMKG 'hujan lebat' starts at 50 mm/day), within the training range",
    },
    "gbk_event": {
        "rainfall_mm": 0.0,
        "event_attendance": 50_000,
        "venue": "gbk",
        "weighbridge_lanes": None,
        "basis": f"50,000 visitors at GBK; {EVENT_REACH_BASIS}",
    },
    # Same forecast day, one weighbridge lane closed: tonnes and trucks are today's,
    # only the simulated queue changes (queue_simulation `lanes`), as an assumption.
    "weighbridge_lane_down": {
        "rainfall_mm": 0.0,
        "event_attendance": 0,
        "venue": None,
        "weighbridge_lanes": WEIGHBRIDGE_LANES - 1,
        "basis": (
            f"assumption: 1 of {WEIGHBRIDGE_LANES} Bantargebang weighbridge lanes closed for the day "
            "(e.g. maintenance); not a reported closure"
        ),
    },
}


def briefing_scenario(scenario_id: str) -> dict[str, Any]:
    """One briefing scenario with its event coordinates resolved (KeyError when unknown)."""
    spec = BRIEFING_SCENARIOS[scenario_id]
    venue = next((v for v in VENUES["jakarta"] if v.id == spec["venue"]), None)
    return {
        "id": scenario_id,
        **spec,
        "event_lat": venue.lat if venue else None,
        "event_lng": venue.lng if venue else None,
        "classification": "MODEL_OUTPUT" if spec["weighbridge_lanes"] is None else "SIMULATED",
    }


PROVENANCE = {
    "jakarta": {
        "districts": {
            "class": "MODEL_OUTPUT",
            "source": "Prophet + XGBoost per kecamatan, SILIKA DLH 2023 baseline",
        },
        "boundaries": {
            "class": "REAL",
            "source": "Kelurahan boundaries (pararawendy/border-indonesia-geojson, 2020), dissolved by kecamatan",
        },
        "tps": {"class": "REAL", "source": "SILIKA DLH — 1,081 TPS with coordinates"},
        "facilities": {"class": "REAL", "source": "OpenStreetMap (ODbL), verified centroids"},
        "trucks": {"class": "SIMULATED", "source": "Pilot fleet telemetry is simulated, not live GPS"},
        "landfill_queue": {
            "class": "SIMULATED",
            "source": "Seeded discrete-event queue simulation at TPST Bantargebang",
        },
    },
    "hcmc": {
        "districts": {
            "class": "SIMULATED_DEMO_CITY",
            "source": (
                "Citywide ~13,000 t/day allocated by 2019 census population; "
                "scenario uplifts are assumptions, no trained model"
            ),
        },
        "tps": {"class": "UNAVAILABLE", "source": "No public collection-point dataset loaded"},
        "facilities": {"class": "APPROXIMATE", "source": "Da Phuoc landfill, approximate centroid"},
        "trucks": {"class": "UNAVAILABLE", "source": "No fleet connected in the demo city"},
        "landfill_queue": {"class": "UNAVAILABLE", "source": "No weighbridge feed in the demo city"},
    },
}


def classify_risk(tons: float, normal_tons: float | None) -> str:
    return spike_risk(tons, normal_tons)[1]


@lru_cache(maxsize=1)
def kecamatan_outlines() -> dict[str, list[list[float]]]:
    """Closed outer ring ([lng, lat] pairs) per kecamatan slug; empty when the asset is missing."""
    try:
        return json.loads(DISTRICT_OUTLINES.read_text(encoding="utf-8"))["outlines"]
    except (OSError, ValueError, KeyError):
        return {}


def jakarta_districts(kecamatan_payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Map /api/predictions/kecamatan (with horizon) onto twin districts."""
    generated_for = kecamatan_payload.get("generated_for")
    targeted = set(kecamatan_payload.get("scenario", {}).get("targeted_kecamatan") or [])
    outlines = kecamatan_outlines()
    out = []
    for feature in kecamatan_payload.get("kecamatan", []):
        if feature.get("lat") is None or feature.get("lng") is None:
            continue
        series = feature.get("daily_series") or [
            {"date": generated_for, "predicted_tons": feature["predicted_tons"]}
        ]
        out.append(
            {
                "id": feature["slug"],
                "name": feature["kecamatan"].title(),
                "admin_area": feature.get("city"),
                "lat": feature["lat"],
                "lng": feature["lng"],
                "baseline_tons": feature.get("baseline_tons_per_day"),
                "series": [{"date": row["date"], "predicted_tons": row["predicted_tons"]} for row in series],
                "interval_p10_p90": feature.get("prediction_interval_p10_p90"),
                "capacity_tons": feature.get("tps_capacity_ton_per_day"),
                "facility_readiness": feature.get("facility_readiness"),
                "model_available": feature.get("model_available"),
                "event_localized": feature["slug"] in targeted,
                # Drawn boundary (REAL geography), outer ring of the largest part; None if unknown.
                "outline": outlines.get(feature["slug"]),
            }
        )
    return out


def _ring_contains(ring: list[list[float]], lat: float, lng: float) -> bool:
    """Even-odd test of a point against a closed [lng, lat] ring."""
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1], strict=True):
        if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def event_reach(lat: float, lng: float) -> list[str]:
    """Kecamatan slugs an event at (lat, lng) reaches, host district first.

    Geography, not a list: the kecamatan whose real outline holds the venue, then
    every kecamatan whose boundary lies within EVENT_REACH_RADIUS_M of it, nearest
    first. A kecamatan without an outline is measured by its centroid; when
    nothing is reached (a venue outside the city), the nearest centroid takes it.
    """
    outlines = kecamatan_outlines()
    reached: list[tuple[float, str]] = []
    nearest: tuple[float, str] | None = None
    for k in load_kecamatan_map():
        if k.get("lat") is None or k.get("lng") is None:
            continue
        centroid = distance_point_to_polyline_m((lat, lng), [(k["lat"], k["lng"])])
        ring = outlines.get(k["slug"])
        if ring and _ring_contains(ring, lat, lng):
            distance = 0.0
        elif ring:
            distance = distance_point_to_polyline_m((lat, lng), [(p[1], p[0]) for p in ring])
        else:
            distance = centroid
        if nearest is None or centroid < nearest[0]:
            nearest = (centroid, k["slug"])
        if distance <= EVENT_REACH_RADIUS_M:
            reached.append((distance, k["slug"]))
    if not reached and nearest:
        reached.append(nearest)
    return [slug for _distance, slug in sorted(reached)]


def event_attendance_by_district(attendance: int, lat: float, lng: float) -> dict[str, int]:
    """The crowd shared equally by the reached kecamatan (the host takes the remainder)."""
    slugs = event_reach(lat, lng) if attendance > 0 else []
    if not slugs:
        return {}
    share, remainder = divmod(int(attendance), len(slugs))
    return {slug: share + (remainder if i == 0 else 0) for i, slug in enumerate(slugs)}


def event_block(
    attendance: int, lat: float | None, lng: float | None, day: int, date: str | None
) -> dict[str, Any] | None:
    """Where a scenario's event sits and what it reaches; None without an event."""
    if attendance <= 0 or lat is None or lng is None:
        return None
    by_district = event_attendance_by_district(attendance, lat, lng)
    return {
        "lat": lat,
        "lng": lng,
        "radius_m": EVENT_REACH_RADIUS_M,
        "day": day,
        "date": date,
        "attendance": attendance,
        "districts": list(by_district),
        "attendance_by_district": by_district,
        "tons_total": round(attendance * EVENT_WASTE_KG_PER_PERSON / 1000.0, 1),
        "basis": EVENT_REACH_BASIS,
    }


def jakarta_week(
    days: int,
    *,
    rain: tuple[float, ...],
    temp: float | tuple[float, ...] = 31.0,
    wind: float | tuple[float, ...] = 10.0,
    events: dict[str, tuple[int, ...]] | None = None,
    start: str | None = None,
    rain_3d: tuple[float, ...] | None = None,
) -> list[dict[str, Any]]:
    """Twin districts for Jakarta from per-day inputs (one value per horizon day).

    `events` maps a kecamatan slug to its per-day attendance. The normal day is
    this same call with dry rain and no events. Rows carry the inputs they used.
    `rain_3d` (per day) overrides the rolling 3-day rain sum (see the engine).
    """
    events = events or {}
    no_event = (0,) * days
    outlines = kecamatan_outlines()
    out = []
    for k in load_kecamatan_map():
        if k.get("lat") is None or k.get("lng") is None:
            continue
        attendance = events.get(k["slug"], no_event)
        result = predict_waste_hybrid_series(
            k["slug"],
            days=days,
            rainfall_mm=rain,
            temp_max_c=temp,
            wind_max_kmh=wind,
            event_attendance=attendance,
            start_date=start,
            rain_3d=rain_3d,
        )
        today = result["series"][0]["predicted_tons"]
        spread = (0.75, 1.25) if result["model_available"] else (0.6, 1.4)
        out.append(
            {
                "id": k["slug"],
                "name": k["kecamatan"].title(),
                "admin_area": k.get("city"),
                "lat": k["lat"],
                "lng": k["lng"],
                "baseline_tons": k.get("baseline_tons_per_day"),
                "series": [
                    {
                        "date": row["date"],
                        "predicted_tons": row["predicted_tons"],
                        "rainfall_mm": row["rainfall_mm"],
                        "event_attendance": row["event_attendance"],
                    }
                    for row in result["series"]
                ],
                "interval_p10_p90": [round(today * spread[0], 1), round(today * spread[1], 1)],
                "capacity_tons": k.get("tps_capacity_ton_per_day"),
                "facility_readiness": k.get("facility_readiness"),
                "model_available": result["model_available"],
                "event_localized": any(attendance),
                "outline": outlines.get(k["slug"]),
            }
        )
    return out


def _with_risk(district: dict[str, Any], normal_series: list[float] | None) -> dict[str, Any]:
    series = []
    for i, row in enumerate(district["series"]):
        normal = normal_series[i] if normal_series else row["predicted_tons"]
        resources = resource_requirements(row["predicted_tons"])
        spike_percent, risk = spike_risk(row["predicted_tons"], normal)
        series.append(
            {
                **row,
                "normal_tons": normal,
                "spike_percent": spike_percent,
                "risk": risk,
                "trucks_required": resources["trucks_required"],
                "crews_required": resources["crews_required"],
            }
        )
    peak = max(series, key=lambda row: row["predicted_tons"])
    return {
        **district,
        "series": series,
        "today_tons": series[0]["predicted_tons"],
        "risk": series[0]["risk"],
        "peak_date": peak["date"],
        "peak_tons": peak["predicted_tons"],
    }


def truck_layer(trucks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for truck in trucks:
        position = truck.get("latest_position") or {}
        if position.get("lat") is None:
            continue
        out.append(
            {
                "code": truck["truck_code"],
                "lat": position["lat"],
                "lng": position["lng"],
                "speed_kmh": position.get("speed_kmh"),
                "status": truck.get("status"),
                "deviated": bool((truck.get("deviation") or {}).get("violated")),
                "damaged": bool(truck.get("is_damaged")),
                "path": [[p["lng"], p["lat"]] for p in truck.get("actual_path") or []],
            }
        )
    return out


def flow_layer(
    districts: list[dict[str, Any]], destination: dict[str, Any] | None, day: int = 0
) -> list[dict[str, Any]]:
    """The selected day's haul from each district to the landfill (arc width ∝ tonnes).

    `tons` is day `day` of the horizon; `tons_by_day` holds every day, so a
    client stepping through the horizon can redraw without a refetch.
    """
    if destination is None:
        return []
    flows = []
    for d in districts:
        by_day = [row["predicted_tons"] for row in d["series"]]
        index = min(day, len(by_day) - 1) if by_day else 0
        flows.append(
            {
                "from": [d["lng"], d["lat"]],
                "to": [destination["lng"], destination["lat"]],
                "district": d["id"],
                "tons": by_day[index] if by_day else d["today_tons"],
                "day": index,
                "tons_by_day": by_day,
            }
        )
    return flows


def build_scene(
    city: City,
    districts: list[dict[str, Any]],
    *,
    scenario: dict[str, Any],
    facilities: list[dict[str, Any]],
    normal_days: list[dict[str, Any]] | None = None,
    trucks: list[dict[str, Any]] | None = None,
    tps: list[dict[str, Any]] | None = None,
    landfill_queue: dict[str, Any] | None = None,
    weather: dict[str, Any] | None = None,
    landfill_intake: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`normal_days` is the same district list forecast without rain or event.

    `weather` says which rain each day used (forecast, scenario or assumed dry);
    `landfill_intake` is the validated monthly intake level, a different quantity
    from the generated tonnes the districts carry.
    """
    normal = {d["id"]: [row["predicted_tons"] for row in d["series"]] for d in normal_days or []}
    districts = [_with_risk(d, normal.get(d["id"])) for d in districts]
    dates = [row["date"] for row in districts[0]["series"]] if districts else []
    daily_totals = [
        round(sum(d["series"][i]["predicted_tons"] for d in districts), 1) for i in range(len(dates))
    ]
    daily_trucks = [sum(d["series"][i]["trucks_required"] for d in districts) for i in range(len(dates))]
    daily_crews = [sum(d["series"][i]["crews_required"] for d in districts) for i in range(len(dates))]
    daily_at_risk = [
        sum(1 for d in districts if d["series"][i]["risk"] in AT_RISK_LEVELS) for i in range(len(dates))
    ]
    peak_index = max(range(len(dates)), key=daily_totals.__getitem__) if dates else 0
    landfill = next((f for f in facilities if f.get("kind") == "landfill"), None)
    return {
        "city": asdict(city),
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "horizon": {
            "days": len(dates),
            "dates": dates,
            "daily_total_tons": daily_totals,
            "daily_trucks_required": daily_trucks,
            "daily_crews_required": daily_crews,
            "daily_districts_at_risk": daily_at_risk,
        },
        "scenario": scenario,
        "summary": {
            "total_tons_today": daily_totals[0] if daily_totals else 0.0,
            "peak_date": dates[peak_index] if dates else None,
            "peak_total_tons": daily_totals[peak_index] if daily_totals else 0.0,
            "districts_at_risk": daily_at_risk[0] if daily_at_risk else 0,
            "trucks_required_today": daily_trucks[0] if daily_trucks else 0,
            "crews_required_today": daily_crews[0] if daily_crews else 0,
            # Crews equal trucks by design (one crew team per truck per shift);
            # the size lets the UI say so with the canonical unit, not a hardcoded 4.
            "crew_size_workers": CREW_SIZE_WORKERS,
            # What the tonnes above measure (generated waste, not landfill intake).
            "tons_quantity": GENERATED_WASTE_QUANTITY["id"],
            "risk_basis": f"forecast vs the normal day ({NORMAL_DAY_BASIS})",
        },
        "quantities": {
            "district_tons": GENERATED_WASTE_QUANTITY,
            "landfill_intake_reference": landfill_intake,
        },
        "weather": weather,
        "districts": districts,
        "facilities": facilities,
        "tps": tps or [],
        "trucks": truck_layer(trucks or []),
        "flows": flow_layer(districts, landfill, int(scenario.get("day") or 0)),
        "landfill_queue": landfill_queue,
        "venues": [asdict(venue) for venue in VENUES.get(city.id, ())],
        "provenance": PROVENANCE[city.id],
        "units": {
            "tons": "metric tonnes per day",
            "trucks_required": f"trucks at {TRUCK_CAPACITY_TONS:g} t per shift",
            "crews_required": f"crew teams of {CREW_SIZE_WORKERS} workers, 1 team per truck per shift",
        },
    }
