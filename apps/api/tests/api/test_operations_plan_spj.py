"""Approving a day plan creates one draft SPJ per truck (wave 12, gap 1).

The draft is "Rencana {plan_id} (MODEL)": dated the plan day, one centroid stop
per distinct kecamatan, the first trip's facility as destination and the gate
slot in its note. Approval stays at-most-once, a retry repairs a draft an
earlier attempt failed to create, and an unknown facility is reported, never
defaulted.
"""

from __future__ import annotations

import concurrent.futures
from datetime import timedelta
from uuid import uuid4

import pytest

from app.api.routers import operations as ops
from app.api.state import _OPERATIONS_PLAN_STORE
from app.core.env import local_today
from app.field.spj import SPJ_STORE
from app.fleet.data import TRUCKS

SLOT = {
    "facility": "TPST Bantargebang",
    "slot_index": 36,
    "start": "09:00",
    "end": "09:15",
    "date": None,
    "depart_at": "06:00",
    "classification": "MODEL_OUTPUT",
}


def _free_trucks(n: int) -> list[str]:
    return [t["truck_code"] for t in TRUCKS if not t["is_damaged"]][:n]


def save_plan(trips: dict[str, list[tuple[str, str]]], plan_date=None, gate_slot=None) -> dict:
    """A proposed day plan with exactly these trips: truck -> [(area slug, facility)]."""
    plan_id = f"PLAN-W12-{uuid4().hex[:8]}"
    plan_date = plan_date or local_today()
    dispatches = []
    assignments = []
    for truck, legs in trips.items():
        stops = [
            {
                "order": i,
                "area": area,
                "kecamatan": area.replace("_", " ").title(),
                "shift": "pagi",
                "window": "06:00-14:00",
                "facility": facility,
                "facility_display": "RDF Rorotan" if facility == "RDF Plant Jakarta" else facility,
                "tons": 9.0,
            }
            for i, (area, facility) in enumerate(legs, start=1)
        ]
        assignments += [
            {"truck_code": truck, "area": area, "assigned_tons": 9.0, "shift": "pagi", "facility": f}
            for area, f in legs
        ]
        slot = {**gate_slot, "date": plan_date.isoformat()} if gate_slot else None
        dispatches.append(
            {
                "truck_code": truck,
                "text": f"Rencana {plan_id} · Truk {truck}\n1. Angkut",
                "fields": {
                    "template": "plan_dispatch_v1",
                    "truck_code": truck,
                    "plan_id": plan_id,
                    "plan_date": plan_date.isoformat(),
                    "stops": stops,
                    "slot": {"shift": "pagi", "window": "06:00-14:00"},
                    "gate_slot": slot,
                },
            }
        )
    payload = {
        "plan_id": plan_id,
        "status": "proposed",
        "kind": "day_plan",
        "plan_date": plan_date.isoformat(),
        "assignments": assignments,
        "dispatches": dispatches,
        "proposed_by": "dispatcher",
    }
    return _OPERATIONS_PLAN_STORE.save_proposed(plan_id, payload)


def _approve(api_client, auth_headers, plan_id: str) -> dict:
    res = api_client.post(f"/api/operations/{plan_id}/approve", headers=auth_headers("supervisor"))
    assert res.status_code == 200, res.text
    return res.json()


def _plan_spjs(plan_id: str) -> list:
    return [s for s in SPJ_STORE.list() if s.note.startswith(f"Rencana {plan_id} (MODEL)")]


def test_approval_creates_one_labelled_draft_per_truck(api_client, auth_headers):
    a, b = _free_trucks(2)
    plan = save_plan(
        {a: [("gambir", "TPST Bantargebang")], b: [("menteng", "RDF Plant Jakarta")]}, gate_slot=SLOT
    )
    body = _approve(api_client, auth_headers, plan["plan_id"])

    drafts = {d["truck_code"]: d for d in body["spj_drafts"]}
    assert set(drafts) == {a, b}
    for truck, destination in ((a, "TPST Bantargebang"), (b, "RDF Plant Jakarta")):
        entry = drafts[truck]
        spj = SPJ_STORE.get(entry["spj_id"])
        assert entry["status"] == "draft" == spj.status
        assert entry["spj_number"] == spj.spj_number
        assert entry["gate_slot"]["start"] == "09:00"
        assert spj.destination == destination
        assert spj.truck_code == truck
        assert spj.created_by == "supervisor"
        assert spj.priority == "normal" and spj.weigh_on_site is False
        assert spj.driver_name == next(t["driver_name"] for t in TRUCKS if t["truck_code"] == truck)
        assert spj.note.startswith(f"Rencana {plan['plan_id']} (MODEL) · fasilitas: ")
        assert spj.note.endswith("· slot gerbang 09:00–09:15")
        stop = spj.stops[0]
        assert stop.location_type == "Titik Rencana (centroid kecamatan)"
        assert "perencanaan, bukan alamat TPS" in stop.address
        assert stop.name.startswith("Rencana · Kec. ")


