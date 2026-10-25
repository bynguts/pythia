"""The rain response is monotone and labelled, a what-if never carries, and a demo can be pinned.

gsc teardown v3: #7 / N7 (rain response and carry-over), #8 / N6 (Fleet KPI vs twin
beacon), #5 (recording determinism). Measured before the fix on Sat 2026-10-24 (dry
week, rain on one day): 3-8 mm lowered the city total by 2.7-3.3%, 50 mm put 22 of 42
kecamatan at risk but 80 mm only 15, and nothing moved above 96.7 mm.
"""

import json
from datetime import date

import pandas as pd
import pytest

from app.api.routers import twin as twin_router
from app.core.env import today
from app.core.paths import PROCESSED_DIR
from app.fleet import data as fleet_data
from app.forecast import weather as weather_module
from app.forecast.engine import (
    TRAINING_RAIN_3D_MAX_MM,
    TRAINING_RAIN_MAX_MM,
    predict_waste_hybrid,
    rain_grid,
)

DAYS = 7  # the twin's default horizon: tests share its cached model series
SAT = "2026-10-24"  # a pinned Saturday; day 1 is a Sunday
SWEEP = (0, 3, 5, 10, 15, 30, 50, 80, 120, 150)


@pytest.fixture()
def pinned(monkeypatch):
    monkeypatch.setenv("PYTHIA_DEMO_DATE", SAT)


def scene(api_client, **params) -> dict:
    response = api_client.get("/api/twin/scene", params={"days": DAYS, **params})
    assert response.status_code == 200, response.text
    return response.json()


def district_tons(payload: dict, day: int) -> dict[str, float]:
    return {d["id"]: d["series"][day]["predicted_tons"] for d in payload["districts"]}


def open_meteo_raw(rain: list[float]) -> dict:
    """A raw Open-Meteo daily response for the week starting SAT."""
    dates = pd.date_range(SAT, periods=len(rain)).strftime("%Y-%m-%d").tolist()
    return {
        "daily": {
            "time": dates,
            "temperature_2m_max": [31.0] * len(rain),
            "temperature_2m_min": [25.0] * len(rain),
            "precipitation_sum": rain,
            "precipitation_probability_max": [50] * len(rain),
            "wind_speed_10m_max": [10.0] * len(rain),
        }
    }


class _Response:
    def __init__(self, payload: dict) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> bool:
        return False


def _offline(*_args, **_kwargs):
    raise OSError("no network in tests")


# ── A + B: a monotone, labelled rain response ────────────────────────────────


def test_rain_grid_only_grows_with_rain_and_stops_at_the_training_max():
    assert rain_grid(0) == [0.0]
    assert rain_grid(3.7) == [0.0, 1.0, 2.0, 3.0]
    assert rain_grid(150) == rain_grid(500) == rain_grid(TRAINING_RAIN_MAX_MM)
    assert rain_grid(150)[-1] == TRAINING_RAIN_MAX_MM
    for low, high in zip(SWEEP, SWEEP[1:], strict=False):
        assert set(rain_grid(low)) <= set(rain_grid(high))


@pytest.mark.parametrize("day", [0, 1])
def test_more_rain_on_a_day_never_lowers_its_total_or_its_at_risk_count(api_client, pinned, day):
    totals, counts, by_district = [], [], []
    for mm in SWEEP:
        payload = scene(api_client, weather="none", rainfall_mm=mm, day=day)
        assert payload["horizon"]["dates"][0] == SAT
        totals.append(payload["horizon"]["daily_total_tons"][day])
        counts.append(payload["horizon"]["daily_districts_at_risk"][day])
        by_district.append(district_tons(payload, day))
    assert totals == sorted(totals), totals
    assert counts == sorted(counts), counts
    for low, high in zip(by_district, by_district[1:], strict=False):
        assert all(high[k] >= low[k] for k in low)
    # The sign of light rain is pinned: 3-15 mm never reads below the dry normal day.
    assert all(total >= totals[0] for total in totals)
    # Heavy rain does move the city (the model's own, monotone response).
    assert totals[SWEEP.index(80)] > totals[0] and counts[SWEEP.index(80)] > 0


