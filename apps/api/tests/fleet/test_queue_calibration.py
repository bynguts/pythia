"""Queue calibration on the real Bantargebang weighing data: reproducible artifact, honest block.

`ml/scripts/calibrate_queue.py` writes `queue_calibration.json` from the CSV; the
queue metric carries it as `calibration` without moving any simulated number, and
the simulated waits stay unvalidated (`wait_validation: not_observed`).
"""

from __future__ import annotations

import importlib.util
import json
import statistics
import sys

import pytest

from app.core import paths
from app.core.units import TRUCK_CAPACITY_TONS
from app.field import spj as spj_module
from app.field.spj import SpjStore
from app.fleet import queue_simulation
from app.fleet.queue_simulation import bantargebang_daily_arrivals, queue_minutes_per_truck

SCRIPTS = paths.REPO_ROOT / "ml" / "scripts"
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
STOP = {"name": "TPS Uji", "kecamatan": "Gambir", "address": "Jl. Uji 1", "lat": -6.17, "lng": 106.82}
OVERRIDE = {"reason": "Foto bukti tidak tersedia di lokasi", "actor": "supervisor"}


@pytest.fixture(scope="module")
def cq():
    """The calibration script, imported as run (it imports train_models from its own folder)."""
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location("calibrate_queue", SCRIPTS / "calibrate_queue.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.path.remove(str(SCRIPTS))


@pytest.fixture(scope="module")
def artifact() -> dict:
    return json.loads(paths.QUEUE_CALIBRATION.read_text(encoding="utf-8"))


def test_two_runs_write_byte_identical_json(cq, tmp_path):
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    cq.write_calibration(first)
    cq.write_calibration(second)
    assert first.read_bytes() == second.read_bytes()


def test_the_committed_artifact_is_what_the_script_computes_from_the_csv(cq, artifact):
    assert json.loads(json.dumps(cq.build_calibration())) == artifact


def test_backtest_recomputed_from_the_monthly_trips_matches_the_artifact(artifact):
    # Independent of the script: rebuild both one-month-ahead forecasts from the
    # artifact's own monthly trips/day and score them.
    months = artifact["arrivals_per_day_by_month"]
    exact = [m["trips"] / m["days"] if m["trips"] is not None else None for m in months]
    errors_model, errors_naive, actuals = [], [], []
    for i in range(len(months) - 1):
        present = [v for v in exact[: i + 1] if v is not None]
        if exact[i] is None or exact[i + 1] is None or len(present) < 12:
            continue
        model = round(statistics.median(present[-12:]))
        errors_model.append(abs(model - exact[i + 1]))
        errors_naive.append(abs(exact[i] - exact[i + 1]))
        actuals.append(exact[i + 1])
    bt = artifact["backtest"]
    assert bt["origins"] == len(errors_model) > 0
    assert bt["mae_model"] == round(statistics.fmean(errors_model), 1)
    assert bt["mae_naive"] == round(statistics.fmean(errors_naive), 1)
    mape = 100 * statistics.fmean(e / a for e, a in zip(errors_model, actuals, strict=True))
    assert bt["mape_model_pct"] == round(mape, 2)
    skill = 100 * (1 - statistics.fmean(errors_model) / statistics.fmean(errors_naive))
    assert bt["skill_pct"] == round(skill, 1)
    lo, hi = bt["skill_ci90_pct"]
    assert lo <= bt["skill_pct"] <= hi


def test_the_uncorrected_value_is_the_runtime_arrival_input(artifact):
    arrivals = artifact["arrivals_per_day"]
    assert arrivals["uncorrected"] == bantargebang_daily_arrivals()[0]
    assert arrivals["corrections_applied_at_runtime"] is False
    assert arrivals["difference"] == arrivals["corrected"] - arrivals["uncorrected"]
    # 2024-04's swapped columns are the visible difference the runtime input would carry.
    changed = {m["month"] for m in arrivals["months_changed_by_corrections"]}
    assert "2024-04" in changed


def test_overall_tons_per_trip_is_far_below_the_canonical_truck_capacity(artifact):
    tpr = artifact["tons_per_rit_overall"]
    assert tpr["value"] == round(tpr["tons"] / tpr["trips"], 2)
    assert 4.0 <= tpr["value"] <= 7.0 < TRUCK_CAPACITY_TONS


def test_queue_metric_carries_the_calibration_block_and_no_wait_claim(api_client, artifact):
    body = api_client.get("/api/tpa/queue-metric").json()
    cal = body["calibration"]
    assert body["classification"] == "SIMULATED"
    assert cal["wait_validation"] == "not_observed"
    assert cal["corrections_applied_at_runtime"] is False
    assert cal["backtest"] == artifact["backtest"]
    assert cal["tons_per_rit_overall"] == artifact["tons_per_rit_overall"]["value"]
    assert cal["truck_capacity_tons_canonical"] == TRUCK_CAPACITY_TONS
    assert cal["period"] == artifact["period"] and cal["source"] == artifact["source"]
    assert isinstance(cal["observed_gate_waits_in_app"], int) and cal["observed_gate_waits_in_app"] >= 0


def test_calibration_is_null_without_the_artifact(monkeypatch, tmp_path):
    monkeypatch.setattr(queue_simulation, "QUEUE_CALIBRATION", tmp_path / "missing.json")
    queue_simulation._calibration_artifact.cache_clear()
    try:
        metric = queue_minutes_per_truck(400, seed=42, replications=5)
        assert metric["calibration"] is None
        assert metric["classification"] == "SIMULATED"
    finally:
        monkeypatch.undo()
        queue_simulation._calibration_artifact.cache_clear()


def test_observed_gate_waits_count_completed_app_visits_only(monkeypatch, tmp_path):
    store = SpjStore(persist_path=str(tmp_path / "spj.db"))
    monkeypatch.setattr(spj_module, "SPJ_STORE", store)
    assert queue_simulation.observed_gate_waits_in_app() == 0

    def visit(truck: str, created_by: str, receipt: bool):
        spj = store.create_with_stops(
            "Pengemudi Uji",
            truck,
            "TPST Bantargebang",
            False,
            "normal",
            "uji",
            [dict(STOP)],
            created_by=created_by,
        )
        store.activate(spj.spj_id, actor="admin")
        store.complete_stop(spj.spj_id, 0, override=OVERRIDE, actor="supervisor")
        store.record_gate_arrival(spj.spj_id, "driver", "2026-10-26T01:00:00+00:00")
        if receipt:
            store.record_receipt(spj.spj_id, "r.png", TINY_PNG, 15_000.0, "manual", tare_weight_kg=9_000.0)

    visit("CAL-001", "admin", receipt=True)
    visit("CAL-002", "admin", receipt=False)  # still waiting: no completed wait yet
    visit("CAL-003", "seed", receipt=True)  # the demo seed is not an app observation
    assert queue_simulation.observed_gate_waits_in_app() == 1
