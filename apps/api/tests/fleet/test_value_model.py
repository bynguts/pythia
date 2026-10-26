"""Value per 1,000 gate trips (GET /api/reports/value-model): SIMULATED x ASSUMPTION.

The waits come from the gate-queue simulation, the rest are labelled assumptions, and
the gain is counted in truck-hours, driver hours and litres, never rupiah.
"""

from __future__ import annotations

from typing import Any

import pytest

import app.fleet.value_model as value_model_module
from app.core.units import GATE_ALERT_MIN
from app.fleet.queue_simulation import scenario_queue_metric
from app.fleet.value_model import VALUE_MODEL_TRUCKS, scenario_value, value_model


def _metric(**overrides: Any) -> dict[str, Any]:
    """The keys the value model reads from the queue metric, with distinctive numbers."""
    metric = {
        "trucks_per_day": 1000,
        "baseline_mean": 50.0,
        "staggered_mean": 8.0,
        "baseline_p95": 110.0,
        "staggered_p95": 20.0,
        "staggered_ci95": [7.0, 9.0],
        "baseline_departure_sd_minutes": 30.0,
        "recommended_stagger_minutes": 15,
        "replications": 100,
        "source": "test simulation",
        "sensitivity": {
            "rows": [
                {"departure_sd_minutes": 10.0, "baseline_mean": 30.0},
                {"departure_sd_minutes": 30.0, "baseline_mean": 50.0},
                {"departure_sd_minutes": 60.0, "baseline_mean": 62.0},
            ],
            "baseline_band": [30.0, 62.0],
        },
        "over_alert": {
            "without": {"low": 2.0, "base": 6.0, "high": 9.0},
            "with": 1.0,
            "longest_without": 200.0,
            "longest_with": 40.0,
        },
    }
    metric.update(overrides)
    return metric


def _keys(node: Any) -> list[str]:
    if isinstance(node, dict):
        return [k for key, value in node.items() for k in (key, *_keys(value))]
    if isinstance(node, list):
        return [k for item in node for k in _keys(item)]
    return []


def _p(**overrides: float) -> dict[str, float]:
    p = {
        "wait_without_min": 60.0,
        "wait_with_min": 0.0,
        "over_alert_without_per_1000": 100.0,
        "over_alert_with_per_1000": 0.0,
        "slot_adherence": 1.0,
        "drivers_per_truck": 1.0,
        "idle_fuel_l_per_h": 2.0,
    }
    p.update(overrides)
    return p


def test_benefit_is_ordered_low_base_high():
    scenarios = value_model(_metric())["scenarios"]
    fields = (
        "queue_truck_hours_returned",
        "driver_hours_returned",
        "idle_fuel_litres_avoided",
        "trips_over_alert_avoided",
    )
    for field in fields:
        low, base, high = (scenarios[level][field] for level in ("low", "base", "high"))
        assert 0 < low <= base <= high, field


def test_without_vs_with_is_hours_per_thousand_trucks():
    # Base adherence 0.8: with-wait = 0.8 x 8 + 0.2 x 50 = 16.4 min.
    # 1,000 trucks x 50 min = 833.3 truck-hours; x 16.4 min = 273.3; at 2.5 L/h idle.
    base = value_model(_metric())["scenarios"]["base"]
    assert base["with"]["wait_minutes_per_truck"] == 16.4
    assert base["without"]["queue_truck_hours"] == 833.3
    assert base["with"]["queue_truck_hours"] == 273.3
    assert base["queue_truck_hours_returned"] == 560.0
    assert base["driver_hours_returned"] == 560.0
    assert base["idle_fuel_litres_avoided"] == 1400
    assert base["without"]["idle_fuel_litres"] == round(1000 * 50 / 60 * 2.5)
    # Over the alert: 6 per 1,000 today, 0.8 x 1 + 0.2 x 6 = 2 with the stagger.
    assert (base["without"]["trips_over_alert"], base["with"]["trips_over_alert"]) == (6.0, 2.0)
    assert base["trips_over_alert_avoided"] == 4.0


def test_low_is_the_least_favourable_end_of_every_parameter():
    body = value_model(_metric())
    params = {p["key"]: p for p in body["parameters"]}
    # The spread with the shortest baseline queue, the slower staggered end, half the slots kept.
    assert params["wait_without_min"]["low"] == 30.0
    assert "Low is the 10-min spread" in params["wait_without_min"]["rationale"]
    assert params["wait_with_min"]["low"] == 9.0
    assert params["slot_adherence"]["low"] == 0.5
    assert params["idle_fuel_l_per_h"]["low"] == 1.5
    low = body["scenarios"]["low"]
    # with-wait = 0.5 x 9 + 0.5 x 30 = 19.5 min; 1,000 x (30 - 19.5) / 60 = 175 truck-hours.
    assert low["with"]["wait_minutes_per_truck"] == 19.5
    assert low["queue_truck_hours_returned"] == 175.0


def test_no_benefit_when_no_trip_keeps_its_slot():
    out = scenario_value(_p(slot_adherence=0.0))
    assert out["queue_truck_hours_returned"] == 0.0
    assert out["trips_over_alert_avoided"] == 0.0


def test_scenario_value_scales_with_trucks():
    out = scenario_value(_p(), trucks=10)
    assert out["queue_truck_hours_returned"] == 10.0
    assert out["idle_fuel_litres_avoided"] == 20
    assert out["trips_over_alert_avoided"] == 1.0


