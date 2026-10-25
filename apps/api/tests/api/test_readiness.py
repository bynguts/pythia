"""Morning readiness board: one row per truck, with the blockers that stop it rolling (wave 12 lane B)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN
from app.field import safety
from app.field.damage_reports import DAMAGE_STORE
from app.field.pretrip import PRETRIP_ITEMS, PRETRIP_STORE
from app.field.spj import SPJ_STORE

# 20:00 WIB on a fixed past day, so the duty window never crosses a WIB midnight.
FROZEN_NOW = datetime(2026, 10, 20, 13, 0, tzinfo=UTC)
DAY = "2026-10-20"
STOP = {"name": "TPS Uji", "kecamatan": "Cilandak", "address": "Jl. Uji 1", "lat": -6.29, "lng": 106.79}


@pytest.fixture(autouse=True)
def _frozen(monkeypatch):
    monkeypatch.setattr(safety, "_now", lambda: FROZEN_NOW)


@pytest.fixture()
def truck() -> str:
    return f"RDY-{uuid4().hex[:6]}"


def _plan(truck: str) -> tuple[str, str]:
    """An approved plan for DAY holding one dispatch for ``truck``; returns (plan_id, dispatch_id)."""
    plan_id = f"plan-{uuid4().hex[:8]}"
    item = {"truck_code": truck, "text": f"Rencana {plan_id} · Truk {truck}", "fields": {"plan_id": plan_id}}
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id, {"plan_id": plan_id, "plan_date": DAY, "assignments": [], "dispatches": [item]}
    )
    plan, _ = _OPERATIONS_PLAN_STORE.approve(
        plan_id,
        "supervisor",
        lambda i: history_store.save_dispatch(i["truck_code"], i["text"], "operations_optimizer"),
    )
    return plan_id, plan["dispatch_ids"][0]


def _pretrip(truck: str, minutes_ago: int = 5, failed: tuple[str, ...] = ()) -> None:
    at = FROZEN_NOW - timedelta(minutes=minutes_ago)
    record_id = uuid4().hex[:12]
    PRETRIP_STORE._records.write(
        record_id,
        {
            "record_id": record_id,
            "truck_code": truck,
            "driver_name": "Pengemudi Uji",
            "date": at.date().isoformat(),
            "items": {k: k not in failed for k in PRETRIP_ITEMS},
            "note": "",
            "created_at": at.isoformat(),
        },
    )


def _draft_spj(truck: str, plan_id: str):
    return SPJ_STORE.create(
        driver_name="Pengemudi Uji",
        truck_code=truck,
        destination="TPST Bantargebang",
        weigh_on_site=False,
        priority="normal",
        note=f"Rencana {plan_id} (MODEL)",
        created_by="dispatcher",
    )


def _board(api_client, auth_headers, truck: str, scope: str = "plan") -> dict:
    res = api_client.get(f"/api/readiness?date={DAY}&scope={scope}", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    return next(t for t in res.json()["trucks"] if t["truck_code"] == truck)


def test_reads_need_the_dashboard_permission(api_client, auth_headers):
    assert api_client.get("/api/readiness").status_code == 401
    assert api_client.get("/api/readiness", headers=auth_headers("driver")).status_code == 403
    assert api_client.get("/api/readiness", headers=auth_headers("supervisor")).status_code == 200


def test_contract_shape_and_thresholds(api_client, auth_headers, truck):
    _plan(truck)
    body = api_client.get(f"/api/readiness?date={DAY}", headers=auth_headers("dispatcher")).json()
    assert body["date"] == DAY
    assert body["scope_used"] == "plan"
    assert body["thresholds"] == {"duty_warn_min": DUTY_WARN_MIN, "duty_block_min": DUTY_BLOCK_MIN}
    assert set(body["counts"]) == {"ready", "not_ready", "blocked"}
    assert sum(body["counts"].values()) == len(body["trucks"])
    row = next(t for t in body["trucks"] if t["truck_code"] == truck)
    assert set(row) == {
        "truck_code",
        "driver_name",
        "pretrip",
        "duty",
        "instruction",
        "spj",
        "damage",
        "service",
        "ready",
        "blockers",
    }


def test_empty_plan_scope_falls_back_to_the_fleet(api_client, auth_headers):
    body = api_client.get("/api/readiness?date=2031-01-01", headers=auth_headers("dispatcher")).json()
    assert body["scope_used"] == "fleet"
    assert body["trucks"]
    assert api_client.get("/api/readiness?scope=nope", headers=auth_headers("dispatcher")).status_code == 422


def test_missing_pretrip_pending_dispatch_and_draft_spj_report_exactly_those_blockers(
    api_client, auth_headers, truck
):
    plan_id, dispatch_id = _plan(truck)
    spj = _draft_spj(truck, plan_id)
    row = _board(api_client, auth_headers, truck)
    assert row["blockers"] == ["pretrip_missing", "instruction_pending"]
    assert row["ready"] is False
    assert row["pretrip"] == {"done": False, "at": None, "failed_items": []}
    assert row["instruction"]["dispatch_id"] == dispatch_id
    assert row["instruction"]["status"] == "pending"
    assert row["spj"]["spj_id"] == spj.spj_id
    assert row["spj"]["status"] == "draft"


def test_pretrip_and_a_ready_confirm_make_the_truck_ready(api_client, auth_headers, truck):
    plan_id, dispatch_id = _plan(truck)
    _draft_spj(truck, plan_id)
    _pretrip(truck)
    confirm = api_client.post(
        f"/api/dispatch/{dispatch_id}/confirm",
        json={"status": "READY", "note": "siap"},
        headers=auth_headers("driver"),
    )
    assert confirm.status_code == 200, confirm.text
    row = _board(api_client, auth_headers, truck)
    assert row["instruction"]["status"] == "acknowledged"
    assert row["blockers"] == []
    assert row["ready"] is True
    assert row["pretrip"]["done"] is True


def test_siap_and_issue_map_to_acknowledged_and_issue(api_client, auth_headers, truck):
    plan_id, dispatch_id = _plan(truck)
    _draft_spj(truck, plan_id)
    history_store.update_dispatch_status(dispatch_id, "SIAP")
    assert _board(api_client, auth_headers, truck)["instruction"]["status"] == "acknowledged"
    history_store.update_dispatch_status(dispatch_id, "ISSUE", "ban bocor")
    row = _board(api_client, auth_headers, truck)
    assert row["instruction"]["status"] == "issue"
    assert "instruction_issue" in row["blockers"]


def test_reassigned_instruction_is_reported(api_client, auth_headers, truck):
    _, dispatch_id = _plan(truck)
    history_store.update_dispatch_status(dispatch_id, "REASSIGNED")
    row = _board(api_client, auth_headers, truck)
    assert row["instruction"]["status"] == "reassigned"
    assert "instruction_reassigned" in row["blockers"]


@pytest.mark.parametrize(
    ("minutes", "state"),
    [
        (DUTY_WARN_MIN - 1, "ok"),
        (DUTY_WARN_MIN, "warn"),
        (DUTY_BLOCK_MIN - 1, "warn"),
        (DUTY_BLOCK_MIN, "blocked"),
    ],
)
def test_duty_thresholds(api_client, auth_headers, truck, minutes, state):
    _plan(truck)
    _pretrip(truck, minutes_ago=minutes)
    row = _board(api_client, auth_headers, truck)
    assert row["duty"]["state"] == state
    assert row["duty"]["minutes"] == minutes
    assert row["duty"]["source"] == "observed"
    assert ("duty_blocked" in row["blockers"]) is (state == "blocked")


def test_duty_override_lifts_the_block(api_client, auth_headers, truck):
    _plan(truck)
    _pretrip(truck, minutes_ago=DUTY_BLOCK_MIN + 5)
    safety.grant_override(
        truck, "Sopir pengganti belum tiba, disetujui", "supervisor", safety.OBSERVED, FROZEN_NOW
    )
    row = _board(api_client, auth_headers, truck)
    assert row["duty"]["state"] == "blocked"
    assert row["duty"]["override"]["by"] == "supervisor"
    assert "duty_blocked" not in row["blockers"]


def test_heavy_damage_sets_heavy_and_blocks(api_client, auth_headers, truck):
    _plan(truck)
    DAMAGE_STORE.create(truck, "Pengemudi Uji", "rem", "ringan", "berdecit")
    row = _board(api_client, auth_headers, truck)
    assert row["damage"] == {"open": 1, "heavy": False}
    assert "damage_open" in row["blockers"]
    DAMAGE_STORE.create(truck, "Pengemudi Uji", "mesin", "berat", "mati")
    row = _board(api_client, auth_headers, truck)
    assert row["damage"] == {"open": 2, "heavy": True}
    counts = api_client.get(f"/api/readiness?date={DAY}", headers=auth_headers("dispatcher")).json()["counts"]
    assert counts["blocked"] >= 1


def test_an_active_spj_outside_the_plan_is_flagged(api_client, auth_headers, truck):
    plan_id, _ = _plan(truck)
    draft = _draft_spj(truck, plan_id)
    other = SPJ_STORE.create(
        driver_name="Pengemudi Uji",
        truck_code=truck,
        destination="TPST Bantargebang",
        weigh_on_site=False,
        priority="normal",
        note="Seed demo SPJ",
        created_by="seed",
    )
    SPJ_STORE.add_stop(other.spj_id, **{k: v for k, v in STOP.items()})
    SPJ_STORE.activate(other.spj_id)
    row = _board(api_client, auth_headers, truck)
    assert row["spj"]["spj_id"] == draft.spj_id
    assert row["spj"]["other_active_spj_id"] == other.spj_id
    assert "spj_active_other" in row["blockers"]


def test_a_truck_without_any_spj_is_missing_one(api_client, auth_headers, truck):
    _plan(truck)
    row = _board(api_client, auth_headers, truck)
    assert row["spj"]["status"] == "none"
    assert "spj_missing" in row["blockers"]


def test_observed_activity_is_read_once_for_all_trucks(api_client, auth_headers, truck, monkeypatch):
    _plan(truck)
    calls = []
    real = safety.observed_activity

    def counting(now, truck_code=None):
        calls.append(truck_code)
        return real(now, truck_code)

    monkeypatch.setattr(safety, "observed_activity", counting)
    res = api_client.get(f"/api/readiness?date={DAY}&scope=fleet", headers=auth_headers("dispatcher"))
    assert res.status_code == 200
    assert len(res.json()["trucks"]) > 1
    assert calls == [None]


def test_duty_is_not_applicable_for_a_day_other_than_today(api_client, auth_headers, truck):
    _plan(truck)
    body = api_client.get(
        "/api/readiness?date=2026-10-21&scope=fleet", headers=auth_headers("dispatcher")
    ).json()
    assert all(
        t["duty"] == {"minutes": None, "state": None, "override": None, "source": "not_applicable"}
        for t in body["trucks"]
    )
