"""POST /api/operations/{plan_id}/reassign moves one truck's plan share to another truck.

The old dispatch becomes REASSIGNED (a replayed READY from the driver outbox
gets 409), the instruction and the draft SPJ move with an audit entry, and a
damaged, duty-blocked or already-planned target is refused.
"""

from __future__ import annotations

import concurrent.futures
import sqlite3
from uuid import uuid4

import pytest

from app.api.state import _OPERATIONS_PLAN_STORE, dispatch_center, history_store
from app.core.env import local_today
from app.field import safety
from app.field.spj import SPJ_STORE
from app.fleet.data import TRUCKS


def _free_trucks(n: int) -> list[str]:
    return [t["truck_code"] for t in TRUCKS if not t["is_damaged"]][:n]


def _approved_plan(api_client, auth_headers, trucks: list[str]) -> dict:
    plan_id = f"PLAN-W12R-{uuid4().hex[:8]}"
    day = local_today().isoformat()
    dispatches = [
        {
            "truck_code": truck,
            "text": f"Rencana {plan_id} · {day} · Truk {truck}\n1. Shift pagi: angkut dari Kec. Gambir",
            "fields": {
                "template": "plan_dispatch_v1",
                "truck_code": truck,
                "plan_id": plan_id,
                "plan_date": day,
                "stops": [
                    {
                        "order": 1,
                        "area": "gambir",
                        "kecamatan": "Gambir",
                        "shift": "pagi",
                        "window": "06:00-14:00",
                        "facility": "TPST Bantargebang",
                        "facility_display": "TPST Bantargebang",
                        "tons": 9.0,
                    }
                ],
                "slot": {"shift": "pagi", "window": "06:00-14:00"},
                "gate_slot": None,
            },
        }
        for truck in trucks
    ]
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id,
        {
            "plan_id": plan_id,
            "status": "proposed",
            "kind": "day_plan",
            "plan_date": day,
            "assignments": [{"truck_code": t, "area": "gambir", "assigned_tons": 9.0} for t in trucks],
            "dispatches": dispatches,
        },
    )
    res = api_client.post(f"/api/operations/{plan_id}/approve", headers=auth_headers("supervisor"))
    assert res.status_code == 200, res.text
    return res.json()


def _reassign(api_client, headers, plan_id, from_truck, to_truck, reason="Truk mogok di pool"):
    return api_client.post(
        f"/api/operations/{plan_id}/reassign",
        json={"from_truck": from_truck, "to_truck": to_truck, "reason": reason},
        headers=headers,
    )


