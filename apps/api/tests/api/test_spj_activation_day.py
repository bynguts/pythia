"""An SPJ is worked on its own day: tomorrow's draft cannot be activated today,
and today's plan SPJ, once delivered, counts in today's recap (Operations KPIs, Reports)."""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

from app.api.state import _OPERATIONS_PLAN_STORE
from app.core.env import local_today
from app.field.recap import daily_recap
from app.field.spj import SPJ_STORE
from app.fleet.data import TRUCKS

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
STOP = {"name": "TPS Uji", "kecamatan": "Gambir", "address": "Jl. Uji 1", "lat": -6.17, "lng": 106.82}
OVERRIDE = {"reason": "Foto bukti tidak tersedia di lokasi", "actor": "supervisor"}


def _free_truck() -> str:
    busy = {s.truck_code for s in SPJ_STORE.list() if s.status in ("draft", "aktif")}
    return next(
        t["truck_code"] for t in list(TRUCKS)[::-1] if not t["is_damaged"] and t["truck_code"] not in busy
    )


def test_tomorrows_spj_cannot_be_activated_today(api_client, auth_headers):
    tomorrow = (local_today() + timedelta(days=1)).isoformat()
    spj = SPJ_STORE.create_with_stops(
        "Pengemudi Uji",
        _free_truck(),
        "TPST Bantargebang",
        False,
        "normal",
        "uji",
        [dict(STOP)],
        date=tomorrow,
    )
    res = api_client.post(f"/api/spj/{spj.spj_id}/activate", headers=auth_headers("dispatcher"))
    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert f"this work order is for {tomorrow}" in detail
    assert f"today is {local_today().isoformat()}" in detail
    assert SPJ_STORE.get(spj.spj_id).status == "draft"
    SPJ_STORE.cancel(spj.spj_id, actor="admin")


def test_todays_spj_still_activates(api_client, auth_headers):
    spj = SPJ_STORE.create_with_stops(
        "Pengemudi Uji", _free_truck(), "TPST Bantargebang", False, "normal", "uji", [dict(STOP)]
    )
    res = api_client.post(f"/api/spj/{spj.spj_id}/activate", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "aktif"
    SPJ_STORE.cancel(spj.spj_id, actor="admin")


def test_todays_plan_delivery_counts_in_todays_recap(api_client, auth_headers):
    truck = _free_truck()
    today = local_today()
    plan_id = f"PLAN-DAY-{uuid4().hex[:8]}"
    stop = {
        "order": 1,
        "area": "gambir",
        "kecamatan": "Gambir",
        "shift": "pagi",
        "window": "06:00-14:00",
        "facility": "TPST Bantargebang",
        "facility_display": "TPST Bantargebang",
        "tons": 9.0,
    }
    _OPERATIONS_PLAN_STORE.save_proposed(
        plan_id,
        {
            "plan_id": plan_id,
            "status": "proposed",
            "kind": "day_plan",
            "plan_date": today.isoformat(),
            "assignments": [
                {
                    "truck_code": truck,
                    "area": "gambir",
                    "assigned_tons": 9.0,
                    "shift": "pagi",
                    "facility": "TPST Bantargebang",
                }
            ],
            "dispatches": [
                {
                    "truck_code": truck,
                    "text": f"Rencana {plan_id} · Truk {truck}",
                    "fields": {
                        "template": "plan_dispatch_v1",
                        "plan_date": today.isoformat(),
                        "stops": [stop],
                    },
                }
            ],
            "total_assigned_tons": 9.0,
            "total_demand_tons": 9.0,
            "proposed_by": "dispatcher",
        },
    )
    before = daily_recap(today)
    approved = api_client.post(f"/api/operations/{plan_id}/approve", headers=auth_headers("supervisor"))
    assert approved.status_code == 200, approved.text
    spj_id = approved.json()["spj_drafts"][0]["spj_id"]
    assert SPJ_STORE.get(spj_id).date == today.isoformat()

    res = api_client.post(f"/api/spj/{spj_id}/activate", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    for index in range(len(SPJ_STORE.get(spj_id).stops)):
        SPJ_STORE.complete_stop(spj_id, index, override=OVERRIDE, actor="supervisor")
    SPJ_STORE.record_receipt(spj_id, "r.png", TINY_PNG, 14820.0, "manual", tare_weight_kg=8100.0)

    after = daily_recap(today)
    assert plan_id in after["forecast"]["plan_ids"]
    assert after["forecast"]["planned_trips"] == (before["forecast"]["planned_trips"] or 0) + 1
    assert after["actual"]["ritasi"] == before["actual"]["ritasi"] + 1
    assert after["actual"]["receipts_with_net_weight"] == before["actual"]["receipts_with_net_weight"] + 1
    assert after["actual"]["receipt_tons"] == round((before["actual"]["receipt_tons"] or 0) + 6.72, 2)
