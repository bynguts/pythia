"""The one metric: TPA queue minutes per truck, unstaggered vs staggered (gsc P0-5)."""

import time
from unittest import mock

import pytest

from app.ai.forecasters.queue_predictor import TpaQueuePredictor
from app.fleet import data, queue_simulation
from app.fleet.data import tpa_queue_status_payload
from app.fleet.queue_simulation import (
    BASELINE_DEPARTURE_SD_MINUTES,
    DEPARTURE_SD_BAND_MINUTES,
    DEPARTURE_TRUNCATION_SD,
    SCENARIO_TRUCK_STEP,
    WEIGHBRIDGE_ASSUMPTION,
    WEIGHBRIDGE_LANES,
    WEIGHBRIDGE_TRUCKS_PER_HOUR,
    _simulate_day,
    bantargebang_daily_arrivals,
    baseline_departure_sd_minutes,
    hourly_queue_profile,
    modelled_peak_hour,
    peak_hour_weigh_ins,
    queue_minutes_per_truck,
    scenario_queue_metric,
)
from app.forecast.engine import simulate_staggered_dispatch

CONTRACT_KEYS = {
    "baseline_mean",
    "staggered_mean",
    "baseline_p95",
    "staggered_p95",
    "staggered_ci95",
    "baseline_ci95",
    "replications",
    "seed",
    "trucks_per_day",
    "classification",
    "source",
}


def _fresh(trucks: int, seed: int, replications: int = 20) -> dict:
    _simulate_day.cache_clear()
    return queue_minutes_per_truck(trucks, seed=seed, replications=replications)


def test_same_seed_gives_identical_metric():
    first = _fresh(600, seed=7)
    second = _fresh(600, seed=7)
    assert first == second
    assert first is not second


def test_different_seed_changes_draws():
    assert _fresh(600, seed=7) != _fresh(600, seed=8)


def test_staggered_departures_shorten_the_queue_per_truck():
    metric = _fresh(1200, seed=42)
    assert metric["staggered_mean"] < metric["baseline_mean"]
    assert metric["staggered_p95"] < metric["baseline_p95"]
    assert metric["staggered_max_queue"] < metric["baseline_max_queue"]


def test_confidence_intervals_bracket_the_mean_and_p95_exceeds_mean():
    metric = _fresh(1200, seed=42)
    for arm in ("baseline", "staggered"):
        lo, hi = metric[f"{arm}_ci95"]
        assert lo <= metric[f"{arm}_mean"] <= hi
        assert metric[f"{arm}_p95"] >= metric[f"{arm}_mean"]
    # The intervals do not overlap: the improvement is not replication noise.
    assert metric["staggered_ci95"][1] < metric["baseline_ci95"][0]


def test_contract_shape_and_simulated_label():
    metric = _fresh(400, seed=42, replications=5)
    assert CONTRACT_KEYS <= set(metric)
    assert metric["classification"] == "SIMULATED"
    assert metric["replications"] == 5
    assert metric["seed"] == 42
    assert metric["trucks_per_day"] == 400
    assert "Not a field measurement" in metric["source"]


def test_invalid_inputs_rejected():
    _simulate_day.cache_clear()
    with pytest.raises(ValueError):
        queue_minutes_per_truck(0)
    with pytest.raises(ValueError):
        queue_minutes_per_truck(100, replications=0)


def test_daily_arrivals_come_from_the_real_weighing_file():
    derived = bantargebang_daily_arrivals()
    assert derived is not None
    trucks, source = derived
    # Bantargebang intake is on the order of a thousand truck trips a day.
    assert 300 < trucks < 5000
    assert "ritasi" in source


def test_stagger_simulator_reads_the_same_metric():
    _simulate_day.cache_clear()
    metric = queue_minutes_per_truck()
    result = simulate_staggered_dispatch()
    assert result["baseline_wait_minutes"] == metric["baseline_mean"]
    assert result["optimized_wait_minutes"] == metric["staggered_mean"]
    assert result["trucks_per_day"] == metric["trucks_per_day"]
    assert result["classification"] == "SIMULATED"
    # Realistic fleet: one shift's share of the daily arrivals, not a 5-truck toy.
    assert result["fleet_per_shift"] == metric["trucks_per_day"] // 2
    assert sum(slot["trucks_in_slot"] for slot in result["dispatch_slots"]) == result["fleet_per_shift"]
    assert result["dispatch_slots"][0]["suggested_departure"] == "06:00"


