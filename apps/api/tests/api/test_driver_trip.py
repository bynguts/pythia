"""/api/driver/trip/{truck} and the driver's own exception list (wave 13 driver gaps)."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.core.env import local_today
from app.field import driver_trip
from app.field.spj import SPJ_STORE

STOPS = [
    {"name": "Rencana · Kec. Gambir", "kecamatan": "Gambir", "address": "a", "lat": -6.17, "lng": 106.82},
    {"name": "Rencana · Kec. Tebet", "kecamatan": "Tebet", "address": "b", "lat": -6.23, "lng": 106.85},
]


@pytest.fixture()
def truck() -> str:
    return f"TRP-{uuid4().hex[:6]}"


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    def road_route(coords):
        return {
            "distance_km": 4.7,
            "duration_min": 6,
            "eta_source": "osrm_duration",
            "eta_label": "Road travel time from OSRM routing",
        }

    monkeypatch.setattr(driver_trip.osrm, "road_route", road_route)


def _plan_spj(truck: str) -> tuple[str, str]:
    """An approved plan holding ``truck`` (two trips) and the active SPJ drafted from it."""
    plan_id = f"PLN-{uuid4().hex[:8]}"
    day = local_today().isoformat()
    item = {
        "truck_code": truck,
        "text": f"Rencana {plan_id} · Truk {truck}",
        "fields": {
            "plan_id": plan_id,
            "stops": [
                {"order": 1, "kecamatan": "Gambir", "tons": 9.0},
                {"order": 2, "kecamatan": "Gambir", "tons": 3.5},
                {"order": 3, "kecamatan": "Tebet", "tons": 8.0},
            ],
            "gate_slot": {
                "facility": "TPST Bantargebang",
                "slot_index": 40,
                "date": day,
                "start": "10:00",
                "end": "10:15",
                "depart_at": "08:30",
                "classification": "MODEL_OUTPUT",
            },
        },
    }
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id, {"plan_id": plan_id, "plan_date": day, "assignments": [], "dispatches": [item]}
    )
    _OPERATIONS_PLAN_STORE.approve(
        plan_id, "supervisor", lambda i: history_store.save_dispatch(i["truck_code"], i["text"], "test")
    )
    spj = SPJ_STORE.create_with_stops(
        "Driver 01",
        truck,
        "TPST Bantargebang",
        False,
        "normal",
        f"Rencana {plan_id} (MODEL) · fasilitas: TPST Bantargebang",
        [dict(s) for s in STOPS],
        created_by="admin",
    )
    SPJ_STORE.activate(spj.spj_id, actor="admin")
    return plan_id, spj.spj_id


def _trip(api_client, auth_headers, truck: str, role: str = "driver", **params):
    res = api_client.get(f"/api/driver/trip/{truck}", params=params, headers=auth_headers(role))
    assert res.status_code == 200, res.text
    return res.json()


def test_trip_needs_a_session(api_client, auth_headers, truck):
    assert api_client.get(f"/api/driver/trip/{truck}").status_code == 401
    assert api_client.get(f"/api/driver/trip/{truck}", headers=auth_headers("driver")).status_code == 200


def test_without_an_active_spj_or_a_position_everything_says_why(api_client, auth_headers, truck):
    body = _trip(api_client, auth_headers, truck)
    assert body["next_stop"] is None and body["next_stop_reason"] == "no_active_spj"
    assert body["to_tpa"]["eta_minutes"] is None and body["to_tpa"]["reason"] == "no_device_position"
    assert body["gate_slot"] is None and body["position_source"] is None
    assert body["queue_ahead"]["classification"] == "SIMULATED"


def test_next_stop_eta_from_the_phone_and_plan_tonnage_per_stop(api_client, auth_headers, truck):
    _, spj_id = _plan_spj(truck)
    try:
        body = _trip(api_client, auth_headers, truck, lat=-6.2, lng=106.8)
    finally:
        SPJ_STORE.cancel(spj_id, actor="admin")
    assert body["spj_id"] == spj_id and body["position_source"] == "device"
    assert body["next_stop"] == {
        "index": 0,
        "name": STOPS[0]["name"],
        "eta_minutes": 6,
        "distance_km": 4.7,
        "eta_source": "osrm_duration",
        "eta_label": "Road travel time from OSRM routing",
        "reason": None,
    }
    assert body["to_tpa"]["eta_minutes"] == 6 and body["to_tpa"]["destination"] == "TPST Bantargebang"
    tons = {s["kecamatan"]: s["expected_tons"] for s in body["stops"]}
    assert tons == {"Gambir": 12.5, "Tebet": 8.0}
    assert {s["expected_tons_classification"] for s in body["stops"]} == {"MODEL_OUTPUT"}
    slot = body["gate_slot"]
    assert slot["start"] == "10:00" and slot["depart_at"] == "08:30" and slot["source"] == "plan"


def test_an_spj_not_drafted_from_a_plan_has_no_expected_tonnage(api_client, auth_headers, truck):
    spj = SPJ_STORE.create_with_stops(
        "Driver 01",
        truck,
        "TPST Bantargebang",
        False,
        "normal",
        "manual",
        [dict(STOPS[0])],
        created_by="admin",
    )
    SPJ_STORE.activate(spj.spj_id, actor="admin")
    try:
        body = _trip(api_client, auth_headers, truck)
    finally:
        SPJ_STORE.cancel(spj.spj_id, actor="admin")
    stop = body["stops"][0]
    assert stop["expected_tons"] is None and stop["expected_tons_reason"] == "spj_not_from_plan"
    assert body["next_stop"]["reason"] == "no_device_position"


def test_queue_ahead_lists_board_slots_in_the_next_two_hours(monkeypatch):
    import app.api.routers.gate_slots as gate

    def slot(start, end):
        return {
            "start": start,
            "end": end,
            "expected_wait_min": 12.0,
            "background_load": 3.25,
            "planned_trucks": ["T-1"],
        }

    board = {
        "slots": [
            slot("08:45", "09:00"),
            slot("09:00", "09:15"),
            slot("11:00", "11:15"),
            slot("11:15", "11:30"),
        ],
        "classification": "SIMULATED",
        "reason": None,
    }
    monkeypatch.setattr(gate, "gate_slots_payload", lambda day: board)
    from datetime import datetime

    now = datetime(2026, 10, 26, 9, 5)
    ahead = driver_trip._queue_ahead("2026-10-26", now)
    assert [s["start"] for s in ahead["slots"]] == ["09:00", "11:00"]
    assert ahead["slots"][0]["load"] == 4.2 and ahead["reason"] is None


def test_driver_reads_only_its_own_truck_reports_with_follow_up_status(api_client, auth_headers, truck):
    created = api_client.post(
        "/api/driver/exceptions",
        json={"kind": "road_closed", "truck_code": truck},
        headers=auth_headers("driver"),
    ).json()
    assert api_client.get("/api/driver/exceptions", headers=auth_headers("driver")).status_code == 403
    path = f"/api/driver/exceptions?truck_code={truck}"
    first = api_client.get(path, headers=auth_headers("driver")).json()["exceptions"][0]
    assert first["exception_id"] == created["exception_id"]
    assert first["follow_up_status"] is None and first["report_status"] == "sent"
    alert_id = f"driver-exception:{created['exception_id']}"
    for status, expected in (("DISPATCHED", "seen"), ("RESOLVED", "handled")):
        api_client.post(
            "/api/alert/follow-up",
            json={"alert_id": alert_id, "status": status},
            headers=auth_headers("dispatcher"),
        )
        row = api_client.get(path, headers=auth_headers("driver")).json()["exceptions"][0]
        assert row["follow_up_status"] == status and row["report_status"] == expected


def test_dispatch_contact_comes_from_the_setting_and_is_null_when_unset(
    api_client, auth_headers, truck, monkeypatch
):
    monkeypatch.delenv("PYTHIA_DISPATCH_PHONE", raising=False)
    assert _trip(api_client, auth_headers, truck)["dispatch_contact"] == {
        "phone": None,
        "tel": None,
        "whatsapp": None,
        "reason": "not_configured",
    }
    monkeypatch.setenv("PYTHIA_DISPATCH_PHONE", "+62 812-3456-7890")
    contact = _trip(api_client, auth_headers, truck)["dispatch_contact"]
    assert contact["phone"] == "6281234567890" and contact["tel"] == "tel:+6281234567890"
    assert contact["whatsapp"] == "https://wa.me/6281234567890" and contact["reason"] is None
