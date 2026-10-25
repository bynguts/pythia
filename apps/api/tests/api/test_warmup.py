"""Startup warm-up: the twin scene it builds is the one a bare /twin load hits."""

from app.api import warmup
from app.api.routers import operations, twin
from app.forecast.engine import predict_waste_hybrid_series

# What the twin workspace requests on first load (useTwinScene.scenePath):
# default city, the 7-day horizon, no what-if rain, no event, today; the base
# week is the route's default Open-Meteo forecast.
DEFAULT_TWIN_QUERY = {"city": "jakarta", "days": "7", "rainfall_mm": "0"}
# What the forecast fetch returned (cached 300 s in production, shared by both calls).
FORECAST = {"source": "fallback-demo", "kind": "demo", "fetched_at": None, "forecast": []}


def test_twin_warmup_builds_the_scene_a_default_twin_request_hits(api_client, monkeypatch):
    monkeypatch.setattr(twin, "fetch_jakarta_weather_forecast", lambda: FORECAST)
    # Called directly, so a rejected argument raises here instead of being
    # swallowed into the "Twin scene warmup failed" startup log line.
    scene = warmup.warm_twin_scene()

    assert scene["city"]["id"] == "jakarta"
    assert scene["horizon"]["days"] == 7
    assert {key: scene["scenario"][key] for key in DEFAULT_SCENARIO} == DEFAULT_SCENARIO
    assert len(scene["districts"]) == 42

    # The default request finds every per-kecamatan series (week and normal day)
    # already built: no cold model run.
    before = predict_waste_hybrid_series.cache_info()
    response = api_client.get("/api/twin/scene", params=DEFAULT_TWIN_QUERY)
    after = predict_waste_hybrid_series.cache_info()

    assert response.status_code == 200
    assert after.misses == before.misses
    assert after.hits - before.hits >= 2 * 42
    assert response.json()["summary"] == scene["summary"]
    assert response.json()["scenario"] == scene["scenario"]


DEFAULT_SCENARIO = {
    "rainfall_mm": 0.0,
    "event_attendance": 0,
    "event_lat": None,
    "event_lng": None,
    "venue": None,
    "day": 0,
    "scenario_day": 0,
    "weather": "forecast",
    "event": None,
}


def test_tpa_warmup_fills_the_cache_keys_the_queue_route_serves(api_client, monkeypatch):
    # The route reads the cache dict through the operations module; start empty
    # so nothing an earlier request cached can stand in for the warm-up.
    cache: dict = {}
    monkeypatch.setattr(operations, "_tpa_cache", cache)

    warmup.warm_tpa_queue()

    assert set(cache) == {"live", "peak"}
    assert cache["live"]["payload"]["scenario"] == "live"
    assert cache["peak"]["payload"]["scenario"] == "peak"

    # Inside the cache window the route serves those entries without recomputing.
    def cold_build(*_args, **_kwargs):
        raise AssertionError("queue-status rebuilt instead of serving the warm entry")

    monkeypatch.setattr(operations, "tpa_queue_status_payload", cold_build)
    live = api_client.get("/api/tpa/queue-status")
    peak = api_client.get("/api/tpa/queue-status", params={"scenario": "peak"})
    assert live.status_code == 200 and live.json() == cache["live"]["payload"]
    assert peak.status_code == 200 and peak.json() == cache["peak"]["payload"]
