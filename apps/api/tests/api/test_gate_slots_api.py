"""GET /api/gate/slots and accepting a hold recommendation (wave 12 gap 3)."""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.fleet import gate_slots
from app.fleet.gate_slots import CAPACITY_PER_SLOT

PAGI = ("pagi", "06:00-14:00")
MALAM = ("malam", "22:00-06:00")


@pytest.fixture()
def background(monkeypatch):
    """Simulated background arrivals per clock hour (default: an empty gate)."""
    hours = [0.0] * 24
    monkeypatch.setattr(gate_slots, "_background_by_hour", lambda: list(hours))
    return hours


@pytest.fixture()
def day():
    """A day no other test plans for, so the store shared by the session stays out of the way."""
    return date(2032, 1, 1) + timedelta(days=uuid.uuid4().int % 3000)


def _dispatch(truck_code, plan_day, shift=PAGI, facility="TPST Bantargebang", gate_slot=...):
    fields = {
        "plan_date": plan_day.isoformat(),
        "stops": [{"order": 1, "shift": shift[0], "window": shift[1], "facility": facility}],
    }
    if gate_slot is not ...:
        fields["gate_slot"] = gate_slot
    return {"truck_code": truck_code, "text": f"Rencana uji · Truk {truck_code}", "fields": fields}


def _approve_plan(plan_day, dispatches):
    plan_id = f"GS-{uuid.uuid4().hex[:8]}"
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id,
        {"plan_id": plan_id, "plan_date": plan_day.isoformat(), "assignments": [], "dispatches": dispatches},
    )
    _OPERATIONS_PLAN_STORE.approve(
        plan_id,
        approved_by="supervisor",
        create_dispatch=lambda item: history_store.save_dispatch(item["truck_code"], item["text"], "test"),
    )
    return plan_id


def _slot_at_nine(plan_day):
    return {
        "facility": "TPST Bantargebang",
        "slot_index": 36,
        "start": "09:00",
        "end": "09:15",
        "date": plan_day.isoformat(),
        "classification": "MODEL_OUTPUT",
    }


def _board(api_client, auth_headers, slot_day):
    res = api_client.get(f"/api/gate/slots?date={slot_day.isoformat()}", headers=auth_headers())
    assert res.status_code == 200, res.text
    return res.json()


def test_day_without_an_approved_plan_has_no_recommendation(api_client, auth_headers, background, day):
    board = _board(api_client, auth_headers, day)
    assert board["recommendations"] == []
    assert board["reason"] == "no_approved_plan"
    assert board["slots"] == []
    assert board["classification"] == "SIMULATED"
    assert board["capacity_per_slot"] == CAPACITY_PER_SLOT
    assert board["source"] == "approved plan gate slots + simulated background arrivals (queue_simulation)"


def test_overloaded_slot_gets_holds_and_an_accepted_hold_reaches_the_driver(
    api_client, auth_headers, background, day
):
    trucks = [f"GS{i:03d}-{uuid.uuid4().hex[:4]}" for i in range(int(CAPACITY_PER_SLOT) + 2)]
    _approve_plan(day, [_dispatch(t, day, gate_slot=_slot_at_nine(day)) for t in trucks])

    board = _board(api_client, auth_headers, day)
    assert board["reason"] is None
    recs = board["recommendations"]
    assert len(recs) == 2
    rec = recs[0]
    assert rec["from_slot"] == "09:00" and rec["to_slot"] == "09:15" and rec["hold_minutes"] == 15
    assert rec["accepted"] is False

    accepted = api_client.post(f"/api/gate/slots/recommendations/{rec['id']}/accept", headers=auth_headers())
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert body["rec_id"] == rec["id"] and body["truck_code"] == rec["truck_code"]
    assert body["new_slot"]["start"] == "09:15" and body["new_slot"]["end"] == "09:30"

    pending = api_client.get(f"/api/dispatch/{rec['truck_code']}", headers=auth_headers("driver")).json()
    hold = next(d for d in pending if d["id"] == body["dispatch_id"])
    assert hold["instruction"] == "Tahan keberangkatan 15 menit; slot gerbang baru 09:15–09:30 (simulasi)"
    assert hold["field_status"] == "PENDING"

    again = api_client.post(f"/api/gate/slots/recommendations/{rec['id']}/accept", headers=auth_headers())
    assert again.status_code == 200
    assert again.json()["dispatch_id"] == body["dispatch_id"]
    holds = [
        d for d in history_store.pending_dispatches(rec["truck_code"]) if d["instruction"].startswith("Tahan")
    ]
    assert len(holds) == 1

    marked = next(r for r in _board(api_client, auth_headers, day)["recommendations"] if r["id"] == rec["id"])
    assert marked["accepted"] is True and marked["dispatch_id"] == body["dispatch_id"]
    events = [
        e
        for e in history_store.list_events(limit=200)
        if e["event_type"] == "gate_slot_recommendation_accepted"
    ]
    assert any(e["payload"]["rec_id"] == rec["id"] for e in events)