def test_reassign_moves_dispatch_instruction_and_draft_spj(api_client, auth_headers):
    a, b, target = _free_trucks(3)
    plan = _approved_plan(api_client, auth_headers, [a, b])
    old_dispatch_id = plan["dispatch_ids"][0]
    spj_id = next(d["spj_id"] for d in plan["spj_drafts"] if d["truck_code"] == a)

    res = _reassign(api_client, auth_headers("dispatcher"), plan["plan_id"], a, target)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["plan_id"] == plan["plan_id"]
    assert (body["from_truck"], body["to_truck"]) == (a, target)
    assert body["cancelled_dispatch_id"] == old_dispatch_id
    assert body["spj_id"] == spj_id
    new_dispatch_id = body["dispatch_id"]

    # The instruction is listed for the new truck; the old truck has none pending.
    headers = auth_headers("dispatcher")
    moved = api_client.get(f"/api/operations/instructions/{target}", headers=headers).json()
    assert [i["dispatch_id"] for i in moved if i["plan_id"] == plan["plan_id"]] == [new_dispatch_id]
    assert moved[-1]["fields"]["truck_code"] == target
    left = api_client.get(f"/api/operations/instructions/{a}", headers=headers).json()
    assert [i for i in left if i["plan_id"] == plan["plan_id"]] == []
    pending = api_client.get(f"/api/dispatch/{target}", headers=headers).json()
    new_row = next(d for d in pending if d["id"] == new_dispatch_id)
    assert f"Truk {target}" in new_row["instruction"]
    assert f"Dialihkan dari Truk {a}." in new_row["instruction"]
    assert history_store.get_dispatch(old_dispatch_id)["field_status"] == "REASSIGNED"

    # The in-memory dispatch mirror swapped the entry.
    mirror_ids = {d["id"] for d in dispatch_center._dispatches}
    assert new_dispatch_id in mirror_ids and old_dispatch_id not in mirror_ids

    # The draft SPJ moved, with an audit entry naming who and why.
    spj = SPJ_STORE.get(spj_id)
    assert spj.truck_code == target and spj.status == "draft"
    assert spj.driver_name == next(t["driver_name"] for t in TRUCKS if t["truck_code"] == target)
    audit = [e for e in SPJ_STORE.audit_log(spj_id) if e["action"] == "reassign"]
    assert audit and audit[-1]["actor"] == "dispatcher"
    assert audit[-1]["reason"] == "Truk mogok di pool"
    assert audit[-1]["payload"]["from_truck"] == a

    # The plan reads back with the new truck and its draft.
    stored = api_client.get(f"/api/operations/plans/{plan['plan_id']}", headers=headers).json()
    assert {d["truck_code"] for d in stored["dispatches"]} == {b, target}
    assert new_dispatch_id in stored["dispatch_ids"] and old_dispatch_id not in stored["dispatch_ids"]
    assert {d["truck_code"]: d["spj_id"] for d in stored["spj_drafts"]}[target] == spj_id

    events = [e for e in history_store.list_events(200) if e["event_type"] == "operations_plan_reassigned"]
    assert any(e["payload"]["dispatch_id"] == new_dispatch_id for e in events)


def test_a_ready_on_the_reassigned_dispatch_gets_409(api_client, auth_headers):
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    old_dispatch_id = plan["dispatch_ids"][0]
    assert _reassign(api_client, auth_headers("dispatcher"), plan["plan_id"], a, target).status_code == 200

    res = api_client.post(
        f"/api/dispatch/{old_dispatch_id}/confirm",
        json={"status": "READY", "operation_id": f"op-{uuid4().hex}"},
        headers=auth_headers("driver"),
    )
    assert res.status_code == 409
    assert history_store.get_dispatch(old_dispatch_id)["field_status"] == "REASSIGNED"


def test_a_replayed_operation_recorded_before_the_move_returns_the_stored_state(api_client, auth_headers):
    """#44 replay semantics hold: an already-recorded operation id is not a new write, even after a move."""
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    old_dispatch_id = plan["dispatch_ids"][0]
    op = f"op-{uuid4().hex}"
    body = {"status": "READY", "operation_id": op}
    first = api_client.post(
        f"/api/dispatch/{old_dispatch_id}/confirm", json=body, headers=auth_headers("driver")
    )
    assert first.status_code == 200
    assert _reassign(api_client, auth_headers("dispatcher"), plan["plan_id"], a, target).status_code == 200
    replay = api_client.post(
        f"/api/dispatch/{old_dispatch_id}/confirm", json=body, headers=auth_headers("driver")
    )
    # The outbox entry drains (no 409 retry loop) and reads the current state.
    assert replay.status_code == 200
    assert replay.json()["field_status"] == "REASSIGNED"
    events = [e for e in history_store.list_events(200) if e["event_type"] == "dispatch_confirmed"]
    assert sum(e["payload"]["dispatch_id"] == old_dispatch_id for e in events) == 1


def test_reassign_onto_a_duty_blocked_truck_gets_409(api_client, auth_headers, monkeypatch):
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    real = safety.duty_check

    def blocked(truck_code, now=None):
        if truck_code == target:
            return {"blocked": True, "reason": "batas jam kerja", "duty_minutes": 730, "override": None}
        return real(truck_code, now)

    monkeypatch.setattr(safety, "duty_check", blocked)
    res = _reassign(api_client, auth_headers("dispatcher"), plan["plan_id"], a, target)
    assert res.status_code == 409
    assert history_store.get_dispatch(plan["dispatch_ids"][0])["field_status"] == "PENDING"


