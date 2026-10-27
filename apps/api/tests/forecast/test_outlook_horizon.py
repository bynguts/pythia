"""/api/forecast/outlook?days=7|14|30: the horizon the Tomorrow page switches between.

Weather, official events, permits and holidays are stubbed at the module that reads them
(as in test_forecast_outlook.py). Open-Meteo is stubbed to cover the first 16 days, as it
does live (forecast_days=16), so only the 30-day horizon carries days past the weather window.
"""

from datetime import date, timedelta
from math import ceil

import pytest

from app.api import state
from app.core.units import TRUCK_CAPACITY_TONS
from app.forecast import baseline as baseline_module
from app.forecast import outlook as outlook_module

TODAY = date.today()
WEATHER_DAYS = 16


@pytest.fixture()
def horizon_inputs(monkeypatch):
    payload = {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-25T06:00:00+00:00",
        "forecast": [
            {
                "date": (TODAY + timedelta(days=i)).isoformat(),
                "rainfall_mm": 30.0 if i == 2 else 0.0,
                "temperature_max_c": 31.0,
                "wind_speed_kmh": 10.0,
            }
            for i in range(WEATHER_DAYS)
        ],
    }
    monkeypatch.setattr(baseline_module, "fetch_jakarta_weather_forecast", lambda: payload)
    monkeypatch.setattr(baseline_module, "load_official_events", lambda: [])
    monkeypatch.setattr(baseline_module.PERMIT_STORE, "list", lambda: [])
    monkeypatch.setattr(baseline_module, "_holiday_names", lambda: {})
    baseline_module._cache.clear()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)
    yield
    baseline_module._cache.clear()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)


def _get(api_client, auth_headers, days=None):
    params = {} if days is None else {"days": days}
    return api_client.get("/api/forecast/outlook", params=params, headers=auth_headers("dispatcher"))


@pytest.mark.parametrize("days", [7, 14, 30])
def test_each_horizon_returns_that_many_consecutive_days(api_client, auth_headers, horizon_inputs, days):
    body = _get(api_client, auth_headers, days).json()
    assert body["horizon_days"] == body["week"]["horizon_days"] == days
    assert body["horizons_available"] == [7, 14, 30]
    week = body["week"]["days"]
    assert [d["date"] for d in week] == [(TODAY + timedelta(days=i)).isoformat() for i in range(days)]
    for day in week:
        assert day["provenance"] == "MODEL OUTPUT" and day["total_tons"] > 0
        assert {d["kind"] for d in day["drivers"]} >= {"weather", "weekday"}
    # The months block stays whatever the horizon.
    assert len(body["monthly_intake"]["months"]) == 3


def test_default_is_seven_days(api_client, auth_headers, horizon_inputs):
    body = _get(api_client, auth_headers).json()
    assert body["horizon_days"] == 7 and len(body["week"]["days"]) == 7


@pytest.mark.parametrize("days", [9, 0, 31, -7])
def test_other_horizons_are_rejected(api_client, auth_headers, horizon_inputs, days):
    assert _get(api_client, auth_headers, days).status_code == 422


def test_days_past_the_weather_window_are_flagged_and_fed_dry_defaults(
    api_client, auth_headers, horizon_inputs
):
    week = _get(api_client, auth_headers, 30).json()["week"]
    flags = [d["beyond_weather_forecast"] for d in week["days"]]
    assert flags == [False] * WEATHER_DAYS + [True] * (30 - WEATHER_DAYS)
    for day in week["days"][WEATHER_DAYS:]:
        (weather,) = [d for d in day["drivers"] if d["kind"] == "weather"]
        assert weather["input_classification"] == "NOT_OBSERVED" and weather["detail"]["rainfall_mm"] == 0.0
    summary = week["summary"]
    assert summary["days_with_weather_forecast"] == WEATHER_DAYS
    assert summary["days_beyond_weather_forecast"] == 30 - WEATHER_DAYS
    # The note states what the model is really fed, not climatology.
    assert "0 mm rain" in week["weather_window_note"] and "not climatology" in week["weather_window_note"]


@pytest.mark.parametrize("days", [7, 14, 30])
def test_aggregates_are_consistent_with_the_days(api_client, auth_headers, horizon_inputs, days):
    week = _get(api_client, auth_headers, days).json()["week"]
    totals = [d["total_tons"] for d in week["days"]]
    summary = week["summary"]
    assert summary["total_tons"] == pytest.approx(sum(totals), abs=0.11)
    assert summary["avg_tons_per_day"] == pytest.approx(sum(totals) / days, abs=0.06)
    assert summary["peak_tons"] == max(totals)
    assert summary["peak_date"] == week["days"][totals.index(max(totals))]["date"]
    assert summary["provenance"] == "MODEL OUTPUT"
    # Per-kecamatan truckloads at 18 t: at least the city total in whole trucks, and the same
    # count the baseline frame gives for that day.
    assert summary["truck_capacity_tons"] == TRUCK_CAPACITY_TONS
    assert summary["peak_trucks_needed"] >= ceil(summary["peak_tons"] / TRUCK_CAPACITY_TONS)
    peak_frame = baseline_module.build_outlook(days=days, target_date=summary["peak_date"])
    assert summary["peak_trucks_needed"] == peak_frame["trucks_needed"]