def test_underloaded_day_produces_no_recommendation(api_client, auth_headers, background, day):
    _approve_plan(
        day, [_dispatch(f"GS-{uuid.uuid4().hex[:6]}", day, gate_slot=_slot_at_nine(day)) for _ in range(5)]
    )
    board = _board(api_client, auth_headers, day)
    assert board["recommendations"] == [] and board["reason"] is None
    assert len(board["slots"][0]["planned_trucks"]) == 5


def test_plans_without_stored_slots_get_them_in_approval_order(api_client, auth_headers, background, day):
    background[9] = (CAPACITY_PER_SLOT - 1) * 4  # one free place per 09:xx slot
    first, second = f"GS-A{uuid.uuid4().hex[:5]}", f"GS-B{uuid.uuid4().hex[:5]}"
    _approve_plan(day, [_dispatch(first, day)])
    _approve_plan(day, [_dispatch(second, day)])
    slots = {s["start"]: s["planned_trucks"] for s in _board(api_client, auth_headers, day)["slots"]}
    assert slots["09:00"] == [first]
    assert slots["09:15"] == [second]


def test_night_shift_truck_appears_on_the_next_days_board(api_client, auth_headers, background, day):
    truck = f"GS-N{uuid.uuid4().hex[:5]}"
    _approve_plan(day, [_dispatch(truck, day, shift=MALAM)])
    assert _board(api_client, auth_headers, day)["slots"] == []
    next_day = _board(api_client, auth_headers, day + timedelta(days=1))
    assert next_day["slots"][0]["start"] == "01:00"
    assert next_day["slots"][0]["planned_trucks"] == [truck]


def test_rdf_truck_is_listed_apart_and_adds_no_weighbridge_load(api_client, auth_headers, background, day):
    rdf, tpa = f"GS-R{uuid.uuid4().hex[:5]}", f"GS-T{uuid.uuid4().hex[:5]}"
    _approve_plan(day, [_dispatch(rdf, day, facility="RDF Rorotan"), _dispatch(tpa, day)])
    board = _board(api_client, auth_headers, day)
    assert [o["truck_code"] for o in board["other_facilities"]] == [rdf]
    assert board["other_facilities"][0]["capacity_model"] is None
    assert [t for s in board["slots"] for t in s["planned_trucks"]] == [tpa]


def test_unknown_or_malformed_recommendation_is_404(api_client, auth_headers, background, day):
    stale = f"rec-{day.isoformat()}-T-031-36"
    assert (
        api_client.post(f"/api/gate/slots/recommendations/{stale}/accept", headers=auth_headers()).status_code
        == 404
    )
    assert (
        api_client.post("/api/gate/slots/recommendations/nope/accept", headers=auth_headers()).status_code
        == 404
    )


def test_gate_slots_need_a_token_and_the_right_role(api_client, auth_headers, day):
    assert api_client.get("/api/gate/slots").status_code == 401
    assert api_client.get("/api/gate/slots", headers=auth_headers("driver")).status_code == 403
    url = f"/api/gate/slots/recommendations/rec-{day.isoformat()}-T-031-36/accept"
    assert api_client.post(url).status_code == 401
    assert api_client.post(url, headers=auth_headers("driver")).status_code == 403


def test_concurrent_accepts_create_one_dispatch(api_client, auth_headers, background, day):
    from concurrent.futures import ThreadPoolExecutor

    trucks = [f"GS-C{i:02d}{uuid.uuid4().hex[:4]}" for i in range(int(CAPACITY_PER_SLOT) + 1)]
    _approve_plan(day, [_dispatch(t, day, gate_slot=_slot_at_nine(day)) for t in trucks])
    rec = _board(api_client, auth_headers, day)["recommendations"][0]
    url = f"/api/gate/slots/recommendations/{rec['id']}/accept"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: api_client.post(url, headers=auth_headers()), range(4)))
    assert {r.status_code for r in results} == {200}
    assert len({r.json()["dispatch_id"] for r in results}) == 1
    assert len(history_store.pending_dispatches(rec["truck_code"])) == 2  # the plan's own + one hold
