"""The twin opens on the real forecast week, and a what-if moves only its own day.

Weather is stubbed at the module the router reads it from, so these tests never
depend on Open-Meteo being reachable.
"""

from datetime import date, timedelta

import pytest

from app.api.routers import twin as twin_router
from app.core.units import EVENT_WASTE_KG_PER_PERSON
from app.forecast import weather as weather_module
from app.forecast.engine import AT_RISK_LEVELS, predict_waste_hybrid_series, rolling_rain_3d
from app.forecast.twin import EVENT_REACH_RADIUS_M, event_reach
from app.forecast.weather import real_forecast_by_date

DAYS = 7  # the twin's horizon: every test shares its cached model series


def open_meteo_week(rain: list[float]) -> dict:
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


UNREACHABLE = {"source": "fallback-demo", "kind": "demo", "fetched_at": None, "forecast": []}


@pytest.fixture()
def weather(monkeypatch):
    """Set what Open-Meteo 'returns' to the twin router for this test."""

    def use(payload: dict) -> None:
        monkeypatch.setattr(twin_router, "fetch_jakarta_weather_forecast", lambda: payload)

    use(UNREACHABLE)
    return use


def scene(api_client, **params) -> dict:
    response = api_client.get("/api/twin/scene", params={"days": DAYS, **params})
    assert response.status_code == 200, response.text
    return response.json()


def tons(scene_payload: dict, day: int) -> dict[str, float]:
    return {d["id"]: d["series"][day]["predicted_tons"] for d in scene_payload["districts"]}


def test_series_takes_per_day_inputs_and_rolls_rain_3d_like_training():
    assert rolling_rain_3d((10.0, 0.0, 5.0, 0.0, 0.0)) == [10.0, 10.0, 15.0, 5.0, 5.0]
    dry = predict_waste_hybrid_series(
        "menteng", days=DAYS, rainfall_mm=(0.0,) * DAYS, start_date="2026-08-10"
    )
    event = (0, 0, 50_000, 0, 0, 0, 0)
    crowd = predict_waste_hybrid_series(
        "menteng", days=DAYS, rainfall_mm=(0.0,) * DAYS, event_attendance=event, start_date="2026-08-10"
    )
    changed = [
        i for i in range(DAYS) if crowd["series"][i]["predicted_tons"] != dry["series"][i]["predicted_tons"]
    ]
    assert changed == [2]
    # The documented per-capita overlay reaches the series path too; the residual
    # model adds its own (district-specific) event response on top.
    overlay = 50_000 * EVENT_WASTE_KG_PER_PERSON / 1000.0
    assert crowd["series"][2]["predicted_tons"] - dry["series"][2]["predicted_tons"] >= overlay - 0.5
    assert crowd["inputs_per_day"] is True and crowd["series"][2]["event_attendance"] == 50_000


def test_event_what_if_changes_only_its_day(api_client, weather):
    base = scene(api_client, weather="none")
    what_if = scene(api_client, weather="none", event_attendance=50_000, venue="jis", day=1)
    assert what_if["scenario"]["scenario_day"] == 1
    assert what_if["scenario"]["scenario_date"] == what_if["horizon"]["dates"][1]
    for day in range(DAYS):
        moved = tons(what_if, day) != tons(base, day)
        assert moved is (day == 1), f"day {day} moved={moved}"


def test_rain_what_if_moves_only_its_own_day(api_client, weather):
    base = scene(api_client, weather="none")
    wet = scene(api_client, weather="none", rainfall_mm=120, day=2)
    assert [row["input"] for row in wet["weather"]["days"]][1:4] == ["assumed_dry", "scenario", "assumed_dry"]
    assert sum(tons(wet, 2).values()) > sum(tons(base, 2).values())
    # The what-if's rain is never carried into the next days' 3-day rain sum: the
    # training target has no multi-day rain effect, and the next days would read
    # "no rain" while moving.
    for day in range(DAYS):
        if day != 2:
            assert tons(wet, day) == tons(base, day), f"day {day} moved"
    days = wet["weather"]["days"]
    assert [row["carried_rain_mm"] for row in days] == [0.0] * DAYS
    assert days[2]["rain_3d_mm"] == 120.0 and days[3]["rain_3d_mm"] == 0.0
    assert wet["weather"]["carry_over"]["scenario"] is False
    # A pinned scenario day stays put while the viewed day moves.
    pinned = scene(api_client, weather="none", rainfall_mm=120, scenario_day=2, day=4)
    assert pinned["scenario"]["day"] == 4 and pinned["scenario"]["scenario_day"] == 2
    assert tons(pinned, 2) == tons(wet, 2)


