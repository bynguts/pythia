"""/api/driver/exceptions: the driver app's quick exception buttons (empty TPS, closed road,
breakdown, accident), replay-safe for the offline outbox."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest

from app.core.auth import hash_password
from app.field.damage_reports import DAMAGE_STORE
from app.field.driver_exceptions import EXCEPTION_STORE

PHOTO = "data:image/jpeg;base64,AAAA"


@pytest.fixture()
def truck() -> str:
    return f"EXC-{uuid4().hex[:6]}"


def _report(api_client, headers, truck, kind="tps_empty", **extra):
    body = {"kind": kind, "truck_code": truck, "driver_name": "Sopir Uji", **extra}
    return api_client.post("/api/driver/exceptions", json=body, headers=headers)


@pytest.mark.parametrize("kind", ["tps_empty", "road_closed", "truck_breakdown", "accident"])
def test_each_quick_button_kind_is_stored_with_its_photo_and_device_time(
    api_client, auth_headers, truck, kind
):
    res = _report(
        api_client,
        auth_headers("driver"),
        truck,
        kind,
        note="",
        photo_name="x.jpg",
        photo_b64=PHOTO,
        lat=-6.2,
        lng=106.8,
        reported_at="2026-10-25T07:15:00+07:00",
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["kind"] == kind
    assert body["reported_by"] == "driver"
    assert body["reported_at"] == "2026-10-25T07:15:00+07:00"
    assert body["has_photo"] is True
    # The photo bytes stay on the server; responses only say one exists.
    assert "photo_b64" not in body
    stored = [r for r in EXCEPTION_STORE.list(truck_code=truck) if r.exception_id == body["exception_id"]]
    assert stored and stored[0].photo_b64 == PHOTO


def test_an_unknown_kind_is_refused(api_client, auth_headers, truck):
    assert _report(api_client, auth_headers("driver"), truck, "bin_on_fire").status_code == 422


def test_a_replayed_operation_files_one_report(api_client, auth_headers, truck):
    op = f"op-{uuid4().hex}"
    first = _report(api_client, auth_headers("driver"), truck, "road_closed", operation_id=op)
    assert first.status_code == 201, first.text
    assert first.json()["replayed"] is False
    # The outbox replays with the same id in the body or the X-Operation-Id header.
    again = _report(api_client, auth_headers("driver"), truck, "road_closed", operation_id=op)
    via_header = api_client.post(
        "/api/driver/exceptions",
        json={"kind": "road_closed", "truck_code": truck},
        headers={**auth_headers("driver"), "X-Operation-Id": op},
    )
    for replay in (again, via_header):
        assert replay.status_code == 201
        assert replay.json()["replayed"] is True
        assert replay.json()["exception_id"] == first.json()["exception_id"]
    assert len(EXCEPTION_STORE.list(truck_code=truck)) == 1


def test_a_breakdown_files_a_heavy_damage_report_but_an_empty_tps_does_not(api_client, auth_headers, truck):
    empty = _report(api_client, auth_headers("driver"), truck, "tps_empty").json()
    assert empty["damage_report_id"] is None
    broke = _report(api_client, auth_headers("driver"), truck, "truck_breakdown").json()
    assert broke["damage_report_id"]
    reports = [r for r in DAMAGE_STORE.list() if r.report_id == broke["damage_report_id"]]
    assert reports[0].severity == "berat"
    assert reports[0].source == "driver_exception"
    # A heavy open damage report is what puts the truck on maintenance hold.
    assert DAMAGE_STORE.active_override_for(truck) is not None


def test_a_report_is_logged_and_listed_for_operators_only(api_client, auth_headers, truck):
    created = _report(api_client, auth_headers("driver"), truck, "accident").json()
    listed = api_client.get(f"/api/driver/exceptions?truck_code={truck}", headers=auth_headers("dispatcher"))
    assert listed.status_code == 200
    assert [r["exception_id"] for r in listed.json()["exceptions"]] == [created["exception_id"]]
    assert api_client.get("/api/driver/exceptions", headers=auth_headers("driver")).status_code == 403
    events = api_client.get("/api/history", headers=auth_headers("supervisor"))
    assert events.status_code == 200


def test_an_spj_from_another_truck_is_refused(api_client, auth_headers, truck):
    created = api_client.post(
        "/api/spj",
        json={
            "driver_name": "Sopir Uji",
            "truck_code": truck,
            "destination": "TPST Bantargebang",
            "priority": "normal",
            "note": "",
        },
        headers=auth_headers("dispatcher"),
    )
    assert created.status_code == 201, created.text
    spj_id = created.json()["spj_id"]
    try:
        other = f"EXC-{uuid4().hex[:6]}"
        refused = _report(api_client, auth_headers("driver"), other, spj_id=spj_id, stop_index=0)
        assert refused.status_code == 409
        missing = _report(api_client, auth_headers("driver"), truck, spj_id="SPJ-NOPE")
        assert missing.status_code == 404
        own = _report(api_client, auth_headers("driver"), truck, spj_id=spj_id, stop_index=0)
        assert own.status_code == 201, own.text
        assert own.json()["spj_id"] == spj_id
    finally:
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("supervisor"))


def test_roles_without_field_permissions_cannot_report(api_client, truck):
    login = api_client.post("/api/auth/login", json={"username": "auditor", "password": "auditor-demo-pass"})
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    assert _report(api_client, headers, truck).status_code == 403
    assert _report(api_client, {}, truck).status_code == 401


def test_a_bound_driver_reports_only_for_its_own_truck(api_client, tmp_path, monkeypatch, truck):
    path = tmp_path / "users.json"
    path.write_text(
        json.dumps(
            {
                "users": [
                    {
                        "username": "sopir.exc",
                        "password_hash": hash_password("rahasia-exc-1", iterations=1_000),
                        "role": "driver",
                        "truck_code": truck,
                        "display_name": "Pengemudi Uji",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHIA_USERS_FILE", str(path))
    login = api_client.post("/api/auth/login", json={"username": "sopir.exc", "password": "rahasia-exc-1"})
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    assert _report(api_client, headers, f"EXC-{uuid4().hex[:6]}").status_code == 403
    own = _report(api_client, headers, truck)
    assert own.status_code == 201
    assert own.json()["reported_by"] == "sopir.exc"