def test_an_event_on_a_rainy_day_never_lowers_that_day(api_client, pinned):
    rain = scene(api_client, weather="none", rainfall_mm=120, day=1)
    both = scene(api_client, weather="none", rainfall_mm=120, event_attendance=50_000, venue="jis", day=1)
    assert both["horizon"]["daily_total_tons"][1] > rain["horizon"]["daily_total_tons"][1]
    assert both["horizon"]["daily_districts_at_risk"][1] >= rain["horizon"]["daily_districts_at_risk"][1]


def test_rain_beyond_the_training_range_is_flagged_and_held(api_client, pinned):
    at_max = scene(api_client, weather="none", rainfall_mm=TRAINING_RAIN_MAX_MM, day=1)
    heavy = scene(api_client, weather="none", rainfall_mm=120, day=1)
    extreme = scene(api_client, weather="none", rainfall_mm=150, day=1)
    totals = {p["horizon"]["daily_total_tons"][1] for p in (at_max, heavy, extreme)}
    assert len(totals) == 1, "above the wettest training day the effect is held, not extrapolated"

    block = extreme["weather"]["rain_response"]
    assert block["method"] == "model_monotone"
    assert block["beyond_training_range"] is True and block["held_at_mm"] == TRAINING_RAIN_MAX_MM
    assert block["max_rain_mm"] == 150 and block["training_max_rain_mm"] == TRAINING_RAIN_MAX_MM
    assert block["rule_steps_mm"] == [10.0, 30.0] and block["rule_steps_percent"] == [8, 16]
    assert "assumption, not learned" in block["label"] and "never below the dry normal day" in block["label"]
    days = extreme["weather"]["days"]
    assert days[1]["beyond_training_range"] is True and days[0]["beyond_training_range"] is False

    moderate = scene(api_client, weather="none", rainfall_mm=30, day=1)["weather"]["rain_response"]
    assert moderate["beyond_training_range"] is False and moderate["held_at_mm"] is None


def test_training_range_constants_match_the_training_dataset():
    csv = PROCESSED_DIR / "training_dataset_kecamatan.csv"
    if not csv.exists():
        pytest.skip("training dataset not present")
    frame = pd.read_csv(csv, usecols=["precipitation_mm", "rain_3d"])
    assert round(float(frame["precipitation_mm"].max()), 1) == TRAINING_RAIN_MAX_MM
    assert round(float(frame["rain_3d"].max()), 1) == TRAINING_RAIN_3D_MAX_MM


def test_single_day_prediction_is_monotone_and_attributes_rain_honestly():
    rows = [predict_waste_hybrid("gambir", rainfall_mm=float(mm), target_date=SAT) for mm in SWEEP]
    tons = [row["predicted_tons"] for row in rows]
    assert tons == sorted(tons), tons
    rain_tons = [row["factor_attribution"]["rainfall_tons"] for row in rows]
    assert rain_tons[0] == 0.0 and all(t >= 0 for t in rain_tons) and rain_tons == sorted(rain_tons)
    assert rows[-1]["rain_response"]["beyond_training_range"] is True
    assert rows[0]["rain_response"]["beyond_training_range"] is False


# ── C: carry-over ────────────────────────────────────────────────────────────


def test_forecast_rain_carry_over_is_labelled_and_never_lowers_a_day(api_client, pinned, monkeypatch):
    week = weather_module._open_meteo_result(
        open_meteo_raw([20.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]), "2026-10-24T01:00:00+00:00", snapshot=False
    )
    monkeypatch.setattr(twin_router, "fetch_jakarta_weather_forecast", lambda: week)
    payload = scene(api_client)
    days = payload["weather"]["days"]
    assert [d["carried_rain_mm"] for d in days[:4]] == [0.0, 20.0, 20.0, 0.0]
    assert [d["rain_3d_mm"] for d in days[:4]] == [20.0, 20.0, 20.0, 0.0]
    assert payload["weather"]["carry_over"] == twin_router.CARRY_OVER
    assert payload["weather"]["carry_over"]["forecast"] is True
    for district in payload["districts"]:
        for row in district["series"]:
            assert row["predicted_tons"] >= row["normal_tons"], (district["id"], row["date"])


# ── D: the Fleet KPI and the twin beacon say which day they describe ────────


