"""/api/forecast/tomorrow: the forecast day with weather, events and holidays filled and explained.

Weather, official events, permits and holidays are stubbed at the module that reads them, so
these tests depend on neither Open-Meteo nor the dates in the scraped event calendar.
"""

from datetime import date, timedelta

import pytest

from app.forecast import baseline as baseline_module
from app.forecast import real_data

TOMORROW = date.today() + timedelta(days=1)


def open_meteo_week(rain: list[float]) -> dict:
    return {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-25T06:00:00+00:00",
        "forecast": [
            {
                "date": (date.today() + timedelta(days=i)).isoformat(),
                "rainfall_mm": mm,
                "temperature_max_c": 31.0,
                "wind_speed_kmh": 10.0,
            }
            for i, mm in enumerate(rain)
        ],
    }


def _week(monkeypatch, rain: list[float]) -> None:
    payload = open_meteo_week(rain)
    monkeypatch.setattr(baseline_module, "fetch_jakarta_weather_forecast", lambda: payload)
    baseline_module._cache.clear()


@pytest.fixture()
def quiet_inputs(monkeypatch):
    """A dry week with no official event, no permit and no holiday."""
    _week(monkeypatch, [0.0] * 7)
    monkeypatch.setattr(baseline_module, "load_official_events", lambda: [])
    monkeypatch.setattr(baseline_module.PERMIT_STORE, "list", lambda: [])
    monkeypatch.setattr(baseline_module, "_holiday_names", lambda: {})


def _get(api_client, auth_headers, **params):
    return api_client.get("/api/forecast/tomorrow", params=params, headers=auth_headers("dispatcher"))


def _driver(body, kind):
    return [d for d in body["drivers"] if d["kind"] == kind]


def test_quiet_day_has_no_effects_and_keeps_the_outlook_keys(api_client, auth_headers, quiet_inputs):
    body = _get(api_client, auth_headers).json()
    assert body["date"] == TOMORROW.isoformat()
    assert body["kind"] == "baseline" and body["total_tonnage_t"] > 0
    assert body["inputs_auto"] is True and body["forecast_classification"] == "MODEL_OUTPUT"
    assert {d["kind"] for d in body["drivers"]} == {"weather", "weekday"}
    assert all(d["effect_tons"] in (0, 0.0, None) for d in body["drivers"])
    assert body["with_events_total_t"] == body["total_tonnage_t"]


def test_rain_raises_the_weather_effect(api_client, auth_headers, monkeypatch):
    _week(monkeypatch, [0.0, 40.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    monkeypatch.setattr(baseline_module, "load_official_events", lambda: [])
    monkeypatch.setattr(baseline_module.PERMIT_STORE, "list", lambda: [])
    (weather,) = _driver(_get(api_client, auth_headers).json(), "weather")
    assert weather["detail"] == {"rainfall_mm": 40.0}
    assert weather["effect_tons"] > 0
    assert weather["source"] == "open-meteo" and weather["input_classification"] == "REAL_FORECAST_INPUT"
    assert weather["effect_classification"] == "MODEL_OUTPUT"


def test_official_event_is_listed_without_inventing_attendance(
    api_client, auth_headers, quiet_inputs, monkeypatch
):
    scraped = {
        "date_raw": TOMORROW.isoformat(),
        "name": "Pesta Contoh",
        "location": "OPEN SPACE",
        "expected_attendance": None,
    }
    monkeypatch.setattr(baseline_module, "load_official_events", lambda: [scraped])
    body = _get(api_client, auth_headers).json()
    (event,) = _driver(body, "event")
    assert event["detail"]["name"] == "Pesta Contoh"
    assert event["detail"]["data_class"] == "official" and event["source"] == "official calendar"
    assert event["detail"]["attendance"] is None and event["effect_tons"] is None
    assert body["with_events_total_t"] == body["total_tonnage_t"]


def test_submitted_permit_adds_its_delta_only_to_the_with_events_total(
    api_client, auth_headers, quiet_inputs, monkeypatch
):
    permit = {
        "name": "Konser Contoh",
        "event_date": TOMORROW.isoformat(),
        "expected_attendance": 50_000,
        "lat": -6.2183,
        "lng": 106.8022,
        "location_name": "GBK",
    }
    monkeypatch.setattr(baseline_module.PERMIT_STORE, "list", lambda: [permit])
    body = _get(api_client, auth_headers).json()
    (event,) = _driver(body, "event")
    assert event["detail"]["data_class"] == "USER_SUBMITTED" and event["source"] == "permit intake"
    assert event["effect_tons"] > 0 and event["detail"]["kecamatan"]
    assert body["kind"] == "baseline"
    assert body["with_events_total_t"] == pytest.approx(
        body["total_tonnage_t"] + event["effect_tons"], abs=0.11
    )


def test_holiday_is_listed_by_name(api_client, auth_headers, quiet_inputs, monkeypatch):
    monkeypatch.setattr(baseline_module, "_holiday_names", lambda: {TOMORROW.isoformat(): "Hari Contoh"})
    (holiday,) = _driver(_get(api_client, auth_headers).json(), "holiday")
    assert holiday["detail"] == {"name": "Hari Contoh"} and holiday["source"] == "api-hari-libur 2026"


def test_real_2026_calendar_names_christmas():
    assert baseline_module._holiday_names()["2026-12-25"] == "Hari Raya Natal"


def test_event_dates_parse_both_scraped_formats():
    assert baseline_module._parse_event_date("Minggu, 12 Juli 2026") == "2026-07-12"
    assert baseline_module._parse_event_date("2026-6-11") == "2026-06-11"
    assert baseline_module._parse_event_date("segera") is None


def test_date_outside_the_forecast_week_is_422_and_no_token_is_401(api_client, auth_headers, quiet_inputs):
    late = (date.today() + timedelta(days=7)).isoformat()
    assert _get(api_client, auth_headers, date=late).status_code == 422
    assert api_client.get("/api/forecast/tomorrow").status_code == 401


def test_baseline_today_is_unchanged_by_a_tomorrow_call(api_client, auth_headers, quiet_inputs):
    def today_payload():
        body = api_client.get("/api/baseline/today").json()
        body.pop("generated_at")
        return body

    before = today_payload()
    assert _get(api_client, auth_headers).status_code == 200
    assert today_payload() == before


def test_multi_day_official_event_counts_on_every_day_it_runs():
    fair = {"date_raw": "2026-6-10", "end_date_raw": "2026-6-20"}
    assert all(baseline_module._runs_on(fair, f"2026-06-{d}") for d in (10, 15, 20))
    assert not baseline_module._runs_on(fair, "2026-06-09")
    assert not baseline_module._runs_on(fair, "2026-06-21")
    assert baseline_module._runs_on({"date_raw": "2026-6-10"}, "2026-06-10")
    assert not baseline_module._runs_on({"date_raw": "2026-6-10"}, "2026-06-11")


def test_loader_keeps_the_end_date_of_the_scraped_fair():
    fair = next(e for e in real_data.load_official_events() if e["name"].startswith("Jakarta Fair Kemayoran"))
    assert fair["end_date_raw"] == "2026-7-12"
