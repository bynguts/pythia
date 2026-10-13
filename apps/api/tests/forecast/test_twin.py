"""Pythia Twin scene: per-layer provenance, horizon series and scenario response."""

from datetime import date

import pytest

from app.forecast.cities import HCMC_DAILY_TONS, HCMC_DISTRICTS, HCMC_POPULATION_2019, hcmc_district_forecasts
from app.forecast.twin import classify_risk

MONDAY = date(2026, 10, 12)


def test_risk_bands_measure_spike_against_normal_day():
    assert classify_risk(100, 100) == "normal"
    assert classify_risk(104, 100) == "elevated"
    assert classify_risk(111, 100) == "high"
    assert classify_risk(126, 100) == "critical"
    assert classify_risk(50, None) == "normal"


def test_hcmc_census_populations_sum_to_published_total():
    assert sum(row[4] for row in HCMC_DISTRICTS) == HCMC_POPULATION_2019


def test_hcmc_weekday_allocation_reproduces_citywide_total():
    districts = hcmc_district_forecasts(1, start=MONDAY)
    total = sum(d["series"][0]["predicted_tons"] for d in districts)
    assert total == pytest.approx(HCMC_DAILY_TONS, abs=2.0)


def test_hcmc_event_lands_in_nearest_district_only():
    districts = hcmc_district_forecasts(
        1, event_attendance=50_000, event_lat=10.7769, event_lng=106.7009, start=MONDAY
    )
    localized = [d for d in districts if d["event_localized"]]
    assert [d["id"] for d in localized] == ["district_1"]
    assert localized[0]["series"][0]["predicted_tons"] == pytest.approx(
        localized[0]["baseline_tons"] + 60.0, abs=0.2
    )


def test_jakarta_scene_has_all_districts_and_honest_provenance(api_client):
    response = api_client.get("/api/twin/scene", params={"city": "jakarta", "days": 3})
    assert response.status_code == 200
    scene = response.json()
    assert scene["city"]["id"] == "jakarta"
    assert len(scene["districts"]) == 42
    assert scene["horizon"]["days"] == 3
    assert all(len(d["series"]) == 3 for d in scene["districts"])
    assert all(
        row["risk"] in {"normal", "elevated", "high", "critical"}
        for d in scene["districts"]
        for row in d["series"]
    )
    assert len(scene["tps"]) > 1000
    assert scene["trucks"] and all(len(t["path"]) >= 2 for t in scene["trucks"])
    assert scene["provenance"]["districts"]["class"] == "MODEL_OUTPUT"
    assert scene["provenance"]["trucks"]["class"] == "SIMULATED"
    assert any(f["kind"] == "landfill" for f in scene["facilities"])
    assert len(scene["flows"]) == 42


def test_rain_scenario_raises_jakarta_volumes_and_risk(api_client):
    dry = api_client.get("/api/twin/scene", params={"days": 2}).json()
    wet = api_client.get("/api/twin/scene", params={"days": 2, "rainfall_mm": 80}).json()
    assert wet["summary"]["total_tons_today"] > dry["summary"]["total_tons_today"]
    # A dry, event-free day is the normal day itself: nothing is flagged.
    assert dry["summary"]["districts_at_risk"] == 0
    assert all(d["risk"] == "normal" for d in dry["districts"])
    assert wet["summary"]["districts_at_risk"] > 0


def test_hcmc_scene_is_labelled_demo_city(api_client):
    scene = api_client.get("/api/twin/scene", params={"city": "hcmc", "days": 2}).json()
    assert scene["city"]["data_class"] == "SIMULATED_DEMO_CITY"
    assert scene["provenance"]["districts"]["class"] == "SIMULATED_DEMO_CITY"
    assert len(scene["districts"]) == len(HCMC_DISTRICTS)
    assert scene["trucks"] == [] and scene["tps"] == []


def test_unknown_city_is_rejected(api_client):
    assert api_client.get("/api/twin/scene", params={"city": "atlantis"}).status_code == 422
