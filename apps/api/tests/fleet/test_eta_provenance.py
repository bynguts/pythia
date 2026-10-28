"""Every ETA carries `eta_source` / `eta_label`; offline, the network is monkeypatched."""

import json

import pytest

from app.ai.actions.auto_reroute import AutoRerouter
from app.ai.actions.auto_state import EventFeed
from app.ai.detectors.speed_anomaly import SpeedAnomalyDetector
from app.fleet import astar_routing, data, map_truth, osrm
from app.fleet.gps_feed import GpsBreadcrumb

A = (-6.2, 106.8)
B = (-6.3, 106.9)
PAYLOAD = {
    "code": "Ok",
    "routes": [
        {"duration": 1800, "distance": 20000, "geometry": {"coordinates": [[106.8, -6.2], [106.9, -6.3]]}}
    ],
}


class _Response:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _osrm_up(monkeypatch):
    monkeypatch.setattr(osrm, "urlopen", lambda *a, **k: _Response(PAYLOAD))


def _osrm_down(monkeypatch):
    def boom(*a, **k):
        raise OSError("offline")

    monkeypatch.setattr(osrm, "urlopen", boom)


@pytest.fixture(autouse=True)
def _fresh_caches():
    osrm._road_route_cached.cache_clear()
    astar_routing._osrm_edge.cache_clear()
    yield
    osrm._road_route_cached.cache_clear()
    astar_routing._osrm_edge.cache_clear()


class _SlowSource:
    def current_positions(self):
        return [{"truck_code": "T-001", "latest_position": {"lat": -6.2, "lng": 106.8, "speed_kmh": 10.0}}]

    def breadcrumbs(self, truck_code, points):
        return [
            GpsBreadcrumb(
                truck_code=truck_code, lat=-6.2, lng=106.8, timestamp="2026-09-10T00:00:00", speed_kmh=10.0
            )
            for _ in range(points)
        ]


def test_parsed_osrm_route_is_osrm_duration():
    route = osrm.parse_osrm_route("r", PAYLOAD)
    assert route["eta_minutes"] == 30
    assert route["eta_source"] == "osrm_duration"
    assert "ai" not in route["eta_label"].lower().split()


def test_fallback_route_is_fallback_estimate():
    route = osrm.fallback_route("r", A, B)
    assert route["eta_source"] == "fallback_estimate"
    assert route["eta_minutes"] >= osrm.FALLBACK_ROUTE_MIN_MINUTES


def test_fetch_route_falls_back_with_label_when_offline(monkeypatch):
    _osrm_down(monkeypatch)
    assert osrm.fetch_osrm_route("r", A, B)["eta_source"] == "fallback_estimate"


def test_road_route_live_duration_is_osrm_duration(monkeypatch):
    _osrm_up(monkeypatch)
    route = osrm.road_route([A, B])
    assert (route["source"], route["duration_min"]) == ("LIVE_EXTERNAL", 30)
    assert route["eta_source"] == "osrm_duration"


def test_road_route_offline_is_45kmh_fallback_estimate(monkeypatch):
    _osrm_down(monkeypatch)
    route = osrm.road_route([A, B])
    assert route["source"] == "FALLBACK_DEGRADED"
    assert route["duration_min"] == round(osrm._haversine_km(A, B) / 45 * 60)
    assert route["eta_source"] == "fallback_estimate"


def test_astar_route_inherits_osrm_duration(monkeypatch):
    _osrm_up(monkeypatch)
    route = astar_routing.find_astar_route()
    assert route["success"]
    assert route["geometry_source"] == "osrm"
    assert route["eta_source"] == "osrm_duration"
    assert route["eta_minutes"] >= 15
    assert "eta_floor_min" not in route


def test_astar_floor_is_reported_when_it_applies(monkeypatch):
    monkeypatch.setattr(
        astar_routing, "_osrm_edge", lambda *a: (((a[0], a[1]), (a[2], a[3])), 1.0, 1.0, True)
    )
    route = astar_routing.find_astar_route()
    assert route["eta_minutes"] == 15
    assert route["eta_floor_min"] == 15
    assert route["eta_source"] == "osrm_duration"


def test_astar_route_offline_is_fallback_estimate(monkeypatch):
    _osrm_down(monkeypatch)
    route = astar_routing.find_astar_route()
    assert route["geometry_source"] == "fallback-straight-line"
    assert route["eta_source"] == "fallback_estimate"