def test_every_parameter_has_a_rationale_and_a_source_or_the_assumption_flag():
    params = value_model(_metric())["parameters"]
    assert {p["key"] for p in params} == {
        "wait_without_min",
        "wait_with_min",
        "over_alert_without_per_1000",
        "over_alert_with_per_1000",
        "slot_adherence",
        "drivers_per_truck",
        "idle_fuel_l_per_h",
    }
    for p in params:
        assert p["rationale"].strip() and p["rationale_id"].strip(), p["key"]
        assert p["label"].strip() and p["label_id"].strip(), p["key"]
        assert p["sources"] or p["assumption"] is True, p["key"]
    for key in ("idle_fuel_l_per_h", "slot_adherence"):
        param = next(p for p in params if p["key"] == key)
        assert param["assumption"] is True and param["sources"] == [], key
        assert "no source in this repository" in param["rationale"], key


def test_no_rupiah_fields():
    keys = [key.lower() for key in _keys(value_model(_metric()))]
    for banned in ("idr", "rupiah", "rp_", "cost", "price"):
        assert not [key for key in keys if banned in key], banned


def test_model_is_labelled_simulated_times_assumption():
    body = value_model(_metric())
    assert body["classification"] == "SIMULATED × ASSUMPTION"
    assert "not a field measurement" in body["note"]
    assert "pilot" in body["note"]
    assert body["trucks"] == VALUE_MODEL_TRUCKS == 1000


def test_extra_trips_are_omitted_not_invented():
    body = value_model(_metric())
    assert {row["key"] for row in body["omitted"]} == {"extra_trips"}
    assert body["gate_alert_minutes"] == GATE_ALERT_MIN
    assert body["p95_wait_minutes"] == {"without": 110.0, "with": 20.0}
    assert not [key for key in _keys(body["scenarios"]) if "extra_trips" in key]


def test_over_alert_counts_replay_the_queue_metric():
    metric = scenario_queue_metric()
    if metric is None:
        pytest.skip("no Bantargebang arrival data")
    body = value_model_module.value_model_from_simulation()
    params = {p["key"]: p for p in body["parameters"]}
    over = params["over_alert_without_per_1000"]
    assert 0 <= over["low"] <= over["base"] <= over["high"] <= VALUE_MODEL_TRUCKS
    assert 0 <= params["over_alert_with_per_1000"]["base"] <= over["base"]
    # The replayed longest wait cannot sit below the metric's own p95 wait.
    longest = float(over["rationale"].split("longest simulated wait is ")[1].split(" min")[0])
    assert longest >= max(row["baseline_p95"] for row in metric["sensitivity"]["rows"])


def test_inputs_come_from_the_simulation(monkeypatch):
    metric = _metric(baseline_mean=44.4, staggered_mean=4.4, staggered_ci95=[4.0, 4.8], trucks_per_day=1250)
    metric["seed"], metric["replications"] = 7, 3
    monkeypatch.setattr(value_model_module, "scenario_queue_metric", lambda: metric)
    body = value_model_module.value_model_from_simulation()
    params = {p["key"]: p for p in body["parameters"]}
    assert (params["wait_without_min"]["low"], params["wait_without_min"]["base"]) == (30.0, 44.4)
    assert params["wait_without_min"]["high"] == 62.0
    # Low is the slower (upper) end of the stagger's interval.
    assert (params["wait_with_min"]["low"], params["wait_with_min"]["high"]) == (4.8, 4.0)
    assert params["wait_with_min"]["base"] == 4.4
    assert body["trucks_per_day"] == 1250
    assert body["days_per_1000_trucks"] == 0.8


def test_no_arrival_data_returns_none(monkeypatch):
    monkeypatch.setattr(value_model_module, "scenario_queue_metric", lambda: None)
    assert value_model_module.value_model_from_simulation() is None


def test_route_requires_a_token(api_client):
    assert api_client.get("/api/reports/value-model").status_code == 401


def test_route_refuses_the_driver(api_client, auth_headers):
    assert api_client.get("/api/reports/value-model", headers=auth_headers("driver")).status_code == 403


def test_route_serves_the_live_simulation(api_client, auth_headers):
    res = api_client.get("/api/reports/value-model", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    body = res.json()
    metric = scenario_queue_metric()
    base = body["scenarios"]["base"]
    params = {p["key"]: p for p in body["parameters"]}
    assert base["without"]["wait_minutes_per_truck"] == metric["baseline_mean"]
    assert params["wait_with_min"]["base"] == metric["staggered_mean"]
    # High keeps every slot, so its with-arm is the simulated staggered day at its fast end.
    assert body["scenarios"]["high"]["with"]["wait_minutes_per_truck"] == metric["staggered_ci95"][0]
    assert body["scenarios"]["low"]["queue_truck_hours_returned"] > 0
    assert body["trucks_per_day"] == metric["trucks_per_day"]
    assert body["classification"] == "SIMULATED × ASSUMPTION"


def test_route_503_without_arrival_data(api_client, auth_headers, monkeypatch):
    monkeypatch.setattr(value_model_module, "scenario_queue_metric", lambda: None)
    res = api_client.get("/api/reports/value-model", headers=auth_headers("dispatcher"))
    assert res.status_code == 503
