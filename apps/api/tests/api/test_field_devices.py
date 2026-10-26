"""/api/field/devices: driver phones counted only from their own calls to this server."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.field import devices


def _codes(body: dict) -> list[str]:
    return [d["truck_code"] for d in body["last_seen"]]


def test_needs_the_dashboard_permission(api_client, auth_headers):
    assert api_client.get("/api/field/devices").status_code == 401
    assert api_client.get("/api/field/devices", headers=auth_headers("driver")).status_code == 403
    res = api_client.get("/api/field/devices", headers=auth_headers("dispatcher"))
    assert res.status_code == 200
    body = res.json()
    assert body["classification"] == "FIELD" and body["window_minutes"] == 30
    assert all(set(d) == {"truck_code", "at"} for d in body["last_seen"])  # no usernames


def test_a_driver_truck_read_marks_that_truck_seen(api_client, auth_headers):
    truck = f"DEV-{uuid4().hex[:6]}"
    before = api_client.get("/api/field/devices", headers=auth_headers("dispatcher")).json()
    assert truck not in _codes(before)
    assert api_client.get(f"/api/dispatch/{truck}", headers=auth_headers("driver")).status_code == 200
    after = api_client.get("/api/field/devices", headers=auth_headers("dispatcher")).json()
    assert truck in _codes(after)
    assert after["synced"] >= 1


def test_an_operator_read_is_not_a_phone(api_client, auth_headers):
    truck = f"DEV-{uuid4().hex[:6]}"
    api_client.get(f"/api/dispatch/{truck}", headers=auth_headers("dispatcher"))
    body = api_client.get("/api/field/devices", headers=auth_headers("dispatcher")).json()
    assert truck not in _codes(body)


def test_only_calls_inside_the_window_count_as_synced():
    now = datetime.now(UTC)
    old, fresh = f"DEV-{uuid4().hex[:6]}", f"DEV-{uuid4().hex[:6]}"
    devices.note_seen("driver", old, now=now - timedelta(minutes=45))
    devices.note_seen("driver", fresh, now=now - timedelta(minutes=5))
    body = devices.devices_payload(expected=None, now=now)
    window = now - timedelta(minutes=30)
    recent = {d["truck_code"] for d in body["last_seen"] if datetime.fromisoformat(d["at"]) >= window}
    assert fresh in recent and old not in recent
    assert body["synced"] == len(recent)
    assert body["expected"] is None


def test_expected_is_null_without_an_approved_plan_today(api_client, auth_headers, monkeypatch):
    import app.api.routers.ops as ops

    monkeypatch.setattr(ops._OPERATIONS_PLAN_STORE, "list_plans", lambda status=None, limit=20: [])
    body = api_client.get("/api/field/devices", headers=auth_headers("dispatcher")).json()
    assert body["expected"] is None