def test_astar_mixed_legs_are_fallback_estimate(monkeypatch):
    nodes = {"S": (-6.2, 106.8, "S"), "M": (-6.25, 106.85, "M"), "G": (-6.3, 106.9, "G")}
    edges = [("S", "M", 1.0), ("M", "G", 1.0)]

    def mixed(a_lat, a_lng, b_lat, b_lng):
        is_osrm = (a_lat, a_lng) == nodes["S"][:2]  # first leg road-routed, second straight-line
        return (((a_lat, a_lng), (b_lat, b_lng)), 10.0, 30.0, is_osrm)

    monkeypatch.setattr(astar_routing, "_osrm_edge", mixed)
    route = astar_routing.find_astar_route(start="S", goal="G", nodes=nodes, edges=edges)
    assert route["geometry_source"] == "fallback-straight-line"
    assert route["eta_source"] == "fallback_estimate"


def test_scenario_route_options_are_simulated():
    assert {route["eta_source"] for route in data.ROUTE_OPTIONS} == {"simulated"}
    assert all(route["eta_label"] for route in data.ROUTE_OPTIONS)


def test_decision_route_b_takes_the_computed_label(monkeypatch):
    truck = {
        "truck_code": data.ROUTE_B_TRUCK,
        "status": "deviation",
        "is_damaged": False,
        "deviation": {
            "violated": True,
            "severity": "critical",
            "message": "x",
            "distance_meters": 2900.0,
            "rule_flags": [],
        },
    }
    monkeypatch.setattr(data, "TRUCKS", [truck])
    monkeypatch.setattr(data, "build_predictions", lambda: [])
    computed = osrm.fallback_route("Route B - Daan Mogot Recovery", A, B)
    monkeypatch.setattr(data, "_route_b_osrm", lambda: dict(computed))
    route = data.command_center_snapshot([])["alerts"][0]["recommended_routes"][0]
    assert route["eta_source"] == "fallback_estimate"


def test_map_truth_format_passes_the_label_through():
    mapped = map_truth.map_astar_to_osrm_format(
        {"eta_minutes": 20, "eta_source": "osrm_duration", "eta_label": "x", "eta_floor_min": 15}
    )
    assert (mapped["eta_source"], mapped["eta_label"], mapped["eta_floor_min"]) == ("osrm_duration", "x", 15)


def test_decision_endpoint_passes_the_label_through(monkeypatch, api_client):
    from app.api.routers import fleet as fleet_router

    plan = {
        "active_route": {
            "eta_minutes": 20,
            "eta_source": "fallback_estimate",
            "eta_label": "L",
            "physical_distance_km": 5.0,
            "optimization_cost": 1.0,
        }
    }
    monkeypatch.setattr(fleet_router, "reroute_payload", lambda *a, **k: plan)
    monkeypatch.setattr(fleet_router, "is_traffic_jam_active", lambda: False)
    body = api_client.get("/api/fleet/route-decision", params={"truck_code": "T-047"}).json()
    assert (body["eta_source"], body["eta_label"]) == ("fallback_estimate", "L")


def test_auto_reroute_event_carries_the_eta_source(monkeypatch):
    astar_routing.set_traffic_jam_active(False)
    feed = EventFeed(maxlen=10)
    rerouter = AutoRerouter(detector=SpeedAnomalyDetector(), feed=feed)
    # An earlier test's manual jam toggle holds the rerouter off for 90 s; not this one's concern.
    monkeypatch.setattr("app.ai.actions.auto_reroute.manual_override_active", lambda: False)
    monkeypatch.setattr(
        "app.ai.actions.auto_reroute.route_from_truck",
        lambda position: {
            "success": True,
            "distance_km": 5.0,
            "eta_minutes": 21,
            "eta_source": "osrm_duration",
            "eta_label": "L",
        },
    )
    try:
        for _ in range(3):  # three slow ticks activate the jam
            rerouter.run(_SlowSource())
    finally:
        astar_routing.set_traffic_jam_active(False)
    detail = next(e for e in feed.snapshot() if e["event_type"] == "auto_reroute")["detail"]
    assert (detail["new_eta_source"], detail["new_eta_label"]) == ("osrm_duration", "L")