def test_reassign_onto_a_damaged_or_planned_truck_gets_409(api_client, auth_headers):
    a, b = _free_trucks(2)
    damaged = next(t["truck_code"] for t in TRUCKS if t["is_damaged"])
    plan = _approved_plan(api_client, auth_headers, [a, b])
    headers = auth_headers("dispatcher")
    assert _reassign(api_client, headers, plan["plan_id"], a, damaged).status_code == 409
    assert _reassign(api_client, headers, plan["plan_id"], a, b).status_code == 409


def test_reassign_of_an_active_spj_gets_409_with_guidance(api_client, auth_headers):
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    spj = SPJ_STORE.get(plan["spj_drafts"][0]["spj_id"])
    spj.status = "aktif"
    SPJ_STORE._commit(spj)
    try:
        res = _reassign(api_client, auth_headers("dispatcher"), plan["plan_id"], a, target)
        assert res.status_code == 409
        # A coded refusal: the console says it in its own language (lx_err_spj_started).
        assert res.json()["detail"]["code"] == "spj_started"
        assert history_store.get_dispatch(plan["dispatch_ids"][0])["field_status"] == "PENDING"
    finally:
        SPJ_STORE.cancel(spj.spj_id, actor="test")


def test_reassign_needs_an_approved_plan_and_known_trucks(api_client, auth_headers):
    a, b, target = _free_trucks(3)
    headers = auth_headers("dispatcher")
    proposed = api_client.post("/api/operations/plan?top_n=2", headers=headers).json()
    some_truck = proposed["dispatches"][0]["truck_code"]
    assert _reassign(api_client, headers, proposed["plan_id"], some_truck, target).status_code == 409
    assert _reassign(api_client, headers, "PLAN-NOPE", a, target).status_code == 404
    plan = _approved_plan(api_client, auth_headers, [a])
    assert _reassign(api_client, headers, plan["plan_id"], a, "T-NOPE").status_code == 404
    assert _reassign(api_client, headers, plan["plan_id"], b, target).status_code == 404


@pytest.mark.parametrize("role, status", [("driver", 403), (None, 401)])
def test_reassign_requires_dispatch_create(api_client, auth_headers, role, status):
    a, target = _free_trucks(2)
    headers = auth_headers(role) if role else {}
    assert _reassign(api_client, headers, "PLAN-ANY", a, target).status_code == status


def test_reason_is_required_and_bounded(api_client, auth_headers):
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    headers = auth_headers("dispatcher")
    assert _reassign(api_client, headers, plan["plan_id"], a, target, reason="").status_code == 422
    assert _reassign(api_client, headers, plan["plan_id"], a, target, reason="x" * 201).status_code == 422


def _plan_dispatches_for(truck: str, plan_id: str) -> list[dict]:
    return [
        d for d in history_store.list_dispatches() if d["truck_code"] == truck and plan_id in d["instruction"]
    ]


def _reassigned_events(plan_id: str) -> list[dict]:
    return [
        e
        for e in history_store.list_events(200)
        if e["event_type"] == "operations_plan_reassigned" and e["payload"]["plan_id"] == plan_id
    ]