def test_two_trips_to_the_same_area_give_one_stop_in_first_trip_order(api_client, auth_headers):
    (a,) = _free_trucks(1)
    plan = save_plan(
        {
            a: [
                ("senen", "TPST Bantargebang"),
                ("gambir", "RDF Plant Jakarta"),
                ("senen", "TPST Bantargebang"),
            ]
        }
    )
    body = _approve(api_client, auth_headers, plan["plan_id"])
    spj = SPJ_STORE.get(body["spj_drafts"][0]["spj_id"])
    assert [s.kecamatan for s in spj.stops] == ["Senen", "Gambir"]
    assert spj.destination == "TPST Bantargebang"  # the first trip's facility
    assert "fasilitas: TPST Bantargebang, RDF Rorotan" in spj.note
    assert "slot gerbang" not in spj.note  # no slot assigned: none is claimed


def test_unknown_facility_is_skipped_and_reported_not_defaulted(api_client, auth_headers):
    a, b = _free_trucks(2)
    plan = save_plan({a: [("gambir", "TPA Tidak Dikenal")], b: [("menteng", "TPST Bantargebang")]})
    body = _approve(api_client, auth_headers, plan["plan_id"])
    drafts = {d["truck_code"]: d for d in body["spj_drafts"]}
    assert drafts[a]["spj_id"] is None
    assert drafts[a]["skipped"] == "unknown_facility:TPA Tidak Dikenal"
    assert drafts[b]["spj_id"]
    assert [s.truck_code for s in _plan_spjs(plan["plan_id"])] == [b]


def test_concurrent_double_approve_gives_exactly_one_spj_per_truck(api_client, auth_headers):
    trucks = _free_trucks(3)
    plan = save_plan({t: [("kemayoran", "TPST Bantargebang")] for t in trucks})

    def approve(_):
        res = api_client.post(
            f"/api/operations/{plan['plan_id']}/approve", headers=auth_headers("supervisor")
        )
        return res.status_code, res.json()

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(approve, range(4)))
    assert all(status == 200 for status, _ in results)
    spjs = _plan_spjs(plan["plan_id"])
    assert sorted(s.truck_code for s in spjs) == sorted(trucks)
    ids = {tuple(sorted(d["spj_id"] for d in body["spj_drafts"])) for _, body in results}
    assert ids == {tuple(sorted(s.spj_id for s in spjs))}


def test_a_failed_draft_keeps_the_approval_and_a_retry_repairs_it(api_client, auth_headers, monkeypatch):
    (a,) = _free_trucks(1)
    plan = save_plan({a: [("cempaka_putih", "TPST Bantargebang")]})
    real_create = SPJ_STORE.create_with_stops

    def failing(*args, **kwargs):
        raise RuntimeError("simulated SPJ store failure")

    monkeypatch.setattr(SPJ_STORE, "create_with_stops", failing)
    first = _approve(api_client, auth_headers, plan["plan_id"])
    assert first["status"] == "approved"
    assert first["spj_drafts"][0]["spj_id"] is None
    assert "simulated SPJ store failure" in first["spj_drafts"][0]["error"]

    monkeypatch.setattr(SPJ_STORE, "create_with_stops", real_create)
    second = _approve(api_client, auth_headers, plan["plan_id"])
    assert second["dispatch_ids"] == first["dispatch_ids"]
    assert second["spj_drafts"][0]["spj_id"]
    assert "error" not in second["spj_drafts"][0]
    assert len(_plan_spjs(plan["plan_id"])) == 1


