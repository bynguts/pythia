"""/api/safety: permissions, the SPJ duty block, overrides with audit, gate arrival and labels."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.api.routers import safety as safety_router
from app.api.state import history_store
from app.core.auth import hash_password
from app.field import safety
from app.field import spj as spj_module
from app.field.pretrip import PRETRIP_ITEMS, PRETRIP_STORE
from app.fleet.data import get_dynamic_trucks

# 20:00 WIB on a fixed past day, so the duty window never crosses a WIB midnight.
FROZEN_NOW = datetime(2026, 10, 20, 13, 0, tzinfo=UTC)
STOP = {"name": "TPS Uji", "kecamatan": "Cilandak", "address": "Jl. Uji 1", "lat": -6.29, "lng": 106.79}


def _road(coords):
    return {
        "geometry": [{"lat": la, "lng": ln} for la, ln in coords],
        "source": "LIVE_EXTERNAL",
        "distance_km": 1.0,
        "duration_min": 2,
    }


@pytest.fixture()
def truck() -> str:
    return f"SAF-{uuid4().hex[:6]}"


def _on_duty_since(truck: str, minutes: int) -> None:
    at = FROZEN_NOW - timedelta(minutes=minutes)
    record_id = uuid4().hex[:12]
    PRETRIP_STORE._records.write(
        record_id,
        {
            "record_id": record_id,
            "truck_code": truck,
            "driver_name": "Pengemudi Uji",
            "date": at.date().isoformat(),
            "items": {k: True for k in PRETRIP_ITEMS},
            "note": "",
            "created_at": at.isoformat(),
        },
    )


def _draft(api_client, auth_headers, truck: str):
    return api_client.post(
        "/api/spj",
        json={
            "driver_name": "Pengemudi Uji",
            "truck_code": truck,
            "destination": "TPST Bantargebang",
            "stops": [STOP],
        },
        headers=auth_headers("supervisor"),
    )


def _events(event_type: str, truck: str) -> list[dict]:
    return [
        e["payload"]
        for e in history_store.list_events(limit=200)
        if e["event_type"] == event_type and e["payload"].get("truck_code") == truck
    ]


def test_reads_need_a_field_token_or_the_dashboard(api_client, auth_headers, truck):
    assert api_client.get(f"/api/safety/driver/{truck}").status_code == 401
    assert api_client.get(f"/api/safety/driver/{truck}", headers=auth_headers("driver")).status_code == 200
    assert (
        api_client.get(f"/api/safety/driver/{truck}", headers=auth_headers("dispatcher")).status_code == 200
    )
    assert api_client.get("/api/safety/overview").status_code == 401
    assert api_client.get("/api/safety/overview", headers=auth_headers("driver")).status_code == 403
    body = api_client.get("/api/safety/overview", headers=auth_headers("supervisor")).json()
    assert body["viewer"] == {"role": "supervisor", "can_override": True}
    assert (
        api_client.get("/api/safety/overview", headers=auth_headers("dispatcher")).json()["viewer"][
            "can_override"
        ]
        is False
    )


def test_driver_contract_shape(api_client, auth_headers, truck, monkeypatch):
    monkeypatch.setattr(safety, "_now", lambda: FROZEN_NOW)
    _on_duty_since(truck, 615)
    body = api_client.get(f"/api/safety/driver/{truck}", headers=auth_headers("driver")).json()
    for key in (
        "truck_code",
        "shift_started_at",
        "duty_minutes",
        "duty_state",
        "warn_at_minutes",
        "block_at_minutes",
        "override",
        "gate_wait_minutes",
        "gate_state",
        "gate_alert_at_minutes",
        "classification",
        "label",
    ):
        assert key in body
    assert (body["duty_minutes"], body["duty_state"]) == (615, "warn")
    assert (body["warn_at_minutes"], body["block_at_minutes"], body["gate_alert_at_minutes"]) == (
        600,
        720,
        180,
    )
    assert body["classification"] == "OBSERVED_APP_EVENTS"
    assert body["gate_state"] is None and body["override"] is None


def test_spj_start_is_blocked_at_twelve_hours_until_a_supervisor_overrides(
    api_client, auth_headers, truck, monkeypatch
):
    monkeypatch.setattr(safety, "_now", lambda: FROZEN_NOW)
    monkeypatch.setattr(spj_module, "road_route", _road)
    draft = _draft(api_client, auth_headers, truck)
    assert draft.status_code == 201, draft.text
    spj_id = draft.json()["spj_id"]

    _on_duty_since(truck, 721)
    refused = _draft(api_client, auth_headers, truck)
    assert refused.status_code == 409
    # A coded refusal the console translates; the English message is for API users.
    detail = refused.json()["detail"]
    assert detail["code"] == "duty_blocked" and detail["params"] == {
        "truck": truck,
        "h": 12,
        "m": 1,
        "limit": 12,
    }
    assert "blocked for the driver's safety" in detail["message"]
    activate = api_client.post(f"/api/spj/{spj_id}/activate", headers=auth_headers("supervisor"))
    assert activate.status_code == 409
    assert activate.json()["detail"]["code"] == "duty_blocked"
    assert {e["action"] for e in _events("safety_duty_block", truck)} == {"create", "activate"}

    reason = "Sopir pengganti belum tiba di pool"
    assert (
        api_client.post(
            "/api/safety/override",
            json={"truck_code": truck, "reason": reason},
            headers=auth_headers("driver"),
        ).status_code
        == 403
    )
    assert (
        api_client.post(
            "/api/safety/override",
            json={"truck_code": truck, "reason": reason},
            headers=auth_headers("dispatcher"),
        ).status_code
        == 403
    )
    short = api_client.post(
        "/api/safety/override",
        json={"truck_code": truck, "reason": "capek"},
        headers=auth_headers("supervisor"),
    )
    assert short.status_code == 409
    granted = api_client.post(
        "/api/safety/override",
        json={"truck_code": truck, "reason": reason},
        headers=auth_headers("supervisor"),
    )
    assert granted.status_code == 201, granted.text
    assert granted.json()["duty_state"] == "blocked"
    assert granted.json()["override"]["by"] == "supervisor"
    assert granted.json()["override"]["reason"] == reason
    audit = _events("safety_duty_override", truck)
    assert len(audit) == 1
    assert (audit[0]["actor"], audit[0]["reason"], audit[0]["duty_minutes"]) == ("supervisor", reason, 721)

    try:
        activated = api_client.post(f"/api/spj/{spj_id}/activate", headers=auth_headers("supervisor"))
        assert activated.status_code == 200, activated.text
        used = _events("safety_override_used", truck)
        assert used and used[0]["override_by"] == "supervisor"
    finally:
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("supervisor"))


def test_simulated_scenario_never_blocks_an_spj(api_client, auth_headers, truck, monkeypatch):
    monkeypatch.setattr(safety, "observed_activity", lambda now, truck_code=None: {})
    created = _draft(api_client, auth_headers, truck)
    assert created.status_code == 201
    api_client.post(f"/api/spj/{created.json()['spj_id']}/cancel", headers=auth_headers("supervisor"))


def test_gate_arrival_then_a_three_hour_wait_alerts_the_group_once(
    api_client, auth_headers, truck, monkeypatch
):
    monkeypatch.setattr(spj_module, "road_route", _road)
    sent: list[str] = []
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_GROUP_ID", "120363000000000001@g.us")
    monkeypatch.setattr(safety, "_dispatch", lambda fn, *args: fn(*args))
    monkeypatch.setattr(
        safety.OpenWAClient,
        "send_text",
        lambda self, chat_id, text: sent.append(chat_id) or {"sent": True, "message": "ok"},
    )
    spj_id = _draft(api_client, auth_headers, truck).json()["spj_id"]
    try:
        assert (
            api_client.post(f"/api/spj/{spj_id}/activate", headers=auth_headers("supervisor")).status_code
            == 200
        )
        assert (
            api_client.post(
                "/api/safety/gate-arrival", json={"spj_id": "missing"}, headers=auth_headers("driver")
            )
        ).status_code == 404
        future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
        assert (
            api_client.post(
                "/api/safety/gate-arrival",
                json={"spj_id": spj_id, "arrived_at": future},
                headers=auth_headers("driver"),
            )
        ).status_code == 409
        arrived = api_client.post(
            "/api/safety/gate-arrival", json={"spj_id": spj_id}, headers=auth_headers("driver")
        )
        assert arrived.status_code == 201, arrived.text
        assert arrived.json()["gate_status"] == "waiting"
        assert arrived.json()["gate_state"] == "ok"
        assert sent == []

        later = datetime.now(UTC) + timedelta(minutes=181)
        monkeypatch.setattr(safety, "_now", lambda: later)
        for _ in range(2):
            state = api_client.get(f"/api/safety/driver/{truck}", headers=auth_headers("driver")).json()
            assert state["gate_state"] == "alert"
        overview = api_client.get("/api/safety/overview", headers=auth_headers("supervisor")).json()
        assert sent == ["120363000000000001@g.us"]
        mine = [a for a in overview["alerts"] if a["truck_code"] == truck]
        assert len(mine) == 1 and mine[0]["whatsapp"]["status"] == "sent"
        assert len(_events("safety_gate_alert", truck)) == 1
    finally:
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("supervisor"))


def test_overview_falls_back_to_a_labelled_simulated_fleet(api_client, auth_headers, monkeypatch):
    monkeypatch.setattr(safety, "observed_activity", lambda now, truck_code=None: {})
    body = api_client.get("/api/safety/overview", headers=auth_headers("supervisor")).json()
    assert body["classification"] == "SIMULATED"
    assert "SIMULATED" in body["label"]
    # Teardown v4 F4: the same units as the fleet roster (no orphan corridor truck).
    assert len(body["trucks"]) == len(get_dynamic_trucks())
    assert {t["classification"] for t in body["trucks"]} == {"SIMULATED"}
    assert body["alerts"] is not None
    for key in ("gate_wait_p50", "gate_wait_p90", "shift_window"):
        assert key in body


def test_observed_overview_never_mixes_in_simulated_trucks(api_client, auth_headers, truck, monkeypatch):
    monkeypatch.setattr(safety, "_now", lambda: FROZEN_NOW)
    _on_duty_since(truck, 30)
    body = api_client.get("/api/safety/overview", headers=auth_headers("supervisor")).json()
    assert body["classification"] == "OBSERVED_APP_EVENTS"
    assert {t["classification"] for t in body["trucks"]} == {"OBSERVED_APP_EVENTS"}
    assert truck in {t["truck_code"] for t in body["trucks"]}


# -- personal (truck-bound) driver accounts ------------------------------------------


@pytest.fixture()
def bound_logins(api_client, tmp_path, monkeypatch, truck):
    """A personal driver bound to ``truck`` and a personal supervisor, as in tests/core/test_users_file.py."""
    path = tmp_path / "users.json"
    path.write_text(
        json.dumps(
            {
                "users": [
                    {
                        "username": "sopir.safety",
                        "password_hash": hash_password("rahasia-safety-1", iterations=1_000),
                        "role": "driver",
                        "truck_code": truck,
                        "display_name": "Pengemudi Uji Safety",
                    },
                    {
                        "username": "pengawas.safety",
                        "password_hash": hash_password("rahasia-safety-2", iterations=1_000),
                        "role": "supervisor",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHIA_USERS_FILE", str(path))

    def login(username: str, password: str) -> dict[str, str]:
        res = api_client.post("/api/auth/login", json={"username": username, "password": password})
        assert res.status_code == 200, res.text
        return {"Authorization": f"Bearer {res.json()['token']}"}

    return {
        "driver": login("sopir.safety", "rahasia-safety-1"),
        "supervisor": login("pengawas.safety", "rahasia-safety-2"),
    }


def test_a_bound_driver_reads_and_reports_only_its_own_truck(
    api_client, auth_headers, truck, bound_logins, monkeypatch
):
    monkeypatch.setattr(spj_module, "road_route", _road)
    other = f"SAF-{uuid4().hex[:6]}"
    driver = bound_logins["driver"]
    assert api_client.get(f"/api/safety/driver/{truck}", headers=driver).status_code == 200
    assert api_client.get(f"/api/safety/driver/{other}", headers=driver).status_code == 403
    # Operators and the shared demo driver account stay unrestricted.
    for role in ("dispatcher", "supervisor", "driver"):
        assert api_client.get(f"/api/safety/driver/{other}", headers=auth_headers(role)).status_code == 200

    mine = _draft(api_client, auth_headers, truck).json()["spj_id"]
    theirs = _draft(api_client, auth_headers, other).json()["spj_id"]
    try:
        for spj_id in (mine, theirs):
            activated = api_client.post(f"/api/spj/{spj_id}/activate", headers=auth_headers("supervisor"))
            assert activated.status_code == 200, activated.text
        refused = api_client.post("/api/safety/gate-arrival", json={"spj_id": theirs}, headers=driver)
        assert refused.status_code == 403
        assert not [e for e in safety.SPJ_STORE.audit_log(theirs) if e["action"] == "gate_arrival"]

        own = api_client.post("/api/safety/gate-arrival", json={"spj_id": mine}, headers=driver)
        assert own.status_code == 201, own.text
        arrivals = [e for e in safety.SPJ_STORE.audit_log(mine) if e["action"] == "gate_arrival"]
        assert [e["actor"] for e in arrivals] == ["sopir.safety"]
        shared = api_client.post(
            "/api/safety/gate-arrival", json={"spj_id": theirs}, headers=auth_headers("driver")
        )
        assert shared.status_code == 201, shared.text
    finally:
        for spj_id in (mine, theirs):
            api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("supervisor"))


def test_an_override_is_audited_with_the_person_not_the_role(api_client, truck, bound_logins):
    reason = "Sopir pengganti belum tiba di pool"
    granted = api_client.post(
        "/api/safety/override",
        json={"truck_code": truck, "reason": reason},
        headers=bound_logins["supervisor"],
    )
    assert granted.status_code == 201, granted.text
    assert granted.json()["override"]["by"] == "pengawas.safety"
    assert [e["actor"] for e in _events("safety_duty_override", truck)] == ["pengawas.safety"]


# -- gate-alert timer: alerts fire with no panel open ------------------------------------


def test_gate_timer_tick_alerts_once_per_wait_without_any_panel(api_client, auth_headers, truck, monkeypatch):
    monkeypatch.setattr(spj_module, "road_route", _road)
    monkeypatch.delenv("PYTHIA_WA_DEFAULT_GROUP_ID", raising=False)
    spj_id = _draft(api_client, auth_headers, truck).json()["spj_id"]
    try:
        assert (
            api_client.post(f"/api/spj/{spj_id}/activate", headers=auth_headers("supervisor")).status_code
            == 200
        )
        arrived = api_client.post(
            "/api/safety/gate-arrival", json={"spj_id": spj_id}, headers=auth_headers("driver")
        )
        assert arrived.status_code == 201, arrived.text
        assert truck not in {a["truck_code"] for a in safety_router.gate_alert_tick()}

        later = datetime.now(UTC) + timedelta(minutes=181)
        monkeypatch.setattr(safety, "_now", lambda: later)
        first = [a for a in safety_router.gate_alert_tick() if a["truck_code"] == truck]
        assert len(first) == 1
        assert first[0]["whatsapp"]["status"] == "not_configured"
        assert first[0]["classification"] == "OBSERVED_APP_EVENTS"
        # The same wait never raises a second alert, from the timer or from a panel read.
        assert truck not in {a["truck_code"] for a in safety_router.gate_alert_tick()}
        api_client.get(f"/api/safety/driver/{truck}", headers=auth_headers("driver"))
        assert len(_events("safety_gate_alert", truck)) == 1
    finally:
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("supervisor"))


def test_gate_timer_honours_the_setting_and_stops_on_its_event(monkeypatch):
    monkeypatch.setenv("PYTHIA_SAFETY_GATE_TIMER", "off")
    assert safety_router.start_gate_alert_timer(interval_seconds=0.01) is None

    monkeypatch.setenv("PYTHIA_SAFETY_GATE_TIMER", "on")
    ticked = threading.Event()
    monkeypatch.setattr(safety_router, "gate_alert_tick", ticked.set)
    stop = safety_router.start_gate_alert_timer(interval_seconds=0.01)
    assert stop is not None
    assert ticked.wait(2)
    stop.set()
    for thread in threading.enumerate():
        if thread.name == "pythia-safety-gate-timer":
            thread.join(timeout=2)
            assert not thread.is_alive()
