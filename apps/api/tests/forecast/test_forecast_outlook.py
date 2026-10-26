"""/api/forecast/outlook: the week ahead and the next three months, with no input to type.

Weather, official events, permits and holidays are stubbed at the module that reads them
(as in test_tomorrow_forecast.py), so these tests depend on neither Open-Meteo nor the
dates in the scraped event calendar.
"""

from datetime import date, timedelta

import pytest

from app.api import state
from app.forecast import baseline as baseline_module

TODAY = date.today()


def _weather(rain: list[float]) -> dict:
    return {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-25T06:00:00+00:00",
        "forecast": [
            {
                "date": (TODAY + timedelta(days=i)).isoformat(),
                "rainfall_mm": mm,
                "temperature_max_c": 31.0,
                "wind_speed_kmh": 10.0,
            }
            for i, mm in enumerate(rain)
        ],
    }


@pytest.fixture()
def week_inputs(monkeypatch):
    """Rain on day 2 only, a holiday on day 3; Open-Meteo covers only the first 5 days."""
    payload = _weather([0.0, 0.0, 35.0, 0.0, 0.0])
    monkeypatch.setattr(baseline_module, "fetch_jakarta_weather_forecast", lambda: payload)
    monkeypatch.setattr(baseline_module, "load_official_events", lambda: [])
    monkeypatch.setattr(baseline_module.PERMIT_STORE, "list", lambda: [])
    holiday = (TODAY + timedelta(days=3)).isoformat()
    monkeypatch.setattr(baseline_module, "_holiday_names", lambda: {holiday: "Hari Libur Uji"})
    baseline_module._cache.clear()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)
    yield
    baseline_module._cache.clear()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)


def _get(api_client, auth_headers, role="dispatcher"):
    return api_client.get("/api/forecast/outlook", headers=auth_headers(role))


def test_week_has_seven_model_days_with_their_drivers(api_client, auth_headers, week_inputs):
    body = _get(api_client, auth_headers).json()
    assert body["inputs_auto"] is True and body["provenance"] == "MODEL OUTPUT"
    days = body["week"]["days"]
    assert [d["date"] for d in days] == [(TODAY + timedelta(days=i)).isoformat() for i in range(7)]
    for day in days:
        assert day["provenance"] == "MODEL OUTPUT"
        assert day["total_tons"] > 0 and day["normal_tons"] > 0
        assert {d["kind"] for d in day["drivers"]} >= {"weather", "weekday"}
    rain_day = days[2]
    (weather,) = [d for d in rain_day["drivers"] if d["kind"] == "weather"]
    assert weather["detail"] == {"rainfall_mm": 35.0} and weather["effect_tons"] > 0
    assert weather["input_classification"] == "REAL_FORECAST_INPUT"
    assert rain_day["total_tons"] > days[1]["total_tons"]
    assert [d["kind"] for d in days[3]["drivers"] if d["kind"] == "holiday"] == ["holiday"]


def test_days_outside_the_weather_forecast_are_flagged(api_client, auth_headers, week_inputs):
    days = _get(api_client, auth_headers).json()["week"]["days"]
    assert [d["beyond_weather_forecast"] for d in days] == [False] * 5 + [True] * 2
    (weather,) = [d for d in days[6]["drivers"] if d["kind"] == "weather"]
    assert weather["input_classification"] == "NOT_OBSERVED" and weather["detail"]["rainfall_mm"] == 0.0


def test_tomorrow_in_the_outlook_matches_the_tomorrow_endpoint(api_client, auth_headers, week_inputs):
    outlook = _get(api_client, auth_headers).json()
    tomorrow = api_client.get("/api/forecast/tomorrow", headers=auth_headers("dispatcher")).json()
    assert outlook["week"]["days"][1]["total_tons"] == tomorrow["total_tonnage_t"]


def test_months_come_from_the_real_data_model_with_its_backtest(api_client, auth_headers, week_inputs):
    months = _get(api_client, auth_headers).json()["monthly_intake"]
    assert months["available"] is True and months["model"] == "ma12_calendar"
    assert len(months["months"]) == 3
    for month in months["months"]:
        assert month["tons_per_day"] > 0 and month["horizon_months"] >= 1
        assert month["within_backtested_horizon"] == (month["horizon_months"] in (1, 2, 3))
    assert months["backtest"]["mape_model_pct"] > 0
    assert months["backtest"]["target_class"] == "real"


def test_outlook_takes_no_scenario_inputs_and_needs_a_login(api_client, auth_headers, week_inputs):
    assert api_client.get("/api/forecast/outlook").status_code == 401
    plain = _get(api_client, auth_headers).json()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)
    poked = api_client.get(
        "/api/forecast/outlook",
        params={"rainfall_mm": 80, "event_attendance": 50000},
        headers=auth_headers("dispatcher"),
    ).json()
    assert poked["week"]["days"] == plain["week"]["days"]


def test_ana_answers_next_week_and_next_month_from_the_outlook(api_client, week_inputs, monkeypatch):
    from app.assistant.assistant import answer_with_openai_if_configured
    from app.assistant.tools import ToolContext, execute_tool

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    ctx = ToolContext(dispatch_center=None, history_store=None)
    outlook = execute_tool("get_forecast_outlook", {}, ctx)
    assert "error" not in outlook and len(outlook["week"]["days"]) == 7

    result = answer_with_openai_if_configured("Berapa ton minggu depan dan bulan depan?", {}, tool_ctx=ctx)
    assert result["tools_used"] == ["get_forecast_outlook"]
    first = outlook["week"]["days"][0]
    assert first["date"] in result["answer"] and "MODEL OUTPUT" in result["answer"]
    assert f"MAPE {outlook['monthly_intake']['backtest']['mape_model_pct']}%" in result["answer"]
    assert outlook["monthly_intake"]["months"][0]["month"] in result["answer"]
    learned = outlook["learned_correction"]
    assert learned["classification"] == "LEARNED_FROM_OBSERVED" and "hari tertimbang" in result["answer"]