def test_fleet_kpi_and_twin_beacon_name_their_day_basis(api_client, pinned, monkeypatch):
    monkeypatch.setattr(fleet_data, "build_predictions", lambda: [])
    monkeypatch.setattr(fleet_data, "_route_b_osrm", lambda: {})
    fleet = fleet_data.command_center_snapshot([])["tpa_queue"]["day_basis"]
    normal_trucks = fleet_data.tpa_queue_status_payload()["trucks_per_day"]
    assert fleet["id"] == "normal_day" and fleet["date"] == SAT
    assert fleet["trucks_per_day"] == fleet["normal_trucks_per_day"] == normal_trucks
    assert fleet["tonnage_ratio"] == 1.0

    dry = scene(api_client, weather="none")["landfill_queue"]
    basis = dry["day_basis"]
    assert basis["id"] == "normal_day" and basis["date"] == SAT and basis["tonnage_ratio"] == 1.0
    assert basis["trucks_per_day"] == basis["normal_trucks_per_day"] == normal_trucks
    assert set(fleet) == set(basis), "one shape on both surfaces"

    wet = scene(api_client, weather="none", rainfall_mm=150)["landfill_queue"]["day_basis"]
    assert wet["id"] == "scenario" and wet["tonnage_ratio"] > 1.0
    assert wet["trucks_per_day"] > wet["normal_trucks_per_day"] == normal_trucks


# ── E: a pinned date and a saved forecast make takes repeatable ─────────────


def test_demo_date_pins_today_for_twin_fleet_and_forecast(api_client, monkeypatch):
    monkeypatch.setenv("PYTHIA_DEMO_DATE", "2026-11-02")
    assert today() == date(2026, 11, 2)
    assert scene(api_client, weather="none", days=2)["horizon"]["dates"][0] == "2026-11-02"

    from app.api.routers import forecast as forecast_router

    monkeypatch.setitem(forecast_router._kecamatan_cache, "key", None)
    body = api_client.get("/api/predictions/kecamatan").json()
    assert body["generated_for"] == "2026-11-02"

    monkeypatch.setattr(weather_module, "_WEATHER_CACHE", None)
    monkeypatch.setattr(weather_module, "urlopen", _offline)
    predictions = fleet_data._build_predictions_uncached()
    assert predictions[0]["date"] == "2026-11-03"  # Fleet shows tomorrow onward

    monkeypatch.setenv("PYTHIA_DEMO_DATE", "02-11-2026")
    with pytest.raises(ValueError):
        today()


def test_saved_snapshot_serves_the_same_week_and_names_its_fetch_time(api_client, monkeypatch, tmp_path):
    raw = open_meteo_raw([0.0, 12.0, 35.0, 0.0, 2.0, 0.0, 0.0])
    monkeypatch.setattr(weather_module, "urlopen", lambda _url, timeout: _Response(raw))
    path = weather_module.save_weather_snapshot(tmp_path / "weather_snapshot.json")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["response"] == raw and saved["source"] == "open-meteo" and saved["fetched_at"]

    # Offline, with the snapshot and the date pinned: the network is never asked.
    monkeypatch.setattr(weather_module, "urlopen", _offline)
    monkeypatch.setenv("PYTHIA_WEATHER_SNAPSHOT", str(path))
    monkeypatch.setenv("PYTHIA_DEMO_DATE", SAT)
    first, second = scene(api_client), scene(api_client)
    assert first["summary"] == second["summary"] and first["horizon"] == second["horizon"]

    block = first["weather"]
    assert block["class"] == "REAL_FORECAST_INPUT" and block["snapshot"] is True
    assert block["fetched_at"] == saved["fetched_at"]
    assert f"snapshot fetched at {saved['fetched_at']}" in block["label"]
    assert [d["input"] for d in block["days"]] == ["forecast"] * DAYS
    assert block["days"][2]["rainfall_mm"] == 35.0


def test_an_unreadable_snapshot_is_labelled_unreachable_not_served(api_client, monkeypatch, tmp_path):
    monkeypatch.setenv("PYTHIA_WEATHER_SNAPSHOT", str(tmp_path / "missing.json"))
    payload = weather_module.fetch_jakarta_weather_forecast()
    assert payload["source"] == "fallback-demo" and payload["snapshot"] is False