def test_an_orphan_draft_is_adopted_not_duplicated(api_client, auth_headers, monkeypatch):
    """The SPJ committed but the link row did not: the retry adopts it by its note."""
    (a,) = _free_trucks(1)
    plan = save_plan({a: [("sawah_besar", "TPST Bantargebang")]})
    real_create = SPJ_STORE.create_with_stops

    def create_then_fail(*args, **kwargs):
        real_create(*args, **kwargs)
        raise RuntimeError("crash after the SPJ commit")

    monkeypatch.setattr(SPJ_STORE, "create_with_stops", create_then_fail)
    first = _approve(api_client, auth_headers, plan["plan_id"])
    assert first["spj_drafts"][0]["spj_id"] is None
    orphan = _plan_spjs(plan["plan_id"])
    assert len(orphan) == 1

    monkeypatch.setattr(SPJ_STORE, "create_with_stops", real_create)
    second = _approve(api_client, auth_headers, plan["plan_id"])
    assert second["spj_drafts"][0]["spj_id"] == orphan[0].spj_id
    assert len(_plan_spjs(plan["plan_id"])) == 1


def test_draft_is_dated_the_plan_day(api_client, auth_headers):
    (a,) = _free_trucks(1)
    tomorrow = local_today() + timedelta(days=1)
    plan = save_plan({a: [("gambir", "TPST Bantargebang")]}, plan_date=tomorrow)
    body = _approve(api_client, auth_headers, plan["plan_id"])
    spj = SPJ_STORE.get(body["spj_drafts"][0]["spj_id"])
    assert spj.date == tomorrow.isoformat()
    assert spj.spj_number.startswith(tomorrow.strftime("DLH-DKI/SPJ/%d-%m-%Y/"))


def test_spj_list_by_truck_shows_the_model_note(api_client, auth_headers):
    (a,) = _free_trucks(1)
    plan = save_plan({a: [("menteng", "TPST Bantargebang")]})
    _approve(api_client, auth_headers, plan["plan_id"])
    res = api_client.get(f"/api/spj?truck_code={a}", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    notes = [s["note"] for s in res.json()["spj"]]
    assert any(n.startswith(f"Rencana {plan['plan_id']} (MODEL)") for n in notes)


def test_get_plan_by_id_reports_the_drafts(api_client, auth_headers):
    (a,) = _free_trucks(1)
    plan = save_plan({a: [("gambir", "TPST Bantargebang")]})
    approved = _approve(api_client, auth_headers, plan["plan_id"])
    res = api_client.get(f"/api/operations/plans/{plan['plan_id']}", headers=auth_headers("dispatcher"))
    assert res.json()["spj_drafts"] == approved["spj_drafts"]


@pytest.fixture()
def fixed_gate_slot(monkeypatch):
    def fake(dispatches, plan_date, occupied=()):
        return {d["truck_code"]: {**SLOT, "date": plan_date.isoformat()} for d in dispatches}

    monkeypatch.setattr(ops, "assign_gate_slots", fake)


def test_built_plan_carries_the_gate_slot_in_fields_and_text(api_client, auth_headers, fixed_gate_slot):
    created = api_client.post("/api/operations/plan?top_n=2", headers=auth_headers("dispatcher"))
    assert created.status_code == 200, created.text
    for dispatch in created.json()["dispatches"]:
        assert dispatch["fields"]["gate_slot"]["classification"] == "MODEL_OUTPUT"
        assert dispatch["fields"]["slot"]["shift"]  # the shift slot stays
        assert dispatch["text"].endswith(
            "\nBerangkat 06:00 · Slot gerbang TPST Bantargebang 09:00–09:15 (keluaran model)"
        )


def test_without_a_slot_the_text_claims_none(api_client, auth_headers, monkeypatch):
    monkeypatch.setattr(ops, "assign_gate_slots", lambda *a, **k: {})
    created = api_client.post("/api/operations/plan?top_n=2", headers=auth_headers("dispatcher"))
    for dispatch in created.json()["dispatches"]:
        assert dispatch["fields"]["gate_slot"] is None
        assert "Slot gerbang" not in dispatch["text"]
        assert "Berangkat" not in dispatch["text"]


def test_the_modelled_slot_reads_back_as_departure_and_gate_window(api_client, auth_headers):
    """With the real slot model, every slotted dispatch says when to leave and when it reaches the gate."""
    created = api_client.post("/api/operations/plan?top_n=2", headers=auth_headers("dispatcher"))
    assert created.status_code == 200, created.text
    dispatches = created.json()["dispatches"]
    assert any(d["fields"]["gate_slot"] for d in dispatches)
    for dispatch in dispatches:
        slot = dispatch["fields"]["gate_slot"]
        if slot is None:
            continue
        line = dispatch["text"].splitlines()[-1]
        assert line.startswith(f"Berangkat {slot['depart_at']} · Slot gerbang ")
        assert f"{slot['start']}–{slot['end']}" in line and line.endswith("(keluaran model)")
