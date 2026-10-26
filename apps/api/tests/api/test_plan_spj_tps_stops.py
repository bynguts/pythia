"""Approved-plan SPJ drafts stop at real SILIKA TPS points of the truck's districts,
not at a district-centre placeholder."""

from __future__ import annotations

from uuid import uuid4

from app.api.routers.operations import TPS_STOP_LOCATION_TYPE, TPS_STOPS_PER_AREA
from app.api.state import _OPERATIONS_PLAN_STORE
from app.core.env import local_today
from app.field.spj import SPJ_STORE
from app.fleet.data import TRUCKS
from app.forecast.engine import _haversine_meters
from app.forecast.real_data import load_real_tps_coordinates


def _plan(trips: dict[str, list[str]]) -> dict:
    plan_id = f"PLAN-TPS-{uuid4().hex[:8]}"
    dispatches = [
        {
            "truck_code": truck,
            "text": f"Rencana {plan_id} · Truk {truck}",
            "fields": {
                "template": "plan_dispatch_v1",
                "plan_date": local_today().isoformat(),
                "stops": [
                    {
                        "order": i,
                        "area": area,
                        "kecamatan": area.replace("_", " ").title(),
                        "shift": "pagi",
                        "window": "06:00-14:00",
                        "facility": "TPST Bantargebang",
                        "facility_display": "TPST Bantargebang",
                        "tons": 9.0,
                    }
                    for i, area in enumerate(areas, start=1)
                ],
            },
        }
        for truck, areas in trips.items()
    ]
    return _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id,
        {
            "plan_id": plan_id,
            "status": "proposed",
            "kind": "day_plan",
            "plan_date": local_today().isoformat(),
            "assignments": [],
            "dispatches": dispatches,
            "proposed_by": "dispatcher",
        },
    )


def _drafts(api_client, auth_headers, plan_id: str) -> dict:
    res = api_client.post(f"/api/operations/{plan_id}/approve", headers=auth_headers("supervisor"))
    assert res.status_code == 200, res.text
    return {d["truck_code"]: SPJ_STORE.get(d["spj_id"]) for d in res.json()["spj_drafts"]}


def _silika(slug: str) -> dict[tuple, dict]:
    return {
        (t["lat"], t["lng"]): t
        for t in load_real_tps_coordinates()
        if t["kecamatan"].lower().replace(" ", "_") == slug
    }


def test_draft_stops_are_silika_tps_points_of_the_trucks_districts(api_client, auth_headers):
    truck = [t["truck_code"] for t in TRUCKS if not t["is_damaged"]][0]
    plan = _plan({truck: ["kali_deres", "cakung"]})
    spj = _drafts(api_client, auth_headers, plan["plan_id"])[truck]
    assert len(spj.stops) == 2 * TPS_STOPS_PER_AREA
    for stop, slug in zip(spj.stops, ["kali_deres"] * 3 + ["cakung"] * 3, strict=True):
        tps = _silika(slug).get((stop.lat, stop.lng))
        assert tps is not None, f"{stop.name} is not a SILIKA TPS of {slug}"
        assert stop.name == tps["name"]
        assert stop.location_type == TPS_STOP_LOCATION_TYPE
        assert "SILIKA" in stop.address
        assert "Titik tengah" not in stop.address


def test_stops_in_a_district_are_visited_nearest_first(api_client, auth_headers):
    truck = [t["truck_code"] for t in TRUCKS if not t["is_damaged"]][1]
    plan = _plan({truck: ["kali_deres", "cakung"]})
    stops = _drafts(api_client, auth_headers, plan["plan_id"])[truck].stops
    # From the last Kali Deres stop, the first Cakung stop is the nearest Cakung one.
    last = (stops[2].lat, stops[2].lng)
    cakung = [(s.lat, s.lng) for s in stops[3:]]
    assert cakung[0] == min(cakung, key=lambda p: _haversine_meters(last, p))


def test_trucks_sharing_a_district_get_different_tps(api_client, auth_headers):
    a, b = [t["truck_code"] for t in TRUCKS if not t["is_damaged"]][2:4]
    plan = _plan({a: ["gambir"], b: ["gambir"]})
    drafts = _drafts(api_client, auth_headers, plan["plan_id"])
    points_a = {(s.lat, s.lng) for s in drafts[a].stops}
    points_b = {(s.lat, s.lng) for s in drafts[b].stops}
    assert points_a and points_b and not points_a & points_b