def test_default_scene_opens_on_the_forecast_rain_and_labels_it(api_client, weather):
    weather(open_meteo_week([0.0, 0.0, 120.0, 0.0, 0.0, 0.0, 0.0]))
    payload = scene(api_client)  # the twin's bare request: no rain, no event asked
    block = payload["weather"]
    assert block["source"] == "open-meteo" and block["kind"] == "forecast"
    assert block["class"] == "REAL_FORECAST_INPUT"
    assert "not observed" in block["label"]
    assert block["fetched_at"] == "2026-10-24T10:58:00+00:00"
    assert [row["input"] for row in block["days"]] == ["forecast"] * DAYS
    assert payload["scenario"]["rainfall_mm"] == 0 and payload["scenario"]["weather"] == "forecast"
    # The forecast rain drives the model; the normal day stays dry, so day 2 shows risk.
    rows = [d["series"][2] for d in payload["districts"]]
    assert all(row["rainfall_mm"] == 120.0 for row in rows)
    at_risk = payload["horizon"]["daily_districts_at_risk"]
    assert at_risk[2] > 0 and at_risk[0] == 0
    assert payload["provenance"]["districts"]["class"] == "MODEL_OUTPUT"


def test_unreachable_forecast_falls_back_to_dry_days_with_an_honest_label(api_client, weather):
    weather(UNREACHABLE)
    first = scene(api_client)
    block = first["weather"]
    assert block["source"] == "unavailable" and block["class"] == "UNAVAILABLE"
    assert "unreachable" in block["label"] and block["fetched_at"] is None
    assert {row["input"] for row in block["days"]} == {"assumed_dry"}
    # The demo fallback's invented rain never reaches the model.
    assert all(row["rainfall_mm"] == 0.0 for d in first["districts"] for row in d["series"])
    assert first["horizon"]["daily_districts_at_risk"] == [0] * DAYS
    assert scene(api_client)["summary"] == first["summary"]  # deterministic
    assert (
        real_forecast_by_date({**UNREACHABLE, "forecast": [{"date": "2026-10-24", "rainfall_mm": 42.0}]})
        == {}
    )


def test_weather_fetch_marks_forecast_and_demo_fallback(monkeypatch):
    def offline(*_args, **_kwargs):
        raise OSError("no network")

    monkeypatch.setattr(weather_module, "_WEATHER_CACHE", None)
    monkeypatch.setattr(weather_module, "urlopen", offline)
    payload = weather_module.fetch_jakarta_weather_forecast()
    assert payload["source"] == "fallback-demo" and payload["kind"] == "demo"
    assert real_forecast_by_date(payload) == {}
    week = open_meteo_week([12.5] * DAYS)
    assert real_forecast_by_date(week)[week["forecast"][0]["date"]]["rainfall_mm"] == 12.5


def test_event_reaches_the_districts_around_its_venue_by_geography(api_client, weather):
    # JIS sits inside Tanjung Priok, on the Pademangan boundary: both take the crowd.
    assert event_reach(-6.1246, 106.8584)[:2] == ["tanjung_priok", "pademangan"]
    assert event_reach(-6.2183, 106.8022)[0] == "tanah_abang"  # GBK
    assert event_reach(-6.1754, 106.8272)[0] == "gambir"  # Monas

    base = scene(api_client, weather="none")
    jis = scene(api_client, weather="none", event_attendance=50_000, venue="jis", day=1)
    event = jis["scenario"]["event"]
    assert (event["lat"], event["lng"], event["radius_m"]) == (-6.1246, 106.8584, EVENT_REACH_RADIUS_M)
    assert event["districts"][:2] == ["tanjung_priok", "pademangan"]
    assert sum(event["attendance_by_district"].values()) == 50_000
    extra = {k: v - tons(base, 1)[k] for k, v in tons(jis, 1).items()}
    top = sorted(extra, key=extra.get, reverse=True)[: len(event["districts"])]
    assert set(top) == set(event["districts"])
    assert sum(extra[k] for k in event["districts"]) == pytest.approx(event["tons_total"], abs=1.0)
    localized = {d["id"] for d in jis["districts"] if d["event_localized"]}
    assert localized == set(event["districts"])


