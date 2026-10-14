"""Case 1 fleet supervision: command center, fleet state, routing, map truth, CV feed."""

from __future__ import annotations

import time
from datetime import date
from itertools import pairwise
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from app.ai.actions.auto_reroute import note_manual_override
from app.api.deps import require_permission
from app.api.routers.forecast import predictions_kecamatan
from app.api.state import (
    _command_center_cache,
    _command_center_lock,
    _map_truth_cache,
    _map_truth_lock,
    dispatch_center,
)
from app.fleet.astar_routing import is_traffic_jam_active, reroute_payload, set_traffic_jam_active
from app.fleet.cv_surveillance import surveillance_status
from app.fleet.data import (
    TRUCKS,
    command_center_snapshot,
    fleet_history_payload,
    tpa_queue_status_payload,
    unlicensed_collectors_payload,
)
from app.fleet.gps_feed import latest_breadcrumbs
from app.fleet.map_truth import _snapped_for, build_map_truth
from app.fleet.osrm import fetch_osrm_route
from app.forecast.engine import simulate_staggered_dispatch
from app.forecast.real_data import load_fleet_composition
from app.forecast.weather import fetch_jakarta_weather_forecast

router = APIRouter()


@router.get("/api/fleet/composition")
def fleet_composition() -> dict[str, Any]:
    """Real DKI waste-truck fleet census (Case 1 grounding)."""
    return load_fleet_composition()


@router.get("/api/command-center")
def command_center() -> dict:
    cached = _command_center_cache
    now = time.time()
    if cached["payload"] is None or now - cached["ts"] > 8.0:
        with _command_center_lock:
            now = time.time()
            if cached["payload"] is None or now - cached["ts"] > 8.0:
                dispatches = dispatch_center.audit_log()
                cached["payload"] = command_center_snapshot(
                    dispatches, weather=fetch_jakarta_weather_forecast()
                )
                cached["ts"] = time.time()
    return cached["payload"]


@router.get("/api/fleet")
def fleet() -> list[dict]:
    from app.fleet.data import get_dynamic_trucks

    return get_dynamic_trucks()


@router.get("/api/fleet/driver-analytics")
def fleet_driver_analytics() -> dict[str, Any]:
    """Current truck/driver assignments from the same cached snapshot as Fleet.

    Each row represents one truck assignment, not a historical trip or an
    individual driver's lifetime performance. Deviation is a current corridor
    observation, not a count of past incidents. Positions and driver identities
    in this pilot are simulated; the generated fleet's mix is grounded in the
    DKI truck census. No fuel efficiency, trip totals, or driver scores are
    available from this source.
    """
    snapshot = command_center()
    return {
        "sampled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_command_center_cache["ts"])),
        "source": "command-center.trucks",
        "provenance": {
            "id": (
                "Telemetri dan penugasan pengemudi disimulasikan; komposisi "
                "armada mengikuti sensus truk DKI 2023. Bukan GPS langsung "
                "atau ukuran kinerja pengemudi."
            ),
            "en": (
                "Simulated fleet telemetry and driver assignments; generated "
                "fleet composition is grounded in the DKI 2023 truck census. "
                "Not live GPS or measured driver performance."
            ),
        },
        "drivers": [
            {
                "truck_code": truck["truck_code"],
                "driver_name": truck["driver_name"],
                "assigned_zone": truck.get("assigned_zone"),
                "status": truck.get("status"),
                "is_damaged": bool(truck.get("is_damaged")),
                "deviation_violated": bool((truck.get("deviation") or {}).get("violated")),
                "deviation_meters": (truck.get("deviation") or {}).get("distance_meters"),
            }
            for truck in snapshot["trucks"]
        ],
    }


@router.get("/api/fleet/status-overview")
def fleet_status_overview() -> dict[str, Any]:
    """Case 1 'position AND activity' + fleet damage status: fleet-wide roll-up
    of operational activity states and maintenance condition."""
    from app.fleet.data import get_dynamic_trucks

    trucks = get_dynamic_trucks()
    by_activity: dict[str, int] = {}
    for t in trucks:
        state = t.get("activity", {}).get("state", "unknown")
        by_activity[state] = by_activity.get(state, 0) + 1
    damaged = [t for t in trucks if t.get("is_damaged")]
    return {
        "total_trucks": len(trucks),
        "by_activity": by_activity,
        "damaged_count": len(damaged),
        "damaged_trucks": [
            {
                "truck_code": t["truck_code"],
                "driver_name": t["driver_name"],
                "vehicle_type": t.get("vehicle_type"),
                "damage_status": t.get("damage_status"),
            }
            for t in damaged
        ],
        "activity_labels": {t["truck_code"]: t.get("activity") for t in trucks},
        "telemetry_class": "SIMULATED fleet telemetry on real census mix; not live AVL",
    }


