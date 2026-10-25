"""/api/recap/daily: plan vs recorded activity for one working day, exact counts and honest nulls."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.api.state import _OPERATIONS_PLAN_STORE
from app.field.damage_reports import DAMAGE_STORE
from app.field.driver_exceptions import EXCEPTION_STORE
from app.field.recap import daily_recap
from app.field.spj import SPJ_STORE

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
STOP = {"name": "TPS Uji", "kecamatan": "Gambir", "address": "Jl. Uji 1", "lat": -6.17, "lng": 106.82}
OVERRIDE = {"reason": "Foto bukti tidak tersedia di lokasi", "actor": "supervisor"}


@pytest.fixture()
def day(monkeypatch) -> str:
    """A unique far-future working day so records from other tests never match."""
    year = 2100 + uuid4().int % 800
    pinned = f"{year}-0{1 + uuid4().int % 9}-1{uuid4().int % 9}"
    monkeypatch.setenv("PYTHIA_DEMO_DATE", pinned)
    return pinned


def _spj(truck: str, *, override: bool = False, done: bool = True):
    spj = SPJ_STORE.create_with_stops(
        "Pengemudi Uji", truck, "TPST Bantargebang", False, "normal", "uji", [dict(STOP)], created_by="admin"
    )
    if not done:
        return spj
    SPJ_STORE.activate(spj.spj_id, actor="admin")
    if override:
        SPJ_STORE.complete_stop(spj.spj_id, 0, override=OVERRIDE, actor="supervisor")
    else:
        SPJ_STORE.complete_stop(
            spj.spj_id,
            0,
            evidence={
                "arrival": {"photo_name": "a.png", "photo_b64": TINY_PNG, "lat": -6.17, "lng": 106.82},
                "weighing": [],
                "officer": {"name": "Petugas Uji", "photo_name": "o.png", "photo_b64": TINY_PNG},
            },
            actor="driver",
        )
    return SPJ_STORE.get(spj.spj_id)


def _receipt(spj_id: str, gross: float, tare: float) -> None:
    SPJ_STORE.record_receipt(spj_id, "r.png", TINY_PNG, gross, "manual", tare_weight_kg=tare)


def test_empty_day_is_zeros_and_nulls(day):
    recap = daily_recap(day)
    assert recap["date"] == day
    assert recap["forecast"] == {
        "plan_ids": [],
        "planned_tons": None,
        "forecast_tons": None,
        "classification": "MODEL_OUTPUT",
    }
    assert recap["actual"]["receipt_tons"] is None
    assert recap["actual"]["receipts"] == 0 and recap["actual"]["ritasi"] == 0
    assert recap["actual"]["spj"] == {"draft": 0, "aktif": 0, "selesai": 0, "batal": 0}
    assert recap["actual"]["classification"] == "OBSERVED_IN_APP"
    assert recap["delta"] == {"tons": None, "pct": None}
    assert recap["gate_wait"] == {"observed_n": 0, "median_min": None, "p90_min": None, "over_180": 0}
    assert recap["incidents"]["damage_reports"] == 0
    assert set(recap["incidents"]["exceptions"].values()) == {0}
    assert recap["evidence"] == {"stops_missing_evidence": 0, "overrides": 0, "receipts_pending_review": 0}
    assert "belum ada data" in recap["summary"]["id"]


def test_fixture_day_gives_exact_counts_and_tons(day):
    first = _spj("RCP-001")
    second = _spj("RCP-002", override=True)
    _spj("RCP-003", done=False)
    arrived = (datetime.now(UTC) - timedelta(minutes=40)).isoformat()
    SPJ_STORE.record_gate_arrival(first.spj_id, "driver", arrived)
    _receipt(first.spj_id, 15_000.0, 9_000.0)
    _receipt(second.spj_id, 12_500.0, 9_000.0)
    EXCEPTION_STORE.create(
        kind="road_closed",
        truck_code="RCP-001",
        driver_name="Pengemudi Uji",
        reported_by="driver",
        spj_id=first.spj_id,
        stop_index=0,
        note="",
        photo_name=None,
        photo_b64=None,
        lat=None,
        lng=None,
        approx=False,
        reported_at=f"{day}T09:00:00+07:00",
    )
    plan_id = f"PLN-{uuid4().hex[:8]}"
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id,
        {
            "plan_id": plan_id,
            "plan_date": day,
            "assignments": [],
            "total_assigned_tons": 10.0,
            "total_demand_tons": 12.0,
        },
    )
    _OPERATIONS_PLAN_STORE.approve(plan_id, "supervisor", lambda item: {"id": "x"})

    recap = daily_recap(day)

    assert recap["actual"]["spj"] == {"draft": 1, "aktif": 0, "selesai": 2, "batal": 0}
    assert recap["actual"]["receipts"] == 2 and recap["actual"]["ritasi"] == 2
    assert recap["actual"]["receipt_tons"] == 9.5  # (6.0 + 3.5) t net
    assert recap["forecast"]["plan_ids"] == [plan_id]
    assert recap["forecast"]["planned_tons"] == 10.0 and recap["forecast"]["forecast_tons"] == 12.0
    assert recap["delta"] == {"tons": -0.5, "pct": -5.0}
    assert recap["gate_wait"]["observed_n"] == 1
    assert 39 <= recap["gate_wait"]["median_min"] <= 42 and recap["gate_wait"]["over_180"] == 0
    assert recap["incidents"]["exceptions"]["road_closed"] == 1
    assert recap["evidence"]["overrides"] == 1
    assert recap["evidence"]["stops_missing_evidence"] == 0
    assert "9.5" in recap["summary"]["en"] and "9.5" in recap["summary"]["id"]


def test_damage_report_counts_on_its_local_day(day):
    rep = DAMAGE_STORE.create("RCP-009", "Pengemudi Uji", "ban", "ringan", "uji")
    raw = DAMAGE_STORE._records.get(rep.report_id)
    raw["created_at"] = f"{day}T03:00:00+00:00"
    DAMAGE_STORE._records.write(rep.report_id, raw)
    assert daily_recap(day)["incidents"]["damage_reports"] == 1


def test_endpoint_permissions_and_shape(api_client, auth_headers, day):
    path = f"/api/recap/daily?date={day}"
    assert api_client.get(path).status_code == 401
    assert api_client.get(path, headers=auth_headers("driver")).status_code == 403
    for role in ("administrator", "dispatcher", "supervisor"):
        res = api_client.get(path, headers=auth_headers(role))
        assert res.status_code == 200, role
        assert res.json()["date"] == day
    assert api_client.get("/api/recap/daily?date=nope", headers=auth_headers("dispatcher")).status_code == 422