def test_flows_follow_the_selected_day(api_client, weather):
    for day in (0, 3):
        payload = scene(api_client, weather="none", day=day)
        by_id = {d["id"]: d for d in payload["districts"]}
        assert len(payload["flows"]) == 42
        for flow in payload["flows"]:
            series = by_id[flow["district"]]["series"]
            assert flow["day"] == day
            assert flow["tons"] == series[day]["predicted_tons"]
            assert flow["tons_by_day"] == [row["predicted_tons"] for row in series]


def test_scene_names_generated_waste_apart_from_landfill_intake(api_client, weather):
    payload = scene(api_client, weather="none")
    assert payload["summary"]["tons_quantity"] == "waste_generated"
    assert payload["quantities"]["district_tons"]["id"] == "waste_generated"
    intake = payload["quantities"]["landfill_intake_reference"]
    assert intake["quantity"] == "landfill_intake"
    assert intake["classification"] == "MODEL OUTPUT"
    assert intake["month"] == date.today().strftime("%Y-%m")
    assert intake["tons_per_day"] != payload["summary"]["total_tons_today"]


def test_queue_carries_the_staggered_peak_hour_next_to_the_unstaggered_one(api_client, weather):
    queue = scene(api_client, weather="none")["landfill_queue"]
    pair = queue["peak_hour"]
    assert pair["unstaggered"]["hour"] == pair["staggered"]["hour"] == queue["modelled_hour"]
    assert pair["unstaggered"]["mean_wait_minutes"] == queue["avg_wait_minutes"]
    assert pair["staggered"]["classification"] == "SIMULATED"
    assert pair["staggered"]["trucks_per_day"] == queue["trucks_per_day"]
    assert pair["staggered"]["mean_wait_minutes"] < pair["unstaggered"]["mean_wait_minutes"]


def test_risk_count_uses_the_one_definition(api_client, weather):
    weather(open_meteo_week([0.0, 120.0, 0.0, 0.0, 0.0, 0.0, 0.0]))
    payload = scene(api_client)
    for i, count in enumerate(payload["horizon"]["daily_districts_at_risk"]):
        assert count == sum(1 for d in payload["districts"] if d["series"][i]["risk"] in AT_RISK_LEVELS)
    assert payload["summary"]["districts_at_risk"] == payload["horizon"]["daily_districts_at_risk"][0]
    assert "normal day" in payload["summary"]["risk_basis"]


def test_a_forecast_rain_day_scales_the_queue_and_says_so(api_client, weather):
    weather(open_meteo_week([120.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]))
    queue = scene(api_client)["landfill_queue"]
    metric = queue["minutes_per_truck"]
    assert metric["scenario_scaled"] is True
    assert metric["trucks_per_day"] > metric["normal_day"]["trucks_per_day"]
    assert queue["day_basis"]["id"] == "forecast_weather"
    assert "forecast" in queue["day_basis"]["label"]


def test_district_forecast_shares_the_crowd_like_the_twin(api_client):
    """/api/predictions/kecamatan uses the twin's boundary reach, and shares the crowd."""
    from app.forecast.twin import event_attendance_by_district

    lat, lng = -6.1754, 106.8272
    body = api_client.get(
        "/api/predictions/kecamatan",
        params={"event_attendance": 50000, "event_lat": lat, "event_lng": lng},
    ).json()
    expected = event_attendance_by_district(50000, lat, lng)
    assert body["scenario"]["attendance_by_kecamatan"] == expected
    assert body["scenario"]["targeted_kecamatan"] == sorted(expected)
    assert sum(expected.values()) == 50000  # shared out, never copied to every district
    assert f"{EVENT_REACH_RADIUS_M / 1000:g} km" in body["scenario"]["event_reach_basis"]