@router.get("/api/routes/osrm")
def osrm_route() -> dict:
    return fetch_osrm_route(
        "Route B - Daan Mogot Recovery",
        origin=(-6.221, 106.785),
        destination=(-6.195, 106.802),
    )


@router.get("/api/fleet/history")
def fleet_history(
    truck_code: str | None = Query(None, description="Filter history by truck code"),
    date: str | None = Query(None, description="Filter history by date (YYYY-MM-DD)"),
) -> list[dict[str, Any]]:
    return fleet_history_payload(truck_code=truck_code, date=date)


@router.get("/api/fleet/carbon")
def fleet_carbon() -> dict[str, Any]:
    return {
        "co2_factor_kg_per_km": 0.95,
        "total_fleet_distance_km": 216.9,
        "total_co2_emitted_kg": round(216.9 * 0.95, 1),
        "carbon_saved_today_kg": 17.6,  # Saving achieved by route optimization on T-047 (Route B instead of deviant A)
        "fuel_saved_equivalent_liters": round(17.6 / 2.68, 1),
        "compliance_rate_percent": 80.0,
    }


@router.get("/api/fleet/astar-reroute")
def get_astar_reroute(truck_code: str = "T-047") -> dict[str, Any]:
    truck = next((t for t in TRUCKS if t["truck_code"] == truck_code), None)
    if truck is None:
        raise HTTPException(status_code=404, detail=f"Truck {truck_code} not found.")
    origin = None
    if truck.get("latest_position"):
        # Necessary: snapped (30s-cached) keeps reroute consistent with
        # map-truth and avoids a fresh OSRM connector fetch every call.
        origin = _snapped_for(truck)["snapped"]
    return reroute_payload(is_traffic_jam_active(), origin_position=origin)


@router.get("/api/fleet/route-alternatives")
def get_route_alternatives(
    truck_code: str = "T-047", permit_hour: int | None = Query(None, ge=0, le=23)
) -> dict[str, Any]:
    """Case 1: >=2 computed permit-compliant route alternatives with real OSRM
    ETAs. Route 1 is optimal; route 2 is penalty-diversified (recomputed, not
    canned). permit_hour applies the simulated truck-hour restriction windows."""
    from app.fleet.astar_routing import DEMO_CONGESTED_EDGES, build_gps_graph, find_alternative_routes

    truck = next((t for t in TRUCKS if t["truck_code"] == truck_code), None)
    if truck is None:
        raise HTTPException(status_code=404, detail=f"Truck {truck_code} not found.")
    jam = is_traffic_jam_active()
    congested = DEMO_CONGESTED_EDGES if jam else []
    if truck.get("latest_position"):
        origin = _snapped_for(truck)["snapped"]
        nodes, edges = build_gps_graph(origin)
        from app.fleet.astar_routing import find_astar_route

        routes = []
        first = find_astar_route(
            start="ORIGIN", nodes=nodes, edges=edges, congested_edges=congested, permit_hour=permit_hour
        )
        if first.get("success"):
            first["rank"] = 1
            first["diversified"] = False
            routes.append(first)
            diversified = list(congested) + list(pairwise(first["sequence"]))
            second = find_astar_route(
                start="ORIGIN", nodes=nodes, edges=edges, congested_edges=diversified, permit_hour=permit_hour
            )
            if second.get("success") and tuple(second["sequence"]) != tuple(first["sequence"]):
                second["rank"] = 2
                second["diversified"] = True
                routes.append(second)
    else:
        routes = find_alternative_routes(k=2, congested_edges=congested, permit_hour=permit_hour)
    return {
        "truck_code": truck_code,
        "jam_active": jam,
        "permit_hour": permit_hour,
        "route_count": len(routes),
        "routes": routes,
        "permit_source": "SIMULATED PERMIT CONSTRAINT (not official DLH permit dataset)",
    }


