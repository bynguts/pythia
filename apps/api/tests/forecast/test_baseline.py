"""One "today" for every workspace: /api/baseline/today is the twin's default frame.

Weather is stubbed at both modules that read it, so the twin and the baseline see
the same forecast and these tests never depend on Open-Meteo being reachable.
"""

from datetime import date, timedelta

import pytest

from app.api.routers import twin as twin_router
from app.core.units import BIN_CAPACITY_TONS, SHIFT_HOURS, TRUCK_CAPACITY_TONS
from app.forecast import baseline as baseline_module
from app.forecast.baseline import capacity_recommendation

DAYS = 7  # the twin's default horizon


def open_meteo_week(rain: list[float]) -> dict:
    start = date.today()
    return {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-25T06:00:00+00:00",
        "forecast": [
            {
                "date": (start + timedelta(days=i)).isoformat(),
                "rainfall_mm": mm,
                "temperature_max_c": 31.0,
                "wind_speed_kmh": 10.0,
            }
            for i, mm in enumerate(rain)
        ],
    }


@pytest.fixture()
def forecast_week(monkeypatch):
    payload = open_meteo_week([6.2, 0.0, 12.0, 0.0, 0.0, 3.0, 0.0])
    monkeypatch.setattr(twin_router, "fetch_jakarta_weather_forecast", lambda: payload)
    monkeypatch.setattr(baseline_module, "fetch_jakarta_weather_forecast", lambda: payload)
    baseline_module._cache.clear()
    return payload


def test_baseline_today_is_the_twin_default_frame(api_client, forecast_week):
    base = api_client.get("/api/baseline/today").json()
    scene = api_client.get("/api/twin/scene", params={"days": DAYS}).json()
    summary = scene["summary"]
    assert base["kind"] == "baseline"
    assert base["date"] == date.today().isoformat()
    assert base["total_tonnage_t"] == summary["total_tons_today"]
    assert base["kecamatan_at_risk"] == summary["districts_at_risk"]
    assert base["trucks_needed"] == summary["trucks_required_today"]
    assert base["crews_needed"] == summary["crews_required_today"]
    assert base["kecamatan_count"] == 42 and len(base["kecamatan"]) == 42
    assert base["weather"] == {
        "rainfall_mm": 6.2,
        "input": "forecast",
        "class": "REAL_FORECAST_INPUT",
        "source": "open-meteo",
    }
    assert base["event"] is None and base["scenario"] is None
    assert base["provenance"] == {
        "tonnage": "MODEL_OUTPUT",
        "weather": "REAL_FORECAST_INPUT",
        "fleet": "SIMULATED",
    }


def test_baseline_rows_are_kecamatan_never_cities(api_client, forecast_week):
    base = api_client.get("/api/baseline/today").json()
    names = {row["kecamatan"].upper() for row in base["kecamatan"]}
    assert not any(name.startswith("JAKARTA ") for name in names)
    at_risk = [row for row in base["kecamatan"] if row["risk_level"] in {"high", "critical"}]
    assert len(at_risk) == base["kecamatan_at_risk"]
    assert base["total_tonnage_t"] == pytest.approx(
        sum(r["predicted_tons"] for r in base["kecamatan"]), abs=0.2
    )


def test_fleet_denominator_matches_the_fleet_kpi(api_client, forecast_week):
    base = api_client.get("/api/baseline/today").json()
    snapshot = api_client.get("/api/command-center").json()
    assert base["fleet"]["active"] == snapshot["kpis"]["active_trucks"]
    assert base["fleet"]["total"] == len(snapshot["trucks"])
    assert base["fleet"]["classification"] == "SIMULATED"


def test_scenario_is_labelled_and_keeps_the_baseline_for_comparison(api_client, forecast_week):
    what_if = api_client.get(
        "/api/baseline/scenario", params={"rainfall_mm": 42, "event_attendance": 85_000, "venue": "gbk"}
    ).json()
    base = api_client.get("/api/baseline/today").json()
    assert what_if["kind"] == "scenario"
    assert what_if["weather"]["input"] == "scenario"
    assert what_if["event"]["venue"] == "gbk" and what_if["event"]["kecamatan"]
    assert what_if["baseline"]["total_tonnage_t"] == base["total_tonnage_t"]
    assert what_if["total_tonnage_t"] > base["total_tonnage_t"]


def test_scenario_date_outside_the_week_is_rejected(api_client, forecast_week):
    late = (date.today() + timedelta(days=DAYS)).isoformat()
    response = api_client.get("/api/baseline/scenario", params={"date": late, "rainfall_mm": 10})
    assert response.status_code == 422


def _district(tons: float, normal: float) -> dict:
    return {"series": [{"predicted_tons": tons, "normal_tons": normal}]}


def test_recommendation_is_clamped_to_the_fleet_and_states_the_shortfall():
    # 300 truckloads above the normal day against a 59-unit fleet with 52 on duty.
    at_risk = [_district(1000.0 + 30 * TRUCK_CAPACITY_TONS, 1000.0) for _ in range(10)]
    rec = capacity_recommendation(at_risk, 0, {"active": 52, "total": 59})
    assert rec["extra_trucks_needed"] == 300
    assert rec["fleet_reserve"] == 7
    assert rec["deployable_trucks"] == 7
    assert rec["shortfall_trucks"] == 293
    assert rec["extra_crews_needed"] == rec["extra_trucks_needed"]


def test_recommendation_within_reserve_has_no_shortfall():
    rec = capacity_recommendation([_district(118.0, 100.0)], 0, {"active": 52, "total": 59})
    assert rec["extra_trucks_needed"] == 1
    assert (rec["deployable_trucks"], rec["shortfall_trucks"]) == (1, 0)


def test_scenario_recommendation_never_exceeds_the_fleet(api_client, forecast_week):
    what_if = api_client.get(
        "/api/baseline/scenario", params={"rainfall_mm": 80, "event_attendance": 200_000, "venue": "gbk"}
    ).json()
    rec, fleet = what_if["recommendation"], what_if["fleet"]
    assert rec["deployable_trucks"] <= fleet["total"] - fleet["active"]
    assert rec["deployable_trucks"] + rec["shortfall_trucks"] == rec["extra_trucks_needed"]


def test_facility_gap_uses_the_baseline_tonnes_with_outlook(api_client, forecast_week):
    base = api_client.get("/api/baseline/today").json()
    gap = api_client.get("/api/facilities/gap-analysis", params={"outlook": "true"}).json()
    by_slug = {row["slug"]: row["predicted_tons"] for row in base["kecamatan"]}
    assert gap["scenario"]["outlook"] == "baseline"
    assert gap["areas"]
    for area in gap["areas"]:
        assert area["predicted_tons_per_day"] == pytest.approx(by_slug[area["slug"]], abs=0.05)
    assert gap["assumptions"]["coverage_code"] == "tps_proxy_partial_coverage"


def test_outlook_units_carry_shift_hours_and_bin_capacity(api_client, forecast_week):
    units = api_client.get("/api/baseline/today").json()["units"]
    assert units["shift_hours"] == SHIFT_HOURS and units["bin_capacity_tons"] == BIN_CAPACITY_TONS
    assert units["truck_capacity_tons"] == TRUCK_CAPACITY_TONS
