"""Skipping an SPJ stop (wave 13): not collected, never completed, and it does not block the route."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.field import needs_you
from app.field.driver_exceptions import EXCEPTION_STORE
from app.field.spj import SPJ_STORE

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
EVIDENCE = {
    "arrival": {"photo_name": "a.png", "photo_b64": TINY_PNG, "lat": -6.17, "lng": 106.82},
    "weighing": [],
    "officer": {"name": "Petugas Uji", "photo_name": "o.png", "photo_b64": TINY_PNG},
}


def _stop(i: int) -> dict:
    return {"name": f"TPS Uji {i}", "kecamatan": "Gambir", "address": "Jl. Uji", "lat": -6.17, "lng": 106.82}


@pytest.fixture()
def spj():
    created = SPJ_STORE.create_with_stops(
        "Driver 01",
        f"SKP-{uuid4().hex[:6]}",
        "TPST Bantargebang",
        False,
        "normal",
        "uji",
        [_stop(i) for i in range(3)],
        created_by="admin",
    )
    SPJ_STORE.activate(created.spj_id, actor="admin")
    yield SPJ_STORE.get(created.spj_id)
    current = SPJ_STORE.get(created.spj_id)
    if current.status == "aktif":
        SPJ_STORE.cancel(created.spj_id, actor="admin")


def test_a_skipped_stop_is_not_completed_and_does_not_block_the_next(spj):
    SPJ_STORE.skip_stop(spj.spj_id, 0, "TPS kosong, dilaporkan 3 sopir", "dispatcher")
    current = SPJ_STORE.get(spj.spj_id)
    assert current.stops[0].status == "skipped" and current.stops[0].completed_at is None
    SPJ_STORE.complete_stop(spj.spj_id, 1, evidence=EVIDENCE, actor="driver")
    audit = [e for e in SPJ_STORE.audit_log(spj.spj_id) if e["action"] == "skip_stop"]
    assert audit[0]["actor"] == "dispatcher" and audit[0]["payload"] == {"stop_index": 0}
    with pytest.raises(ValueError, match="skipped"):
        SPJ_STORE.complete_stop(spj.spj_id, 0, evidence=EVIDENCE, actor="driver")


def test_skip_is_idempotent_and_a_completed_stop_cannot_be_skipped(spj):
    SPJ_STORE.skip_stop(spj.spj_id, 1, "jalan ditutup", "dispatcher")
    SPJ_STORE.skip_stop(spj.spj_id, 1, "jalan ditutup", "dispatcher")
    assert sum(1 for e in SPJ_STORE.audit_log(spj.spj_id) if e["action"] == "skip_stop") == 1
    SPJ_STORE.complete_stop(spj.spj_id, 0, evidence=EVIDENCE, actor="driver")
    with pytest.raises(ValueError, match="already completed"):
        SPJ_STORE.skip_stop(spj.spj_id, 0, "terlambat", "dispatcher")
    with pytest.raises(ValueError):
        SPJ_STORE.skip_stop(spj.spj_id, 9, "di luar", "dispatcher")


def test_the_spj_closes_when_only_skipped_stops_remain(spj):
    SPJ_STORE.complete_stop(spj.spj_id, 0, evidence=EVIDENCE, actor="driver")
    SPJ_STORE.complete_stop(spj.spj_id, 1, evidence=EVIDENCE, actor="driver")
    SPJ_STORE.skip_stop(spj.spj_id, 2, "TPS kosong", "dispatcher")
    current = SPJ_STORE.get(spj.spj_id)
    assert current.status == "selesai"
    assert [s.status for s in current.stops] == ["completed", "completed", "skipped"]


def test_closing_the_spj_keeps_a_skipped_stop_skipped(spj):
    SPJ_STORE.skip_stop(spj.spj_id, 0, "TPS kosong", "dispatcher")
    SPJ_STORE.complete_stop(spj.spj_id, 1, evidence=EVIDENCE, actor="driver")
    override = {"reason": "Foto bukti tidak tersedia di lokasi", "actor": "supervisor"}
    SPJ_STORE.complete(spj.spj_id, override=override, actor="supervisor")
    stops = SPJ_STORE.get(spj.spj_id).stops
    assert [s.status for s in stops] == ["skipped", "completed", "completed"]
    assert stops[0].override is None and stops[2].override is not None


def test_endpoint_needs_dispatch_create_and_answers_409(api_client, auth_headers, spj):
    path = f"/api/spj/{spj.spj_id}/stops/0/skip"
    assert api_client.post(path, json={"reason": "TPS kosong"}).status_code == 401
    assert (
        api_client.post(path, json={"reason": "TPS kosong"}, headers=auth_headers("driver")).status_code
        == 403
    )
    assert api_client.post(path, json={"reason": ""}, headers=auth_headers("dispatcher")).status_code == 422
    res = api_client.post(path, json={"reason": "TPS kosong"}, headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    assert res.json()["stops"][0]["status"] == "skipped"
    SPJ_STORE.complete_stop(spj.spj_id, 1, evidence=EVIDENCE, actor="driver")
    done = f"/api/spj/{spj.spj_id}/stops/1/skip"
    assert (
        api_client.post(done, json={"reason": "terlambat"}, headers=auth_headers("dispatcher")).status_code
        == 409
    )


def test_needs_you_offers_skip_for_an_open_empty_tps_and_drops_it_once_skipped(monkeypatch, spj):
    monkeypatch.setattr(needs_you, "_gate_peaks", lambda day, follow_ups: [])
    for _ in range(2):
        EXCEPTION_STORE.create(
            kind="tps_empty",
            truck_code=spj.truck_code,
            driver_name="Driver 01",
            reported_by="driver",
            spj_id=spj.spj_id,
            stop_index=0,
            note="",
            photo_name=None,
            photo_b64=None,
            lat=None,
            lng=None,
            approx=False,
            reported_at=None,
        )
    item = next(i for i in needs_you.needs_you()["items"] if i["spj_id"] == spj.spj_id)
    assert item["actions"] == ["skip_stop", "mark_handled"] and item["facts"]["stop_status"] == "pending"
    SPJ_STORE.skip_stop(spj.spj_id, 0, "TPS kosong", "dispatcher")
    assert not [i for i in needs_you.needs_you()["items"] if i["spj_id"] == spj.spj_id]
