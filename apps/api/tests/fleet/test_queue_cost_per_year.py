"""Yearly gate-queue cost (modelled): recomputed from the inputs, and the committed JSON matches."""

from __future__ import annotations

import json

import pytest

from app.core.paths import MODELS_DIR
from app.fleet.queue_simulation import scenario_queue_metric
from app.fleet.value_model import queue_cost_per_year, value_model_from_simulation

pytestmark = pytest.mark.skipif(scenario_queue_metric() is None, reason="no arrival data")


def test_yearly_cost_matches_hand_arithmetic_from_the_simulated_waits():
    metric = scenario_queue_metric()
    result = queue_cost_per_year(value_model_from_simulation())
    trips = metric["trucks_per_day"] * 365
    assert result["trips_per_year"] == trips
    base = result["base"]
    assert base["current_truck_hours"] == pytest.approx(trips * metric["baseline_mean"] / 60, abs=0.1)
    assert base["planned_truck_hours"] == pytest.approx(trips * metric["staggered_mean"] / 60, abs=0.1)
    assert base["returned_truck_hours"] == pytest.approx(
        base["current_truck_hours"] - base["planned_truck_hours"], abs=0.2
    )
    assert base["current_driver_hours"] == base["current_truck_hours"]  # one driver per truck
    assert base["current_idle_litres"] == pytest.approx(base["current_truck_hours"] * 2.5, abs=1)
    lo, hi = metric["sensitivity"]["baseline_band"]
    assert result["band"]["low"]["wait_minutes_per_truck"] == lo
    assert result["band"]["high"]["wait_minutes_per_truck"] == hi
    assert result["band"]["low"]["current_truck_hours"] < base["current_truck_hours"]
    assert result["band"]["high"]["current_truck_hours"] > base["current_truck_hours"]


def test_committed_json_is_the_current_computation():
    committed = json.loads((MODELS_DIR / "queue_cost_per_year.json").read_text(encoding="utf-8"))
    assert committed == queue_cost_per_year(value_model_from_simulation())