def test_small_fleet_slot_plan_keeps_the_metric():
    result = simulate_staggered_dispatch(3)
    assert [slot["trucks_in_slot"] for slot in result["dispatch_slots"]] == [1, 1, 1]
    assert result["baseline_wait_minutes"] == queue_minutes_per_truck()["baseline_mean"]


def test_queue_metric_endpoint_is_public_and_matches_contract(api_client):
    response = api_client.get("/api/tpa/queue-metric")
    assert response.status_code == 200
    body = response.json()
    assert CONTRACT_KEYS <= set(body)
    assert body["classification"] == "SIMULATED"
    assert body["staggered_mean"] < body["baseline_mean"]


def test_twin_scene_carries_metric_for_jakarta_only(api_client):
    # A dry base week (no forecast rain): day 0 is the normal day the endpoint describes.
    jakarta = api_client.get(
        "/api/twin/scene", params={"city": "jakarta", "days": 2, "weather": "none"}
    ).json()
    metric = jakarta["landfill_queue"]["minutes_per_truck"]
    assert CONTRACT_KEYS <= set(metric)
    assert metric == api_client.get("/api/tpa/queue-metric").json()

    hcmc = api_client.get("/api/twin/scene", params={"city": "hcmc", "days": 2}).json()
    assert (hcmc.get("landfill_queue") or {}).get("minutes_per_truck") is None


def test_stagger_endpoint_returns_simulation_not_fixed_numbers(api_client, auth_headers):
    response = api_client.post("/api/simulator/stagger", headers=auth_headers("dispatcher"))
    assert response.status_code == 200
    body = response.json()
    metric = api_client.get("/api/tpa/queue-metric").json()
    assert body["baseline_wait_minutes"] == metric["baseline_mean"]
    assert body["optimized_wait_minutes"] == metric["staggered_mean"]
    assert (body["baseline_wait_minutes"], body["optimized_wait_minutes"]) != (116, 48)
    assert body["queue_reduction_percent"] != 58.6


def test_fleet_carbon_constants_are_labelled_demo_constants(api_client):
    # The saving and compliance figures are fixed numbers, not a computation.
    body = api_client.get("/api/fleet/carbon").json()
    assert body["classification"] == "DEMO_CONSTANT"
    assert "not measured" in body["source"]


# ── gsc C1: scenario-responsive metric and one set of weighbridge assumptions ──


def test_normal_day_metric_is_unscaled_and_names_its_normal_day():
    metric = scenario_queue_metric()
    assert CONTRACT_KEYS <= set(metric)
    assert metric["scenario_scaled"] is False
    assert metric["normal_day"] == {
        "trucks_per_day": metric["trucks_per_day"],
        "baseline_mean": metric["baseline_mean"],
        "staggered_mean": metric["staggered_mean"],
    }
    # Same tonnage on both sides is the normal day too.
    assert scenario_queue_metric(30_000.0, 30_000.0) == metric


def test_scenario_tonnage_scales_truck_arrivals_and_the_queue():
    normal = scenario_queue_metric()
    heavier = scenario_queue_metric(12_000.0, 10_000.0)
    assert CONTRACT_KEYS <= set(heavier)
    assert heavier["scenario_scaled"] is True
    trucks = normal["trucks_per_day"]
    assert heavier["trucks_per_day"] == trucks + 25 * round(trucks * 0.2 / 25)
    assert heavier["scaling"]["unrounded_trucks_per_day"] == pytest.approx(trucks * 1.2, abs=0.1)
    assert heavier["baseline_mean"] > normal["baseline_mean"]
    assert heavier["staggered_mean"] > normal["staggered_mean"]
    assert heavier["normal_day"] == normal["normal_day"]
    assert heavier["scaling"]["tonnage_ratio"] == pytest.approx(1.2)
    assert "modelled assumption" in heavier["scaling"]["basis"]
    assert "scaled" in heavier["source"] and heavier["classification"] == "SIMULATED"
    # The cached simulation results are never mutated by the wrapper.
    assert "scenario_scaled" not in queue_minutes_per_truck(heavier["trucks_per_day"])


