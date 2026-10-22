"""Pythia Twin scene: per-layer provenance, horizon series and scenario response."""

import re
from datetime import date

import pytest

from app.api.routers.twin import MAX_TWIN_DAYS
from app.core.paths import REPO_ROOT
from app.forecast.cities import (
    HCMC_DAILY_TONS,
    HCMC_DISTRICTS,
    HCMC_POPULATION_2019,
    VENUES,
    hcmc_district_forecasts,
)
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


def test_scene_carries_crews_next_to_trucks(api_client):
    scene = api_client.get("/api/twin/scene", params={"days": 2}).json()
    for district in scene["districts"]:
        for row in district["series"]:
            assert row["crews_required"] == row["trucks_required"]  # 1 crew team per truck per shift
    horizon, summary = scene["horizon"], scene["summary"]
    assert len(horizon["daily_trucks_required"]) == len(horizon["daily_crews_required"]) == 2
    assert horizon["daily_trucks_required"][0] == summary["trucks_required_today"]
    assert horizon["daily_crews_required"][0] == summary["crews_required_today"] > 0
    assert "crews_required" in scene["units"]


def test_scene_exposes_the_backend_venue_presets(api_client):
    jakarta = api_client.get("/api/twin/scene", params={"days": 2}).json()
    assert [v["id"] for v in jakarta["venues"]] == ["gbk", "jis", "monas"]
    assert jakarta["venues"][0] == {"id": "gbk", "name": "GBK", "lat": -6.2183, "lng": 106.8022}
    hcmc = api_client.get("/api/twin/scene", params={"city": "hcmc", "days": 2}).json()
    assert [v["id"] for v in hcmc["venues"]] == ["d1"]


def test_venue_places_the_event_and_rain_plus_event_scales_the_queue(api_client):
    params = {"days": 2, "rainfall_mm": 80, "event_attendance": 50_000, "venue": "jis", "day": 1}
    scene = api_client.get("/api/twin/scene", params=params).json()
    assert scene["scenario"]["venue"] == "jis" and scene["scenario"]["day"] == 1
    assert (scene["scenario"]["event_lat"], scene["scenario"]["event_lng"]) == (-6.1246, 106.8584)
    metric = scene["landfill_queue"]["minutes_per_truck"]
    assert metric["scenario_scaled"] is True
    assert metric["trucks_per_day"] > metric["normal_day"]["trucks_per_day"]
    assert metric["baseline_mean"] > metric["normal_day"]["baseline_mean"]
    assert metric["classification"] == "SIMULATED"
    # The scaling follows the selected day's scenario vs normal-day tonnes.
    # The count is rounded to truck_step steps from the normal day (one cached run per step).
    ratio = metric["scaling"]["tonnage_ratio"]
    unrounded = metric["normal_day"]["trucks_per_day"] * ratio
    assert metric["scaling"]["unrounded_trucks_per_day"] == pytest.approx(unrounded, abs=1)
    assert abs(metric["trucks_per_day"] - unrounded) <= metric["scaling"]["truck_step"] / 2 + 1
    # An unknown venue id is rejected; another city's venue is ignored.
    assert api_client.get("/api/twin/scene", params={"venue": "atlantis"}).status_code == 422
    hcmc = api_client.get(
        "/api/twin/scene", params={"city": "hcmc", "days": 2, "event_attendance": 50_000, "venue": "gbk"}
    ).json()
    assert hcmc["scenario"]["venue"] is None


def test_scenario_names_the_venue_only_when_the_event_sits_on_its_coordinates(api_client):
    base = {"city": "hcmc", "days": 2, "venue": "d1"}
    on_preset = api_client.get("/api/twin/scene", params={**base, "event_attendance": 50_000}).json()
    assert on_preset["scenario"]["venue"] == "d1"
    elsewhere = api_client.get(
        "/api/twin/scene",
        params={**base, "event_attendance": 50_000, "event_lat": 10.80, "event_lng": 106.65},
    ).json()
    assert elsewhere["scenario"]["venue"] is None
    assert (elsewhere["scenario"]["event_lat"], elsewhere["scenario"]["event_lng"]) == (10.80, 106.65)
    no_event = api_client.get("/api/twin/scene", params=base).json()
    assert no_event["scenario"]["venue"] is None


def test_selected_day_is_bounded_by_the_longest_horizon(api_client):
    too_far = {"city": "hcmc", "days": MAX_TWIN_DAYS, "day": MAX_TWIN_DAYS}
    assert api_client.get("/api/twin/scene", params=too_far).status_code == 422
    assert api_client.get("/api/twin/scene", params={"days": MAX_TWIN_DAYS + 1}).status_code == 422
    last = api_client.get("/api/twin/scene", params={**too_far, "day": MAX_TWIN_DAYS - 1})
    assert last.status_code == 200 and last.json()["scenario"]["day"] == MAX_TWIN_DAYS - 1


def test_web_twin_venues_match_the_backend_presets():
    """twinLinks.js keeps a fallback copy of the venues; it must not drift from cities.py."""
    source = (REPO_ROOT / "apps/web/src/features/twin/twinLinks.js").read_text(encoding="utf-8")
    block = re.search(r"export const TWIN_VENUES = \{(.*?)\n\};", source, re.S)
    assert block, "TWIN_VENUES not found in twinLinks.js"
    web: dict[str, list[tuple[str, str, float, float]]] = {}
    for city, body in re.findall(r"(\w+): \[(.*?)\]", block.group(1), re.S):
        web[city] = [
            (vid, name, float(lat), float(lng))
            for vid, name, lat, lng in re.findall(
                r'\{\s*id: "([^"]+)",\s*name: "([^"]+)",\s*lat: (-?[\d.]+),\s*lng: (-?[\d.]+)\s*\}', body
            )
        ]
    backend = {city: [(v.id, v.name, v.lat, v.lng) for v in venues] for city, venues in VENUES.items()}
    assert web == backend