@router.get("/api/fleet/route-decision")
def route_decision(truck_code: str = "T-047") -> dict[str, Any]:
    """One payload unifying every Case-1 route signal for a truck: OSRM ETA/
    distance, vehicle damage status, TPA queue, traffic, and permit — so a
    dispatcher sees a single decision, not five disconnected panels."""
    truck = next((t for t in TRUCKS if t["truck_code"] == truck_code), None)
    if truck is None:
        raise HTTPException(status_code=404, detail=f"Truck {truck_code} not found.")
    origin = None
    if truck.get("latest_position"):
        # Necessary: snapped (30s-cached) keeps reroute consistent with
        # map-truth and avoids a fresh OSRM connector fetch every call.
        origin = _snapped_for(truck)["snapped"]
    jam_active = is_traffic_jam_active()
    route = reroute_payload(jam_active, origin_position=origin)
    active = route["active_route"]
    # Single queue source: same payload the TPA panel renders, so the decision
    # endpoint can no longer disagree with the panel (was 117 min vs 15 min).
    queue_payload = tpa_queue_status_payload(scenario="peak" if jam_active else "live")
    queue = {
        "mean_wait_minutes": queue_payload["avg_wait_minutes"],
        "p95_wait_minutes": queue_payload["p95_wait_minutes"],
    }
    vehicle_status = (
        "DAMAGED" if truck.get("is_damaged") else ("DEVIATION" if truck["deviation"]["violated"] else "OK")
    )
    recs = []
    if truck.get("is_damaged"):
        recs.append("Vehicle damaged — assign backup capacity.")
    if truck["deviation"]["violated"]:
        recs.append("Off assigned corridor — redirect to recommended route.")
    if jam_active:
        recs.append("Active-route congestion — A* diversion applied.")
    if queue["mean_wait_minutes"] > 45:
        recs.append("TPA queue high — stagger arrival.")
    return {
        "truck_code": truck_code,
        "eta_minutes": active["eta_minutes"],
        "physical_distance_km": active["physical_distance_km"],
        "optimization_cost": active["optimization_cost"],
        "vehicle_status": vehicle_status,
        "tpa_queue": {
            "wait_minutes": queue["mean_wait_minutes"],
            "p95": queue["p95_wait_minutes"],
            "source": "MODEL OUTPUT",
        },
        "traffic": {"jam_active": jam_active, "source": "SIMULATED CONGESTION"},
        "permit": {"source": active.get("permit_source", "SIMULATED PERMIT CONSTRAINT")},
        "recommendation": recs or ["Normal operation; no intervention needed."],
    }


@router.get("/api/fleet/map-truth")
def fleet_map_truth() -> dict[str, Any]:
    """Single geospatial-truth payload for every truck (frontend renders verbatim)."""
    cached = _map_truth_cache
    now = time.time()
    if cached["payload"] is None or now - cached["ts"] > 15.0:
        with _map_truth_lock:
            now = time.time()
            if cached["payload"] is None or now - cached["ts"] > 15.0:
                cached["payload"] = {"trucks": [build_map_truth(t) for t in TRUCKS]}
                cached["ts"] = time.time()
    return cached["payload"]


@router.get("/api/fleet/unlicensed-collectors")
def unlicensed_collectors() -> dict[str, Any]:
    return unlicensed_collectors_payload()


@router.get("/api/cv/surveillance-feed")
def cv_surveillance_feed() -> dict[str, Any]:
    """Computer-vision gate feed (Case 1): plate reads verified against the DLH
    whitelist. Simulated feed from a demo clip, pilot-ready ANPR contract."""
    return surveillance_status()


@router.get("/api/fleet/{truck_code}/breadcrumbs")
def fleet_breadcrumbs(truck_code: str) -> dict[str, Any]:
    """Timestamped GPS trail for a truck (simulated feed, pilot-ready contract)."""
    trail = latest_breadcrumbs(truck_code)
    return {
        "truck_code": truck_code,
        "source": "simulated",
        "note": "Simulated breadcrumb feed; swap to DLH AVL at pilot with no contract change.",
        "breadcrumbs": [
            {
                "lat": b.lat,
                "lng": b.lng,
                "timestamp": b.timestamp,
                "speed_kmh": b.speed_kmh,
                "source": b.source,
            }
            for b in trail
        ],
    }


@router.post("/api/fleet/astar-simulate-jam")
def post_astar_simulate_jam(
    active: bool, _role: str = Depends(require_permission("operations:plan"))
) -> dict[str, Any]:
    set_traffic_jam_active(active)
    note_manual_override()
    # Necessary: the toggled jam state feeds map-truth (jam_active, abandoned
    # route), so any cached payload would report stale state to clients — the
    # jam-toggle e2e reads map-truth right after POSTing the toggle.
    _map_truth_cache["ts"] = 0.0
    return {
        "status": "success",
        "traffic_jam_active": is_traffic_jam_active(),
        "message": "Traffic jam state toggled successfully.",
    }