def test_weighbridge_assumptions_live_in_one_place():
    metric = queue_minutes_per_truck()
    assert metric["assumptions"]["weighbridge_lanes"] == WEIGHBRIDGE_LANES
    assert metric["assumptions"]["weighbridge_basis"] == WEIGHBRIDGE_ASSUMPTION
    peak = tpa_queue_status_payload(scenario="peak")
    assert peak["weighbridge_basis"] == WEIGHBRIDGE_ASSUMPTION
    predictor = TpaQueuePredictor()
    assert predictor._weighbridges == WEIGHBRIDGE_LANES
    assert predictor._service_rate == WEIGHBRIDGE_TRUCKS_PER_HOUR
    hourly = hourly_queue_profile()
    assert {row["throughput_per_hour"] for row in hourly} == {WEIGHBRIDGE_LANES * WEIGHBRIDGE_TRUCKS_PER_HOUR}


def test_tpa_panel_hours_reproduce_the_daily_metric():
    # The status panel's clock hours are the metric's own baseline day, split by hour.
    metric = queue_minutes_per_truck()
    hourly = hourly_queue_profile()
    assert len(hourly) == 24
    trucks = sum(row["arrivals"] for row in hourly)
    assert abs(trucks - metric["trucks_per_day"]) <= 12  # per-hour rounding only
    weighted = sum(row["arrivals"] * row["mean_wait_minutes"] for row in hourly) / trucks
    assert weighted == pytest.approx(metric["baseline_mean"], abs=1.5)
    peak = tpa_queue_status_payload(scenario="peak")
    assert (
        peak["avg_wait_minutes"]
        == max(hourly, key=lambda r: r["arrivals"] * r["mean_wait_minutes"])["mean_wait_minutes"]
    )


def test_queue_metric_endpoint_is_the_unscaled_normal_day(api_client):
    body = api_client.get("/api/tpa/queue-metric").json()
    assert body["scenario_scaled"] is False
    assert body["normal_day"]["trucks_per_day"] == body["trucks_per_day"]


# ── /api/twin/scene must not buy a fresh simulation per request ──


def test_normal_day_is_simulated_once_however_it_is_requested():
    _simulate_day.cache_clear()
    trucks, source = bantargebang_daily_arrivals()
    queue_minutes_per_truck()
    scenario_queue_metric()
    scenario_queue_metric(30_000.0, 30_000.0)
    queue_minutes_per_truck(trucks, arrivals_source=source)
    queue_minutes_per_truck(trucks, arrivals_source="another description")
    assert _simulate_day.cache_info().currsize == 1


def test_nearby_and_repeated_scenarios_share_one_scaled_run():
    _simulate_day.cache_clear()
    first = scenario_queue_metric(12_000.0, 10_000.0)
    nearby = scenario_queue_metric(12_004.0, 10_000.0)  # ratio differs in the 4th decimal
    again = scenario_queue_metric(12_000.0, 10_000.0)
    info = _simulate_day.cache_info()
    assert info.currsize == 2  # the normal day + one scaled truck count
    assert info.misses == 2 and info.hits >= 4
    assert first["trucks_per_day"] == nearby["trucks_per_day"] == again["trucks_per_day"]
    normal_trucks = first["normal_day"]["trucks_per_day"]
    assert (first["trucks_per_day"] - normal_trucks) % SCENARIO_TRUCK_STEP == 0
    assert first["scaling"]["truck_step"] == SCENARIO_TRUCK_STEP
    assert nearby["scaling"]["tonnage_ratio"] != first["scaling"]["tonnage_ratio"]


def test_scenario_within_half_a_step_is_the_normal_day():
    normal = scenario_queue_metric()
    trucks = normal["trucks_per_day"]
    tiny = scenario_queue_metric(10_000.0 * (trucks + 10) / trucks, 10_000.0)
    assert tiny["scenario_scaled"] is False
    assert tiny["trucks_per_day"] == trucks


# ── A malformed month in the weighing file is skipped ──