@pytest.mark.parametrize("step", ["after_save_before_plan_move", "after_plan_move_before_mark_old"])
def test_an_interrupted_reassign_resumes_with_exactly_one_new_dispatch(
    api_client, auth_headers, monkeypatch, step
):
    """Fail after the new dispatch is saved and before the old one is marked: the retry completes.

    The reassign row (and its pre-chosen dispatch id) exists before the dispatch
    is saved, so the retry resumes from it instead of saving a second dispatch.
    """
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    old_dispatch_id = plan["dispatch_ids"][0]
    headers = auth_headers("dispatcher")

    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    if step == "after_save_before_plan_move":
        monkeypatch.setattr(_OPERATIONS_PLAN_STORE, "reassign_truck", boom)
    else:
        monkeypatch.setattr(history_store, "mark_dispatch_reassigned", boom)
    failed = _reassign(api_client, headers, plan["plan_id"], a, target)
    assert failed.status_code == 503
    assert len(_plan_dispatches_for(target, plan["plan_id"])) == 1  # the new dispatch was saved
    assert history_store.get_dispatch(old_dispatch_id)["field_status"] == "PENDING"
    record = _OPERATIONS_PLAN_STORE.reassign_row(plan["plan_id"], a)
    assert record["to_truck"] == target
    assert record["status"] == ("claimed" if step == "after_save_before_plan_move" else "moved")
    monkeypatch.undo()
    dispatch_count = len(history_store.list_dispatches())

    retried = _reassign(api_client, headers, plan["plan_id"], a, target)
    assert retried.status_code == 200, retried.text
    assert len(history_store.list_dispatches()) == dispatch_count
    assert retried.json()["dispatch_id"] == record["new_dispatch_id"]
    new_rows = _plan_dispatches_for(target, plan["plan_id"])
    assert [r["id"] for r in new_rows] == [retried.json()["dispatch_id"]]
    assert history_store.get_dispatch(old_dispatch_id)["field_status"] == "REASSIGNED"
    moved = api_client.get(f"/api/operations/instructions/{target}", headers=headers).json()
    assert [i["dispatch_id"] for i in moved if i["plan_id"] == plan["plan_id"]] == [new_rows[0]["id"]]
    assert SPJ_STORE.get(retried.json()["spj_id"]).truck_code == target
    assert len(_reassigned_events(plan["plan_id"])) == 1


def test_a_repeated_reassign_is_idempotent_and_a_conflicting_one_409(api_client, auth_headers):
    a, target, other = _free_trucks(3)
    plan = _approved_plan(api_client, auth_headers, [a])
    headers = auth_headers("dispatcher")
    first = _reassign(api_client, headers, plan["plan_id"], a, target)
    again = _reassign(api_client, headers, plan["plan_id"], a, target)
    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()
    assert len(_plan_dispatches_for(target, plan["plan_id"])) == 1
    assert len(_reassigned_events(plan["plan_id"])) == 1
    assert len([e for e in SPJ_STORE.audit_log(first.json()["spj_id"]) if e["action"] == "reassign"]) == 1
    assert _reassign(api_client, headers, plan["plan_id"], a, other).status_code == 409


def test_two_identical_concurrent_reassigns_make_exactly_one_new_dispatch(api_client, auth_headers):
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    headers = auth_headers("dispatcher")

    def move(_):
        res = _reassign(api_client, headers, plan["plan_id"], a, target)
        return res.status_code, res.json()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(move, range(2)))
    assert [status for status, _ in results] == [200, 200]
    assert results[0][1] == results[1][1]
    assert [d["id"] for d in _plan_dispatches_for(target, plan["plan_id"])] == [results[0][1]["dispatch_id"]]
    assert history_store.get_dispatch(plan["dispatch_ids"][0])["field_status"] == "REASSIGNED"
    assert len(_reassigned_events(plan["plan_id"])) == 1


def test_a_storage_failure_while_recording_the_reassign_is_503_and_the_retry_completes(
    api_client, auth_headers, monkeypatch
):
    a, target = _free_trucks(2)
    plan = _approved_plan(api_client, auth_headers, [a])
    headers = auth_headers("dispatcher")

    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(_OPERATIONS_PLAN_STORE, "claim_reassign", boom)
    failed = _reassign(api_client, headers, plan["plan_id"], a, target)
    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "reassign_incomplete"
    assert _plan_dispatches_for(target, plan["plan_id"]) == []
    assert history_store.get_dispatch(plan["dispatch_ids"][0])["field_status"] == "PENDING"
    monkeypatch.undo()

    retried = _reassign(api_client, headers, plan["plan_id"], a, target)
    assert retried.status_code == 200, retried.text
    assert [d["id"] for d in _plan_dispatches_for(target, plan["plan_id"])] == [retried.json()["dispatch_id"]]
    # The SPJ moved in the failed attempt; the retry does not move or audit it twice.
    assert len([e for e in SPJ_STORE.audit_log(retried.json()["spj_id"]) if e["action"] == "reassign"]) == 1
