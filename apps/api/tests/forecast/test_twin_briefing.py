"""Decision room briefing: at most three scenarios, today's canonical baseline beside each.

Weather is stubbed where the baseline reads it, so the numbers never depend on
Open-Meteo being reachable.
"""

import re
from datetime import date, timedelta

import pytest

from app.api.routers import twin as twin_router
from app.core.paths import REPO_ROOT
from app.fleet.queue_simulation import WEIGHBRIDGE_LANES, scenario_queue_metric
from app.forecast import baseline as baseline_module
from app.forecast.twin import BRIEFING_SCENARIOS


@pytest.fixture()
def dry_week(monkeypatch):
    start = date.today()
    payload = {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-25T06:00:00+00:00",
        "forecast": [
            {
                "date": (start + timedelta(days=i)).isoformat(),
                "rainfall_mm": 0.0,
                "temperature_max_c": 31.0,
                "wind_speed_kmh": 10.0,
            }
            for i in range(7)
        ],
    }
    monkeypatch.setattr(twin_router, "fetch_jakarta_weather_forecast", lambda: payload)
    monkeypatch.setattr(baseline_module, "fetch_jakarta_weather_forecast", lambda: payload)
    baseline_module._cache.clear()
    return payload


def test_catalogue_holds_at_most_three_scenarios_with_resolved_venues(api_client):
    body = api_client.get("/api/twin/scenarios").json()
    assert body["date"] == date.today().isoformat()
    ids = [s["id"] for s in body["scenarios"]]
    assert ids == list(BRIEFING_SCENARIOS) and 1 <= len(ids) <= 3
    gbk = next(s for s in body["scenarios"] if s["id"] == "gbk_event")
    assert (gbk["event_lat"], gbk["event_lng"]) == (-6.2183, 106.8022)
    assert gbk["event_attendance"] == 50_000
    rain = next(s for s in body["scenarios"] if s["id"] == "heavy_rain")
    assert rain["rainfall_mm"] == 50.0 and rain["event_lat"] is None
    assert rain["classification"] == "MODEL_OUTPUT"
    lane = next(s for s in body["scenarios"] if s["id"] == "weighbridge_lane_down")
    assert lane["weighbridge_lanes"] == WEIGHBRIDGE_LANES - 1
    assert lane["classification"] == "SIMULATED" and lane["basis"].startswith("assumption:")


def test_briefing_before_is_the_canonical_baseline_and_after_its_scenario(api_client, dry_week):
    base = api_client.get("/api/baseline/today").json()
    for scenario_id in BRIEFING_SCENARIOS:
        body = api_client.get("/api/twin/briefing", params={"scenario": scenario_id}).json()
        before, after = body["before"], body["after"]
        assert body["scenario"]["id"] == scenario_id
        assert before["date"] == after["date"] == base["date"]
        assert before["total_tonnage_t"] == base["total_tonnage_t"]
        assert before["trucks_needed"] == base["trucks_needed"]
        assert before["kecamatan_at_risk"] == base["kecamatan_at_risk"]
        spec = body["scenario"]
        what_if = api_client.get(
            "/api/baseline/scenario",
            params={
                "rainfall_mm": spec["rainfall_mm"],
                "event_attendance": spec["event_attendance"],
                **({"venue": spec["venue"]} if spec["venue"] else {}),
            },
        ).json()
        assert after["total_tonnage_t"] == what_if["total_tonnage_t"]
        assert after["trucks_needed"] == what_if["trucks_needed"] >= before["trucks_needed"]
        if spec["weighbridge_lanes"]:  # a lane closed changes the queue, not the waste
            assert after["total_tonnage_t"] == before["total_tonnage_t"]
        else:
            assert after["total_tonnage_t"] > before["total_tonnage_t"]
        assert body["classification"] == {
            "tonnage": "MODEL_OUTPUT",
            "trucks": "MODEL_OUTPUT",
            "queue": "SIMULATED",
        }


def test_briefing_queue_is_the_beacon_metric_scaled_by_the_day(api_client, dry_week):
    body = api_client.get("/api/twin/briefing", params={"scenario": "heavy_rain"}).json()
    base = api_client.get("/api/baseline/today").json()
    metric = scenario_queue_metric(base["total_tonnage_t"], base["normal_day_tonnage_t"])
    assert body["before"]["queue_minutes_per_truck"] == metric["baseline_mean"]
    # A dry day is its own normal day: the Fleet KPI's unscaled queue.
    assert body["before"]["queue_trips_per_day"] == scenario_queue_metric()["trucks_per_day"]
    assert body["after"]["queue_trips_per_day"] > body["before"]["queue_trips_per_day"]
    assert body["after"]["queue_minutes_per_truck"] >= body["before"]["queue_minutes_per_truck"]


def test_lane_down_briefing_is_the_same_day_through_one_lane_fewer(api_client, dry_week):
    body = api_client.get("/api/twin/briefing", params={"scenario": "weighbridge_lane_down"}).json()
    before, after = body["before"], body["after"]
    lanes = WEIGHBRIDGE_LANES - 1
    assert (after["total_tonnage_t"], after["trucks_needed"]) == (
        before["total_tonnage_t"],
        before["trucks_needed"],
    )
    assert (before["weighbridge_lanes"], after["weighbridge_lanes"]) == (WEIGHBRIDGE_LANES, lanes)
    assert after["queue_trips_per_day"] == before["queue_trips_per_day"]
    base = api_client.get("/api/baseline/today").json()
    closed = scenario_queue_metric(base["total_tonnage_t"], base["normal_day_tonnage_t"], lanes=lanes)
    assert after["queue_minutes_per_truck"] == closed["baseline_mean"] > before["queue_minutes_per_truck"]
    assert "what-if assumption" in body["basis"]["queue"]
    assert body["classification"]["queue"] == "SIMULATED"


def test_unknown_briefing_scenario_is_rejected(api_client):
    assert api_client.get("/api/twin/briefing", params={"scenario": "zone_4_closed"}).status_code == 422


def test_briefing_without_a_scenario_is_today_only(api_client, dry_week):
    body = api_client.get("/api/twin/briefing").json()
    assert body["scenario"] is None and body["after"] is None
    assert (
        body["before"]["total_tonnage_t"] == api_client.get("/api/baseline/today").json()["total_tonnage_t"]
    )


def test_web_briefing_scenarios_match_the_backend_catalogue():
    """twinLinks.js mirrors the catalogue (the twin and XR apply it without a fetch)."""
    source = (REPO_ROOT / "apps/web/src/features/twin/twinLinks.js").read_text(encoding="utf-8")
    block = re.search(r"export const TWIN_SCENARIOS = \[(.*?)\n\];", source, re.S)
    assert block, "TWIN_SCENARIOS not found in twinLinks.js"
    presets = {"none": 0, "50k": 50_000, "100k": 100_000}
    web = [
        (
            sid,
            float(rain),
            presets[event],
            None if venue == "null" else venue.strip('"'),
            int(lanes) if lanes else None,
        )
        for sid, rain, event, venue, lanes in re.findall(
            r'\{ id: "([^"]+)", rain: ([\d.]+), event: "([^"]+)", venue: (null|"[^"]+")(?:, lanes: (\d+))? \}',
            block.group(1),
        )
    ]
    backend = [
        (sid, spec["rainfall_mm"], spec["event_attendance"], spec["venue"], spec["weighbridge_lanes"])
        for sid, spec in BRIEFING_SCENARIOS.items()
    ]
    assert web == backend
