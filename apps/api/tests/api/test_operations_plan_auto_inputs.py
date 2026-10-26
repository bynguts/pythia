"""POST /api/operations/plan?auto_inputs=true: inputs from the forecast and field facts, never typed."""

from __future__ import annotations

from uuid import uuid4

import pytest

import app.api.routers.operations as operations
import app.forecast.baseline as baseline
from app.field.field_facts import add_fact
from app.field.permits import PERMIT_STORE


def _truck(code):
    return {
        "truck_code": code,
        "vehicle_type": "Compactor Besar",
        "is_damaged": False,
        "deviation": {"violated": False},
    }


@pytest.fixture()
def day() -> str:
    # A weekday far from other tests' records.
    return f"{2300 + uuid4().int % 600}-06-1{uuid4().int % 9}"


@pytest.fixture()
def calls(monkeypatch):
    seen = []

    def predictions(**kwargs):
        seen.append(kwargs)
        kecamatan = [
            {"slug": "cakung", "kecamatan": "CAKUNG", "city": "Jakarta Timur", "predicted_tons": 40.0}
        ]
        return {
            "kecamatan": kecamatan,
            "top_hotspots": kecamatan,
            "total_predicted_tons": 7000.0,
            "kecamatan_count": 42,
            "scenario": {"targeted_kecamatan": []},
        }

    monkeypatch.setattr(operations, "predictions_kecamatan", predictions)
    monkeypatch.setattr(operations, "TRUCKS", [_truck("T-001"), _truck("T-002")])
    return seen


def _forecast(rain: float, holiday: str | None = None, unlocated: str | None = None):
    drivers = [
        {
            "kind": "weather",
            "detail": {"rainfall_mm": rain},
            "source": "open-meteo",
            "input_classification": "forecast",
        }
    ]
    if unlocated:
        drivers.append({"kind": "event", "detail": {"name": unlocated}, "effect_reason": "location_unknown"})
    if holiday:
        drivers.append({"kind": "holiday", "detail": {"name": holiday}})
    return lambda iso: {"drivers": drivers}


def _plan(api_client, auth_headers, **params):
    res = api_client.post("/api/operations/plan", params=params, headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    return res.json()


def test_rain_and_holiday_come_from_the_forecast_not_the_query(
    api_client, auth_headers, monkeypatch, calls, day
):
    monkeypatch.setattr(
        baseline, "tomorrow_forecast", _forecast(12.5, holiday="Hari Uji", unlocated="Konser Uji")
    )
    plan = _plan(
        api_client, auth_headers, plan_date=day, auto_inputs="true", rainfall_mm=99, event_attendance=5000
    )
    assert calls[-1]["rainfall_mm"] == 12.5 and calls[-1]["is_holiday"] is True
    assert calls[-1]["event_attendance"] == 0 and calls[-1]["event_lat"] is None
    scenario = plan["scenario"]
    assert scenario["inputs_auto"] is True and scenario["rainfall_mm"] == 12.5
    auto = scenario["auto_inputs"]
    assert auto["rainfall"] == {
        "rainfall_mm": 12.5,
        "source": "open-meteo",
        "input_classification": "forecast",
    }
    assert auto["holiday"] == "Hari Uji" and auto["event_applied"] is None
    assert auto["events_not_applied"] == [{"name": "Konser Uji", "reason": "location_unknown"}]
    assert isinstance(plan["solve_seconds"], float) and plan["solve_seconds"] >= 0


def test_the_largest_located_permit_is_applied_and_the_rest_listed(
    api_client, auth_headers, monkeypatch, calls, day
):
    monkeypatch.setattr(baseline, "tomorrow_forecast", _forecast(0.0))
    for name, attendance in (("Kecil", 2000), ("Besar", 30000)):
        PERMIT_STORE.add(
            {
                "id": PERMIT_STORE.next_id(),
                "name": f"{name} {day}",
                "event_date": day,
                "expected_attendance": attendance,
                "lat": -6.2,
                "lng": 106.8,
                "data_class": "USER_SUBMITTED",
            }
        )
    auto = _plan(api_client, auth_headers, plan_date=day, auto_inputs="true")["scenario"]["auto_inputs"]
    assert auto["event_applied"]["name"] == f"Besar {day}" and auto["event_applied"]["attendance"] == 30000
    assert auto["events_not_applied"] == [{"name": f"Kecil {day}", "reason": "one_event_per_plan"}]
    assert calls[-1]["event_attendance"] == 30000 and calls[-1]["event_lat"] == -6.2


def test_a_truck_unavailable_fact_keeps_the_truck_out_of_the_plan(
    api_client, auth_headers, monkeypatch, calls
):
    day = "2026-10-28"  # a date with facility rules in force, so the solver assigns trips
    monkeypatch.setattr(baseline, "tomorrow_forecast", _forecast(0.0))
    fact = add_fact(
        day,
        "T-001 stays in the workshop",
        "workshop",
        {"kind": "truck_unavailable", "truck_code": "T-001"},
        "dispatcher",
    )
    plan = _plan(api_client, auth_headers, plan_date=day, auto_inputs="true")
    assert {a["truck_code"] for a in plan["assignments"]} == {"T-002"}
    applied = plan["scenario"]["auto_inputs"]["field_facts_applied"]
    assert applied == [{"fact_id": fact["id"], "truck_code": "T-001"}]


def test_without_auto_inputs_the_query_still_drives_the_plan(api_client, auth_headers, calls, day):
    add_fact(day, "T-001 out", "workshop", {"kind": "truck_unavailable", "truck_code": "T-001"}, "dispatcher")
    plan = _plan(api_client, auth_headers, plan_date=day, rainfall_mm=7)
    assert calls[-1]["rainfall_mm"] == 7 and calls[-1]["is_holiday"] is False
    assert plan["scenario"]["inputs_auto"] is False and "auto_inputs" not in plan["scenario"]


def test_a_date_outside_the_forecast_week_is_422(api_client, auth_headers, monkeypatch, calls, day):
    def outside(iso):
        raise ValueError("date outside the forecast week")

    monkeypatch.setattr(baseline, "tomorrow_forecast", outside)
    res = api_client.post(
        "/api/operations/plan",
        params={"plan_date": day, "auto_inputs": "true"},
        headers=auth_headers("dispatcher"),
    )
    assert res.status_code == 422
