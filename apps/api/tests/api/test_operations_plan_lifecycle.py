"""Plan lifecycle (wave 13): return with a note, withdraw, swap two trucks before approval."""

from __future__ import annotations

from uuid import uuid4

import pytest

import app.api.routers.operations as operations
from app.api.state import _OPERATIONS_PLAN_STORE, history_store


def _dispatch(plan_id: str, truck: str, slot: str) -> dict:
    return {
        "truck_code": truck,
        "text": f"Rencana {plan_id} · 1 Jan 2030 · Truk {truck}\n1. Shift pagi: angkut ±9 t dari Kec. Uji",
        "fields": {"truck_code": truck, "plan_id": plan_id, "gate_slot": {"start": slot}},
    }


@pytest.fixture()
def plan_id() -> str:
    pid = f"PLN-{uuid4().hex[:8]}"
    _OPERATIONS_PLAN_STORE.save_proposed(
        pid,
        {
            "plan_id": pid,
            "plan_date": "2030-01-01",
            "assignments": [
                {"truck_code": "T-001", "area": "gambir", "assigned_tons": 9.0, "trip_index": 1},
                {"truck_code": "T-001", "area": "tebet", "assigned_tons": 8.0, "trip_index": 2},
                {"truck_code": "T-002", "area": "cakung", "assigned_tons": 7.0, "trip_index": 1},
            ],
            "dispatches": [_dispatch(pid, "T-001", "07:00"), _dispatch(pid, "T-002", "08:00")],
        },
    )
    return pid


@pytest.fixture(autouse=True)
def _fleet(monkeypatch):
    trucks = [
        {"truck_code": code, "is_damaged": code == "T-009", "deviation": {"violated": False}}
        for code in ("T-001", "T-002", "T-003", "T-009")
    ]
    monkeypatch.setattr(operations, "TRUCKS", trucks)


def _post(api_client, auth_headers, path, role="dispatcher", json=None):
    return api_client.post(path, json=json, headers=auth_headers(role))


def test_solve_seconds_is_in_a_built_plan(api_client, auth_headers):
    res = _post(api_client, auth_headers, "/api/operations/plan?top_n=2&plan_date=2026-10-27")
    assert res.status_code == 200, res.text
    assert isinstance(res.json()["solve_seconds"], float)


def test_return_needs_the_approver_and_takes_the_plan_out_of_the_inbox(api_client, auth_headers, plan_id):
    path = f"/api/operations/plans/{plan_id}/return"
    assert _post(api_client, auth_headers, path, "dispatcher", {"note": "Too many trucks"}).status_code == 403
    assert _post(api_client, auth_headers, path, "supervisor", {"note": ""}).status_code == 422
    res = _post(api_client, auth_headers, path, "supervisor", {"note": "Keep T-112 in the workshop"})
    assert res.status_code == 200, res.text
    plan = res.json()
    assert plan["status"] == "returned" and plan["return_note"] == "Keep T-112 in the workshop"
    assert plan["returned_by"] == "supervisor" and plan["returned_at"]
    inbox = api_client.get(
        "/api/operations/plans?status=proposed&limit=100", headers=auth_headers("supervisor")
    )
    assert plan_id not in {p["plan_id"] for p in inbox.json()}
    returned = api_client.get(
        "/api/operations/plans?status=returned&limit=100", headers=auth_headers("dispatcher")
    )
    assert plan_id in {p["plan_id"] for p in returned.json()}
    # A returned plan cannot be approved or returned again.
    assert (
        _post(api_client, auth_headers, f"/api/operations/{plan_id}/approve", "supervisor").status_code == 409
    )
    assert _post(api_client, auth_headers, path, "supervisor", {"note": "again"}).status_code == 409


def test_withdraw_from_proposed_or_returned(api_client, auth_headers, plan_id):
    path = f"/api/operations/plans/{plan_id}/withdraw"
    assert _post(api_client, auth_headers, path, "supervisor").status_code == 403
    _post(api_client, auth_headers, f"/api/operations/plans/{plan_id}/return", "supervisor", {"note": "redo"})
    res = _post(api_client, auth_headers, path)
    assert res.status_code == 200 and res.json()["status"] == "withdrawn"
    assert res.json()["withdrawn_by"] == "dispatcher"
    assert _post(api_client, auth_headers, path).status_code == 409
    assert (
        _post(api_client, auth_headers, f"/api/operations/{plan_id}/approve", "supervisor").status_code == 409
    )
    assert _post(api_client, auth_headers, "/api/operations/plans/PLN-none/withdraw").status_code == 404


def test_approved_plan_cannot_be_withdrawn_or_returned(api_client, auth_headers, plan_id):
    _OPERATIONS_PLAN_STORE.approve(
        plan_id, "supervisor", lambda i: history_store.save_dispatch(i["truck_code"], i["text"], "test")
    )
    assert _post(api_client, auth_headers, f"/api/operations/plans/{plan_id}/withdraw").status_code == 409
    res = _post(
        api_client, auth_headers, f"/api/operations/plans/{plan_id}/return", "supervisor", {"note": "late"}
    )
    assert res.status_code == 409