def test_malformed_months_in_the_weighing_file_are_skipped(tmp_path, monkeypatch):
    csv_path = tmp_path / "weighing.csv"
    csv_path.write_text(
        "periode_data,ritasi\n202400,999999\n202413,999999\n202401,31000\n202402,29000\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(queue_simulation, "WEIGHING_CSV", csv_path)
    bantargebang_daily_arrivals.cache_clear()
    try:
        trucks, source = bantargebang_daily_arrivals()
    finally:
        monkeypatch.undo()
        bantargebang_daily_arrivals.cache_clear()
    assert trucks == 1000  # 31000 / 31 days and 29000 / 29 days
    assert "202401-202402" in source


# ── "trucks in queue" is the queue, not arrivals per hour ──


def test_tpa_status_separates_queue_from_arrivals():
    hourly = hourly_queue_profile()
    peak_row = max(hourly, key=lambda r: r["arrivals"] * r["mean_wait_minutes"])
    peak = tpa_queue_status_payload(scenario="peak")
    assert peak["arrivals_per_hour"] == peak_row["arrivals"]
    assert peak["queue_trucks_max"] == peak_row["max_queue"]
    assert peak["queue_trucks_mean"] == peak_row["queue_trucks_mean"]
    assert 0 < peak["queue_trucks_mean"] <= peak["queue_trucks_max"]
    assert peak["trucks_in_queue"] == peak["queue_trucks_max"]
    assert peak["processing_rate_tph"] == WEIGHBRIDGE_LANES * WEIGHBRIDGE_TRUCKS_PER_HOUR
    for key in ("queue_trucks_mean", "queue_trucks_max", "arrivals_per_hour"):
        assert key in tpa_queue_status_payload(scenario="live")


def test_command_center_trucks_waiting_reads_the_queue_not_arrivals():
    status = {"queue_trucks_max": 7, "trucks_in_queue": 7, "arrivals_per_hour": 300, "avg_wait_minutes": 12.0}
    with mock.patch.object(data, "tpa_queue_status_payload", return_value=status):
        snapshot = data.command_center_snapshot([])
    assert snapshot["tpa_queue"]["trucks_waiting"] == 7
    assert snapshot["kpis"]["tpa_queue_trucks"] == 7


# ── gsc teardown #3: a current-practice baseline, a sensitivity band, one beacon ──


def test_baseline_departures_spread_around_shift_start():
    metric = queue_minutes_per_truck()
    assumptions = metric["assumptions"]
    assert assumptions["baseline_departure_sd_minutes"] == BASELINE_DEPARTURE_SD_MINUTES > 0
    assert metric["baseline_departure_sd_minutes"] == BASELINE_DEPARTURE_SD_MINUTES
    assert "current practice" in assumptions["baseline"]
    assert "at shift start" not in assumptions["baseline"]
    # The lanes and weigh cycle travel with the headline as stated assumptions.
    assert assumptions["weighbridge_lanes"] == WEIGHBRIDGE_LANES
    assert assumptions["weigh_cycle_minutes"] > 0
    # The simulated departures really are spread: a normal truncated at +/-2 SD
    # keeps ~0.88 of its SD, never zero (the old baseline sent a shift at one minute).
    realised = baseline_departure_sd_minutes(metric["trucks_per_day"])
    assert 0.8 * BASELINE_DEPARTURE_SD_MINUTES < realised <= BASELINE_DEPARTURE_SD_MINUTES
    assert baseline_departure_sd_minutes(metric["trucks_per_day"], 60.0) > realised


def test_sensitivity_band_brackets_the_headline():
    metric = queue_minutes_per_truck()
    band = metric["sensitivity"]
    rows = band["rows"]
    assert [row["departure_sd_minutes"] for row in rows] == sorted(DEPARTURE_SD_BAND_MINUTES)
    assert len(rows) >= 3
    low, high = band["baseline_band"]
    assert low <= metric["baseline_mean"] <= high
    # Tighter departures bunch the gate more: the baseline falls as the spread widens.
    means = [row["baseline_mean"] for row in rows]
    assert means == sorted(means, reverse=True)
    assert (low, high) == (min(means), max(means))
    # The headline row is the stated spread, and every spread still loses to the stagger.
    headline = next(r for r in rows if r["departure_sd_minutes"] == BASELINE_DEPARTURE_SD_MINUTES)
    assert headline["baseline_mean"] == metric["baseline_mean"]
    assert headline["baseline_ci95"] == metric["baseline_ci95"]
    assert all(r["baseline_ci95"][0] > metric["staggered_ci95"][1] for r in rows)
    r_low, r_high = band["reduction_percent_band"]
    assert r_low <= metric["reduction_percent"] <= r_high
    assert metric["assumptions"]["departure_truncation_sd"] == DEPARTURE_TRUNCATION_SD


def test_band_and_beacon_are_deterministic():
    first = _fresh(800, seed=42)
    second = _fresh(800, seed=42)
    assert first["sensitivity"] == second["sensitivity"]
    peak = modelled_peak_hour(800)
    hourly_queue_profile.cache_clear()
    assert modelled_peak_hour(800) == peak


def test_beacon_is_the_modelled_peak_hour_not_the_clock():
    expected = modelled_peak_hour()
    payloads = []
    for frozen_hour in (3, 15):
        frozen = time.struct_time((2026, 10, 24, frozen_hour, 0, 0, 5, 297, 0))
        with mock.patch("time.localtime", return_value=frozen):
            payloads.append(tpa_queue_status_payload(scenario="live"))
    assert payloads[0] == payloads[1]
    beacon = payloads[0]
    assert beacon["modelled_hour"] == expected["hour"]
    assert beacon["hour_label"] == f"modelled peak hour {expected['hour']:02d}:00"
    assert beacon["avg_wait_minutes"] == expected["mean_wait_minutes"] > 0
    assert beacon["trucks_in_queue"] == expected["max_queue"] > 0
    assert beacon["trucks_per_day"] == queue_minutes_per_truck()["trucks_per_day"]
    assert "clock_hour" not in beacon
    assert tpa_queue_status_payload(scenario="peak")["modelled_hour"] == expected["hour"]


def test_twin_beacon_and_headline_describe_the_same_day(api_client):
    # Same scenario as tests/forecast/test_twin.py, so the scaled run is cached.
    params = {"days": 2, "rainfall_mm": 80, "event_attendance": 50_000, "venue": "jis", "day": 1}
    queue = api_client.get("/api/twin/scene", params=params).json()["landfill_queue"]
    metric = queue["minutes_per_truck"]
    assert metric["scenario_scaled"] is True
    trucks = metric["trucks_per_day"]
    assert queue["trucks_per_day"] == trucks != metric["normal_day"]["trucks_per_day"]
    peak = modelled_peak_hour(trucks)
    assert queue["modelled_hour"] == peak["hour"]
    assert queue["avg_wait_minutes"] == peak["mean_wait_minutes"]
    assert queue["trucks_in_queue"] == peak["max_queue"]
    # The scaled headline is the cached simulation of that same truck count...
    same_day = queue_minutes_per_truck(trucks)
    for key in ("baseline_mean", "staggered_mean", "baseline_ci95", "sensitivity"):
        assert metric[key] == same_day[key]
    # ...and the beacon's hours are that day's baseline, split by hour.
    hourly = hourly_queue_profile(trucks)
    arrivals = sum(row["arrivals"] for row in hourly)
    weighted = sum(row["arrivals"] * row["mean_wait_minutes"] for row in hourly) / arrivals
    assert weighted == pytest.approx(metric["baseline_mean"], abs=1.5)
    # The beacon's wait is the peak hour of that day, the headline its day average:
    # two views of one simulated day, so the peak can only read higher.
    assert queue["avg_wait_minutes"] > metric["baseline_mean"]

    assert queue["day_basis"]["id"] == "scenario"

    # The default scene runs on the forecast week, so a rainy forecast day may scale
    # the queue (day_basis says so); the dry base week is the normal day itself.
    normal = api_client.get("/api/twin/scene", params={"days": 2, "weather": "none"}).json()["landfill_queue"]
    status = api_client.get("/api/tpa/queue-status").json()
    assert normal["minutes_per_truck"]["scenario_scaled"] is False
    assert normal["day_basis"]["id"] == "normal_day"
    for key in ("modelled_hour", "avg_wait_minutes", "trucks_in_queue", "trucks_per_day"):
        assert normal[key] == status[key]


def test_weighbridge_log_is_the_seeded_peak_hour_and_labelled_simulated():
    beacon = tpa_queue_status_payload()
    logs = beacon["scale_logs"]
    assert logs, "the panel log comes from the simulation, not an empty placeholder"
    assert logs == list(peak_hour_weigh_ins(beacon["trucks_per_day"], beacon["modelled_hour"]))
    hour = f"{beacon['modelled_hour']:02d}:"
    for entry in logs:
        assert entry["source"] == "SIMULATED"
        assert entry["arrived"].startswith(hour)  # arrivals of the labelled peak hour
        assert entry["truck"].startswith("SIM-")  # a simulated arrival, not a fleet unit
        assert entry["wait_minutes"] >= 0 and entry["weigh_start"] >= entry["arrived"]
        assert "weight_ton" not in entry  # the simulation does not model payloads
    # Deterministic: a fresh simulation gives the same log.
    peak_hour_weigh_ins.cache_clear()
    assert tpa_queue_status_payload()["scale_logs"] == logs


# ── gsc teardown v2 #14: decimal ritasi ("6216.0") is a number, not 62160 trips ──


def test_decimal_ritasi_values_are_parsed_as_numbers(tmp_path, monkeypatch):
    csv_path = tmp_path / "weighing.csv"
    csv_path.write_text(
        'periode_data,ritasi\n202401,"31000"\n202402,"29000.0"\n202403,not-a-number\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(queue_simulation, "WEIGHING_CSV", csv_path)
    bantargebang_daily_arrivals.cache_clear()
    try:
        trucks, _source = bantargebang_daily_arrivals()
    finally:
        monkeypatch.undo()
        bantargebang_daily_arrivals.cache_clear()
    assert trucks == 1000  # 29000.0 / 29 days, not 290000 / 29


# ── the staggered peak hour lives with the queue model; the twin only reads it ──


def test_staggered_peak_hour_is_the_queue_models_own_helper():
    from app.api.routers import twin as twin_router

    assert twin_router.staggered_peak_hour is queue_simulation.staggered_peak_hour
    peak = modelled_peak_hour()
    trucks = bantargebang_daily_arrivals()[0]
    staggered = queue_simulation.staggered_peak_hour(trucks, peak["hour"])
    assert staggered["hour"] == peak["hour"]
    assert staggered["classification"] == "SIMULATED"
    assert staggered["stagger_minutes"] == queue_simulation.STAGGER_SLOT_MINUTES
    assert staggered["mean_wait_minutes"] < peak["mean_wait_minutes"]


def test_tpa_wait_recommendation_names_the_stagger_slot():
    from app.forecast.engine import estimate_tpa_queue_wait

    yellow = estimate_tpa_queue_wait(25)  # 50 min: the "stagger" band
    assert yellow["status"] == "yellow"
    assert f"by {queue_simulation.STAGGER_SLOT_MINUTES} minutes" in yellow["recommendation"]
    assert "20 minutes" not in yellow["recommendation"]


# ── Twin decision room: a weighbridge lane closed is a labelled what-if ──


def test_default_lanes_keep_the_normal_day_and_its_cache_key():
    _simulate_day.cache_clear()
    default = queue_minutes_per_truck()
    explicit = queue_minutes_per_truck(lanes=WEIGHBRIDGE_LANES)
    assert explicit == default
    assert _simulate_day.cache_info().currsize == 1
    assert default["assumptions"]["weighbridge_lanes"] == WEIGHBRIDGE_LANES
    assert default["assumptions"]["weighbridge_basis"] == WEIGHBRIDGE_ASSUMPTION


def test_a_closed_lane_never_shares_a_cached_result_with_the_full_set():
    _simulate_day.cache_clear()
    full = queue_minutes_per_truck()
    closed = queue_minutes_per_truck(lanes=WEIGHBRIDGE_LANES - 1)
    full_again = queue_minutes_per_truck()
    assert _simulate_day.cache_info().currsize == 2
    assert full_again == full
    assert closed["trucks_per_day"] == full["trucks_per_day"]
    assert closed["baseline_mean"] > full["baseline_mean"]
    assert closed["staggered_mean"] > full["staggered_mean"]
    assert closed["assumptions"]["weighbridge_lanes"] == WEIGHBRIDGE_LANES - 1
    assert closed["assumptions"]["weighbridge_basis"].startswith("what-if assumption:")
    assert closed["classification"] == full["classification"]


def test_scenario_metric_with_a_closed_lane_compares_against_the_full_normal_day():
    normal = scenario_queue_metric()
    closed = scenario_queue_metric(lanes=WEIGHBRIDGE_LANES - 1)
    assert closed["scenario_scaled"] is False
    assert closed["normal_day"] == normal["normal_day"]
    assert closed["normal_day"]["baseline_mean"] == normal["baseline_mean"]
    assert closed["baseline_mean"] > normal["baseline_mean"]
    assert closed["assumptions"]["weighbridge_lanes"] == WEIGHBRIDGE_LANES - 1


@pytest.mark.parametrize("lanes", [0, -1, WEIGHBRIDGE_LANES + 1])
def test_lanes_outside_the_assumed_set_are_rejected(lanes):
    with pytest.raises(ValueError):
        queue_minutes_per_truck(1000, lanes=lanes)
