"""Teardown v4 M3: a deviation decision carries one route (one name, ETA and source)."""

from app.fleet import data


def _truck(code, *, sustained=False):
    return {
        "truck_code": code,
        "status": "deviation",
        "is_damaged": False,
        "deviation": {
            "violated": True,
            "severity": "critical",
            "message": "Truck is 2924 meters from the assigned corridor.",
            "distance_meters": 2924.0,
            "rule_flags": ["sustained_deviation"] if sustained else [],
        },
    }


COMPUTED = {
    "name": "Route B - Daan Mogot Recovery",
    "source": "fallback",
    "eta_minutes": 95,
    "distance_km": 34.7,
    "path": [{"lat": -6.22, "lng": 106.78}, {"lat": -6.19, "lng": 106.80}],
}


def _snapshot(monkeypatch):
    monkeypatch.setattr(data, "TRUCKS", [_truck(data.ROUTE_B_TRUCK), _truck("T-200", sustained=True)])
    monkeypatch.setattr(data, "build_predictions", lambda: [])
    monkeypatch.setattr(data, "_route_b_osrm", lambda: dict(COMPUTED))
    return data.command_center_snapshot([])


def test_route_options_carry_a_code_for_localized_names():
    assert [route["code"] for route in data.ROUTE_OPTIONS] == ["A", "B", "C"]


def test_computed_route_b_is_the_one_route_of_its_decision(monkeypatch):
    snapshot = _snapshot(monkeypatch)
    alert = next(a for a in snapshot["alerts"] if a["truck_code"] == data.ROUTE_B_TRUCK)
    route = alert["recommended_routes"][0]
    assert route["code"] == "B"
    # The card quotes the computed route, not the static 48-minute scenario figure.
    assert (route["eta_minutes"], route["distance_km"], route["source"]) == (95, 34.7, "fallback")
    assert route["path"] == COMPUTED["path"]
    assert snapshot["osrm_route"]["eta_minutes"] == route["eta_minutes"]


def test_other_decisions_label_their_route_as_a_scenario(monkeypatch):
    snapshot = _snapshot(monkeypatch)
    alert = next(a for a in snapshot["alerts"] if a["truck_code"] == "T-200")
    assert {route["source"] for route in alert["recommended_routes"]} == {"scenario"}
    assert "path" in alert["recommended_routes"][0]


def test_deviation_alert_carries_codes_for_localized_copy(monkeypatch):
    snapshot = _snapshot(monkeypatch)
    by_truck = {a["truck_code"]: a for a in snapshot["alerts"]}
    assert by_truck[data.ROUTE_B_TRUCK]["distance_meters"] == 2924.0
    assert by_truck[data.ROUTE_B_TRUCK]["sustained"] is False
    assert by_truck["T-200"]["sustained"] is True


def test_missing_computed_route_keeps_the_scenario_route(monkeypatch):
    # OSRM down or an empty payload: no crash, the decision keeps its labelled scenario route.
    for payload in ({}, None, {**COMPUTED, "eta_minutes": None}):
        monkeypatch.setattr(data, "TRUCKS", [_truck(data.ROUTE_B_TRUCK)])
        monkeypatch.setattr(data, "build_predictions", lambda: [])
        monkeypatch.setattr(data, "_route_b_osrm", lambda payload=payload: payload)
        snapshot = data.command_center_snapshot([])
        route = snapshot["alerts"][0]["recommended_routes"][0]
        assert (route["code"], route["source"], route["eta_minutes"]) == ("B", "scenario", 48)