def test_swap_exchanges_the_work_of_two_plan_trucks(api_client, auth_headers, plan_id):
    res = _post(
        api_client,
        auth_headers,
        f"/api/operations/plans/{plan_id}/swap",
        json={"truck_a": "T-001", "truck_b": "T-002"},
    )
    assert res.status_code == 200, res.text
    plan = res.json()
    by_area = {a["area"]: a["truck_code"] for a in plan["assignments"]}
    assert by_area == {"gambir": "T-002", "tebet": "T-002", "cakung": "T-001"}
    dispatches = {d["truck_code"]: d for d in plan["dispatches"]}
    # The slot belongs to the work: T-002 now holds the 07:00 work of T-001.
    assert dispatches["T-002"]["fields"]["gate_slot"]["start"] == "07:00"
    assert dispatches["T-002"]["fields"]["truck_code"] == "T-002"
    assert dispatches["T-002"]["text"].splitlines()[0].endswith("Truk T-002")
    assert "Kec. Uji" in dispatches["T-002"]["text"]
    assert plan["edits"][-1]["truck_a"] == "T-001" and plan["edits"][-1]["by"] == "dispatcher"
    assert plan["status"] == "proposed"


def test_swap_onto_a_fleet_truck_outside_the_plan_moves_the_work(api_client, auth_headers, plan_id):
    path = f"/api/operations/plans/{plan_id}/swap"
    res = _post(api_client, auth_headers, path, json={"truck_a": "T-002", "truck_b": "T-003"})
    assert res.status_code == 200, res.text
    assert {a["truck_code"] for a in res.json()["assignments"]} == {"T-001", "T-003"}
    assert len(res.json()["edits"]) == 1


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"truck_a": "T-001", "truck_b": "T-001"}, 422),
        ({"truck_a": "T-003", "truck_b": "T-001"}, 404),
        ({"truck_a": "T-001", "truck_b": "T-404"}, 404),
        ({"truck_a": "T-001", "truck_b": "T-009"}, 409),
    ],
)
def test_swap_refusals(api_client, auth_headers, plan_id, body, status):
    assert (
        _post(api_client, auth_headers, f"/api/operations/plans/{plan_id}/swap", json=body).status_code
        == status
    )


def test_swap_needs_operations_plan_and_a_plan_not_yet_approved(api_client, auth_headers, plan_id):
    path = f"/api/operations/plans/{plan_id}/swap"
    body = {"truck_a": "T-001", "truck_b": "T-002"}
    assert _post(api_client, auth_headers, path, "supervisor", body).status_code == 403
    _OPERATIONS_PLAN_STORE.approve(
        plan_id, "supervisor", lambda i: history_store.save_dispatch(i["truck_code"], i["text"], "test")
    )
    assert _post(api_client, auth_headers, path, json=body).status_code == 409


def test_a_draft_stays_out_of_the_inbox_until_submitted(api_client, auth_headers):
    res = _post(api_client, auth_headers, "/api/operations/plan?top_n=2&plan_date=2026-10-27&draft=true")
    assert res.status_code == 200, res.text
    plan = res.json()
    pid = plan["plan_id"]
    assert plan["status"] == "draft"
    inbox = api_client.get(
        "/api/operations/plans?status=proposed&limit=100", headers=auth_headers("supervisor")
    )
    assert pid not in {p["plan_id"] for p in inbox.json()}
    drafts = api_client.get(
        "/api/operations/plans?status=draft&limit=100", headers=auth_headers("dispatcher")
    )
    assert pid in {p["plan_id"] for p in drafts.json()}
    assert _post(api_client, auth_headers, f"/api/operations/{pid}/approve", "supervisor").status_code == 409
    assert (
        _post(api_client, auth_headers, f"/api/operations/plans/{pid}/submit", "supervisor").status_code
        == 403
    )
    submitted = _post(api_client, auth_headers, f"/api/operations/plans/{pid}/submit")
    assert submitted.status_code == 200, submitted.text
    body = submitted.json()
    assert body["status"] == "proposed" and body["submitted_by"] == "dispatcher" and body["submitted_at"]
    assert _post(api_client, auth_headers, f"/api/operations/plans/{pid}/submit").status_code == 409
    inbox = api_client.get(
        "/api/operations/plans?status=proposed&limit=100", headers=auth_headers("supervisor")
    )
    assert pid in {p["plan_id"] for p in inbox.json()}


def test_a_plan_without_the_draft_flag_is_proposed_as_before(api_client, auth_headers):
    res = _post(api_client, auth_headers, "/api/operations/plan?top_n=2&plan_date=2026-10-27")
    assert res.json()["status"] == "proposed"


def test_a_draft_can_be_swapped_and_withdrawn(api_client, auth_headers, plan_id):
    _OPERATIONS_PLAN_STORE.edit(plan_id, ("proposed",), lambda p: p, "draft")
    body = {"truck_a": "T-001", "truck_b": "T-002"}
    swapped = _post(api_client, auth_headers, f"/api/operations/plans/{plan_id}/swap", json=body)
    assert swapped.status_code == 200 and swapped.json()["status"] == "draft"
    withdrawn = _post(api_client, auth_headers, f"/api/operations/plans/{plan_id}/withdraw")
    assert withdrawn.status_code == 200 and withdrawn.json()["status"] == "withdrawn"