@router.get("/api/fleet/summary")
def get_fleet_executive_report() -> JSONResponse:
    """
    Export operational executive summary formatted in Markdown for DLH managers.
    """
    today_str = date.today().strftime("%d %B %Y")

    # Case 2 numbers computed live from the 42-kecamatan hybrid model under a
    # heavy-rain weekend scenario, so the report matches the actual model output.
    scenario_kecs = predictions_kecamatan(
        rainfall_mm=42.0,
        event_attendance=0,
        is_weekend=True,
        is_holiday=False,
    )
    baseline_kecs = predictions_kecamatan(
        rainfall_mm=0.0,
        event_attendance=0,
        is_weekend=False,
        is_holiday=False,
    )
    top = scenario_kecs["top_hotspots"][0]
    base_lookup = {k["slug"]: k["predicted_tons"] for k in baseline_kecs["kecamatan"]}
    top_base = base_lookup.get(top["slug"], top["predicted_tons"])
    spike_pct = round((top["predicted_tons"] - top_base) / top_base * 100, 1) if top_base else 0.0
    extra_crews = sum(k["crews_required"] for k in scenario_kecs["top_hotspots"])
    extra_workers = sum(k["workers_required"] for k in scenario_kecs["top_hotspots"])
    extra_manhours = sum(k["man_hours_required"] for k in scenario_kecs["top_hotspots"])
    extra_trucks = sum(k["trucks_required"] for k in scenario_kecs["top_hotspots"])
    extra_bins = sum(k["bins_required"] for k in scenario_kecs["top_hotspots"])

    stagger = simulate_staggered_dispatch(32)

    report = f"""# LAPORAN EKSEKUTIF Pythia
Tanggal Cetak: {today_str}
Sistem: Pythia

## 1. PENILAIAN DAMPAK OPERASIONAL (CASE 1)
Sistem optimalisasi logistik Pythia meningkatkan efisiensi armada (angka dari simulasi discrete-event, bukan estimasi tetap):
- **Reduksi Waktu Antri TPA (simulasi):** waktu tunggu puncak turun **{stagger["queue_reduction_percent"]}%** (dari {stagger["baseline_wait_minutes"]} menjadi {stagger["optimized_wait_minutes"]} menit) via Staggered Dispatch. Sumber: simulasi antrian ter-seed, bukan pengukuran lapangan.
- **Faktor Emisi (referensi):** estimasi bahan bakar 1.8 L/ton adalah faktor rujukan teknik, bukan penghematan terukur. Penghematan nyata butuh pilot lapangan.
- **Kepatuhan Koridor Rute:** deteksi deviasi berbasis point-to-polyline (T-047 terdeteksi menyimpang 2.373 m).

## 2. PREDIKSI VOLUME & KEBUTUHAN SUMBER DAYA (CASE 2)
Hasil prediksi spasial-temporal model Hybrid Prophet + XGBoost untuk {scenario_kecs["kecamatan_count"]} kecamatan Jakarta (skenario hujan ekstrim 42mm + akhir pekan):
- **Puncak Prediksi Volume:** Kecamatan {top["kecamatan"]} ({top["city"]}) diproyeksikan mengalami volume sampah tertinggi sebesar **{top["predicted_tons"]:.1f} ton/hari** (**+{spike_pct}%** vs kondisi normal).
- **Total Volume Kota:** Estimasi total {scenario_kecs["kecamatan_count"]} kecamatan mencapai **{scenario_kecs["total_predicted_tons"]:.1f} ton/hari** pada skenario ini.
- **Kebutuhan Manpower (5 hotspot teratas):** Dibutuhkan **{extra_crews} tim kru** (**{extra_workers} orang**) dengan alokasi total **{extra_manhours} person-hours**.
- **Kesiapan Armada & Fasilitas (5 hotspot teratas):** Merekomendasikan pengerahan **{extra_trucks} unit armada** dan penempatan **{extra_bins} unit tempat penampungan sampah besar**.

## 3. REKOMENDASI MANAJEMEN SEGERA
1. Aktifkan penundaan staggered keberangkatan truk non-darurat sebesar 15 menit.
2. Kirim notifikasi alert penyesuaian rute otomatis ke sopir truk B 5678 EF (T-047) via integrasi WhatsApp Gateway.
3. Siagakan tim sapu bersih cadangan di Kelurahan Kebon Jeruk dan Tebet.
"""
    return JSONResponse({"report": report})
