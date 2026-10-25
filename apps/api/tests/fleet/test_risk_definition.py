"""Fleet and Twin share one risk definition: the same date gives the same at-risk count.

Both read the same per-kecamatan model series against the same normal day
(same model, same date, no rain, no event) through engine.spike_risk.
"""

from datetime import date, timedelta

import pytest

from app.api.routers import twin as twin_router
from app.fleet import data
from app.forecast import real_data, weather
from app.forecast.engine import spike_risk


def _week(rain: list[float]) -> dict:
    today = date.today()
    return {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-24T10:58:00+00:00",
        "forecast": [
            {
                "date": (today + timedelta(days=i)).isoformat(),
                "rainfall_mm": mm,
                "temperature_max_c": 31.0,
                "wind_speed_kmh": 10.0,
            }
            for i, mm in enumerate(rain)
        ],
    }


@pytest.fixture()
def rainy_week(monkeypatch):
    payload = _week([0.0, 120.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    monkeypatch.setattr(weather, "fetch_jakarta_weather_forecast", lambda *a, **k: payload)
    monkeypatch.setattr(twin_router, "fetch_jakarta_weather_forecast", lambda: payload)
    monkeypatch.setattr(real_data, "load_official_events", lambda: [])
    monkeypatch.setitem(data._predictions_cache, "payload", None)
    monkeypatch.setitem(data._predictions_cache, "ts", 0.0)
    return payload


def test_spike_risk_bands_against_the_normal_day():
    assert spike_risk(100, 100) == (0.0, "normal")
    assert spike_risk(104, 100)[1] == "elevated"
    assert spike_risk(111, 100)[1] == "high"
    assert spike_risk(126, 100)[1] == "critical"
    assert spike_risk(50, None) == (0.0, "normal")


def test_twin_risk_count_equals_the_fleet_count_for_the_same_date(api_client, rainy_week):
    predictions = data.build_predictions()
    scene = api_client.get("/api/twin/scene", params={"days": 7}).json()
    assert scene["weather"]["source"] == "open-meteo"

    dates = scene["horizon"]["dates"]
    tomorrow = dates[1]
    fleet_day = [p for p in predictions if p["date"] == tomorrow]
    assert len(fleet_day) == 5  # the five administrative cities
    fleet_count = sum(p["districts_at_risk"] for p in fleet_day)
    assert fleet_count == scene["horizon"]["daily_districts_at_risk"][1] > 0

    # Same tonnes and same normal day per city, so the spike means the same thing.
    for p in fleet_day:
        rows = [d["series"][1] for d in scene["districts"] if d["admin_area"] == p["district"]]
        assert p["predicted_tons"] == pytest.approx(sum(r["predicted_tons"] for r in rows), abs=0.2)
        assert p["baseline_tons"] == pytest.approx(sum(r["normal_tons"] for r in rows), abs=0.2)
        spike, level = spike_risk(p["predicted_tons"], p["baseline_tons"])
        assert p["risk_level"] == level and abs(p["spike_percent"] - spike) <= 1
        assert p["rain_input"] == "open-meteo forecast" and p["rainfall_mm"] == 120.0
        assert "normal day" in p["baseline_basis"]


def test_fleet_never_feeds_the_demo_fallback_rain_to_the_model(monkeypatch):
    demo = {"source": "fallback-demo", "kind": "demo", "forecast": _week([42.0] * 7)["forecast"]}
    monkeypatch.setattr(weather, "fetch_jakarta_weather_forecast", lambda *a, **k: demo)
    monkeypatch.setattr(real_data, "load_official_events", lambda: [])
    monkeypatch.setitem(data._predictions_cache, "payload", None)
    monkeypatch.setitem(data._predictions_cache, "ts", 0.0)
    predictions = data.build_predictions()
    assert {p["rain_input"] for p in predictions} == {"assumed dry"}
    assert all(p["rainfall_mm"] == 0.0 and p["districts_at_risk"] == 0 for p in predictions)