def test_fourteen_days_run_on_the_weather_forecast(api_client, auth_headers, horizon_inputs):
    week = _get(api_client, auth_headers, 14).json()["week"]
    assert not any(d["beyond_weather_forecast"] for d in week["days"])
    assert week["summary"]["days_with_weather_forecast"] == 14
    assert week["summary"]["days_beyond_weather_forecast"] == 0


def test_open_meteo_is_asked_for_16_days_and_the_panels_keep_the_week():
    from app.forecast import weather

    assert "forecast_days=16" in weather._open_meteo_url()
    dates = [(TODAY + timedelta(days=i)).isoformat() for i in range(16)]
    payload = {
        "daily": {
            "time": dates,
            "temperature_2m_max": [32.0] * 16,
            "temperature_2m_min": [25.0] * 16,
            "precipitation_sum": [float(i) for i in range(16)],
            "precipitation_probability_max": [50] * 16,
            "wind_speed_10m_max": [12.0] * 16,
        }
    }
    result = weather._open_meteo_result(payload, "2026-10-27T00:00:00+00:00", snapshot=False)
    # Panels, Ana and the command-center peak keep reading the first week ...
    assert [d["date"] for d in result["forecast"]] == dates[:7]
    # ... while the models get every day Open-Meteo returned, inputs only.
    assert [d["date"] for d in result["extended_forecast"]] == dates
    assert set(result["extended_forecast"][0]) == {
        "date",
        "rainfall_mm",
        "temperature_max_c",
        "wind_speed_kmh",
    }
    by_date = weather.real_forecast_by_date(result)
    assert list(by_date) == dates and by_date[dates[15]]["rainfall_mm"] == 15.0
    # A payload without the extended list (a saved 7-day snapshot) still reads its week.
    assert list(weather.real_forecast_by_date({**result, "extended_forecast": None})) == dates[:7]


def test_longer_horizons_keep_the_same_first_week(api_client, auth_headers, horizon_inputs):
    week = [d["total_tons"] for d in _get(api_client, auth_headers, 7).json()["week"]["days"]]
    for days in (14, 30):
        longer = [d["total_tons"] for d in _get(api_client, auth_headers, days).json()["week"]["days"]]
        assert longer[:7] == week


def test_each_horizon_is_cached_on_its_own(api_client, auth_headers, horizon_inputs):
    _get(api_client, auth_headers, 30)
    _get(api_client, auth_headers, 7)
    assert set(state._outlook_cache["payload"]) == {7, 30}
    cached_30 = state._outlook_cache["payload"][30]
    _get(api_client, auth_headers, 30)
    assert state._outlook_cache["payload"][30] is cached_30


def test_the_learned_correction_sits_next_to_the_raw_aggregates(
    api_client, auth_headers, horizon_inputs, monkeypatch
):
    correction = {"active": True, "factor": 1.1, "pct": 10.0, "n_days": 5, "min_days": 3, "clamp_pct": 25}
    monkeypatch.setattr(outlook_module, "learned_correction", lambda: correction)
    body = _get(api_client, auth_headers, 14).json()
    summary = body["week"]["summary"]
    assert summary["corrected_total_tons"] == round(summary["total_tons"] * 1.1, 1)
    assert summary["corrected_avg_tons_per_day"] == round(summary["avg_tons_per_day"] * 1.1, 1)
    assert summary["corrected_peak_tons"] == round(summary["peak_tons"] * 1.1, 1)
    assert all(d["corrected_tons"] == round(d["total_tons"] * 1.1, 1) for d in body["week"]["days"])

    monkeypatch.setattr(outlook_module, "learned_correction", lambda: {**correction, "active": False})
    summary = _get(api_client, auth_headers, 14).json()["week"]["summary"]
    assert summary["corrected_total_tons"] is None and summary["corrected_peak_tons"] is None


def test_ana_reads_14_and_30_days_within_the_tool_output_limit(api_client, horizon_inputs):
    from app.assistant.tools import ToolContext, execute_tool, sanitize_json_payload

    ctx = ToolContext(dispatch_center=None, history_store=None)
    for days in (7, 14, 30):
        outlook = execute_tool("get_forecast_outlook", {"days": days}, ctx)
        assert "error" not in outlook and len(outlook["week"]["days"]) == days
        assert outlook["week"]["summary"]["peak_trucks_needed"] > 0
        assert "error" not in sanitize_json_payload(outlook)[:20]
    assert "error" in execute_tool("get_forecast_outlook", {"days": 9}, ctx)
