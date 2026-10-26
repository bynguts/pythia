"""/api/fleet/drivers-week: per-driver week figures from field records, null where none exist."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.core.env import local_today
from app.field import safety
from app.field.drivers_week import drivers_week
from app.field.spj import SPJ_STORE

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
STOP = {"name": "TPS Uji", "kecamatan": "Gambir", "address": "Jl. Uji 1", "lat": -6.17, "lng": 106.82}
EVIDENCE = {
    "arrival": {"photo_name": "a.png", "photo_b64": TINY_PNG, "lat": -6.17, "lng": 106.82},
    "weighing": [],
    "officer": {"name": "Petugas Uji", "photo_name": "o.png", "photo_b64": TINY_PNG},
}


@pytest.fixture()
def driver() -> str:
    return f"Driver W{uuid4().hex[:6]}"


def _row(driver: str) -> dict:
    return next(d for d in drivers_week(7, local_today())["drivers"] if d["driver_name"] == driver)


def _trip(driver: str, truck: str, note: str = "uji", *, proof: bool = True, receipt: bool = True):
    spj = SPJ_STORE.create_with_stops(
        driver,
        truck,
        "TPST Bantargebang",
        False,
        "normal",
        note,
        [dict(STOP), {**STOP, "name": "TPS Uji 2"}],
        created_by="admin",
    )
    SPJ_STORE.activate(spj.spj_id, actor="admin")
    SPJ_STORE.complete_stop(spj.spj_id, 0, evidence=EVIDENCE, actor="driver")
    if proof:
        SPJ_STORE.complete_stop(spj.spj_id, 1, evidence=EVIDENCE, actor="driver")
    else:
        SPJ_STORE.complete_stop(
            spj.spj_id,
            1,
            override={"reason": "Foto bukti tidak tersedia", "actor": "supervisor"},
            actor="supervisor",
        )
    if receipt:
        SPJ_STORE.record_receipt(spj.spj_id, "r.png", TINY_PNG, 15_000.0, "manual", tare_weight_kg=9_000.0)
    return SPJ_STORE.get(spj.spj_id)


def test_needs_history_read(api_client, auth_headers):
    assert api_client.get("/api/fleet/drivers-week").status_code == 401
    assert api_client.get("/api/fleet/drivers-week", headers=auth_headers("driver")).status_code == 403
    res = api_client.get("/api/fleet/drivers-week?days=7", headers=auth_headers("dispatcher"))
    assert res.status_code == 200
    body = res.json()
    assert body["window_days"] == 7 and body["classification"] == "FIELD"
    assert (
        api_client.get("/api/fleet/drivers-week?days=99", headers=auth_headers("dispatcher")).status_code
        == 422
    )


def test_trips_proof_and_duty_from_the_driver_records(driver):
    truck = f"DW-{uuid4().hex[:6]}"
    _trip(driver, truck)
    _trip(driver, truck, proof=False)
    _trip(driver, truck, receipt=False)
    row = _row(driver)
    assert row["truck_code"] == truck
    assert row["trips"] == 2  # the third SPJ has no receipt
    assert row["completed_stops"] == 6 and row["proof_complete_pct"] == round(5 / 6 * 100, 1)
    assert row["on_time_pct"] is None and row["on_time_n"] == 0  # no plan slot
    assert row["avg_duty_min"] is not None and row["duty_days"] == 1
    assert row["sample_days"] == 1


def test_on_time_compares_the_gate_arrival_with_the_planned_slot_end(driver):
    truck = f"DW-{uuid4().hex[:6]}"
    plan_id = f"PLN-{uuid4().hex[:8]}"
    now = datetime.now(UTC)
    wib = now.astimezone(safety.WIB)
    end = (wib + timedelta(minutes=30)).strftime("%H:%M")
    start = (wib + timedelta(minutes=15)).strftime("%H:%M")
    item = {
        "truck_code": truck,
        "text": f"Rencana {plan_id} · Truk {truck}",
        "fields": {"gate_slot": {"date": wib.date().isoformat(), "start": start, "end": end}},
    }
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id,
        {"plan_id": plan_id, "plan_date": wib.date().isoformat(), "assignments": [], "dispatches": [item]},
    )
    _OPERATIONS_PLAN_STORE.approve(
        plan_id, "supervisor", lambda i: history_store.save_dispatch(i["truck_code"], i["text"], "test")
    )
    early = _trip(driver, truck, f"Rencana {plan_id} (MODEL)", receipt=False)
    SPJ_STORE.record_gate_arrival(early.spj_id, "driver", now.isoformat())
    row = _row(driver)
    if end > start:  # skip the minute around midnight
        assert row["on_time_pct"] == 100.0 and row["on_time_n"] == 1


def test_a_driver_without_records_is_absent(driver):
    assert all(d["driver_name"] != driver for d in drivers_week(7, local_today())["drivers"])
