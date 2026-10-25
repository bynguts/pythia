"""Every number names its quantity: trucks vs gate trips, day mean vs peak hour vs one truck.

The same screen pair must never show two figures for one quantity, and two different
quantities must say which they are. These tests pin the definitions the payloads carry
and check the tonnage against the real SIPSN figure it is read against.
"""

import csv
from datetime import date, timedelta

import pytest

from app.api.routers import twin as twin_router
from app.core.paths import REAL_DIR
from app.core.units import TRUCK_CAPACITY_TONS
from app.field import safety
from app.forecast import baseline as baseline_module


@pytest.fixture()
def dry_week(monkeypatch):
    start = date.today()
    payload = {
        "source": "open-meteo",
        "kind": "forecast",
        "fetched_at": "2026-10-26T06:00:00+00:00",
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


def _sipsn_latest_year_total() -> tuple[int, float]:
    with (REAL_DIR / "sipsn_timbulan_2018_2025_dki.csv").open(encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    year = max(int(r["tahun"]) for r in rows)
    return year, sum(float(r["jml_timbulan_harian"]) for r in rows if int(r["tahun"]) == year)


def test_trucks_and_gate_trips_are_two_named_counts(api_client, dry_week):
    base = api_client.get("/api/baseline/today").json()
    metric = api_client.get("/api/tpa/queue-metric").json()
    assert f"{TRUCK_CAPACITY_TONS:g} t per truck per shift" in base["trucks_basis"]
    assert "not TPA gate trips" in base["trucks_basis"]
    trips = base["gate_trips"]
    # One source for gate trips: the queue model's normal-day arrivals.
    assert trips["trips_per_day"] == metric["normal_day"]["trucks_per_day"]
    assert trips["classification"] == "REAL"
    assert "gate trips" in trips["unit"] and "several trips" in trips["unit"]
    assert metric["arrivals_unit"] == trips["unit"]
    assert trips["trips_per_day"] != base["trucks_needed"]


def test_tonnage_is_model_generation_read_against_real_sipsn(api_client, dry_week):
    base = api_client.get("/api/baseline/today").json()
    year, sipsn = _sipsn_latest_year_total()
    ref = base["tonnage_reference"]
    assert ref["year"] == year
    assert ref["daily_tons"] == pytest.approx(sipsn, abs=0.5)
    assert ref["classification"] == "REAL" and "timbulan" in ref["quantity"]
    assert base["provenance"]["tonnage"] == "MODEL_OUTPUT"
    assert "not landfill intake" in base["units"]["tons"]
    # A dry, event-free day of the same quantity sits near the real yearly figure: a unit
    # error or a double count (2x) would land far outside this band.
    assert abs(base["normal_day_tonnage_t"] / sipsn - 1) < 0.15


def test_queue_figures_name_day_mean_or_peak_hour_at_the_weighbridge(api_client):
    metric = api_client.get("/api/tpa/queue-metric").json()
    status = api_client.get("/api/tpa/queue-status").json()
    assert metric["quantity"] == "day_mean_per_truck"
    assert status["quantity"] == "peak_hour_mean_per_truck"
    assert metric["quantity_label"] != status["quantity_label"]
    for payload in (metric, status):
        assert payload["stage"].startswith("weighbridge (gate) stage only")
        assert payload["classification"] == "SIMULATED"
    # Same model and day: the peak hour's wait is above the day mean, never a rival figure.
    assert status["trucks_per_day"] == metric["trucks_per_day"]
    assert status["avg_wait_minutes"] > metric["baseline_mean"]


def test_simulated_gate_waits_are_examples_not_the_queue_model(monkeypatch):
    monkeypatch.setattr(safety, "observed_activity", lambda now: {})
    overview = safety.overview()
    assert overview["classification"] == safety.SIMULATED
    assert "not drawn from the weighbridge queue model" in overview["gate_wait_basis"]
    waits = [t["gate_wait_minutes"] for t in overview["trucks"] if t["gate_wait_minutes"] is not None]
    # Seeded at the top of the hour and still growing: at most the range plus that hour.
    assert waits and all(safety.SIM_GATE_WAIT_MIN <= w < safety.SIM_GATE_WAIT_MAX + 60 for w in waits)


def _census_trucks_latest_year() -> tuple[int, int]:
    with (REAL_DIR / "data_truk_sampah_dki.csv").open(encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    year = max(int(r["periode_data"]) for r in rows)
    trucks = sum(
        int(float(r["jumlah_kendaraan"] or 0))
        for r in rows
        if int(r["periode_data"]) == year and "GEROBAK" not in r["jenis_kendaraan"].upper()
    )
    return year, trucks


def test_real_fleet_size_is_the_latest_census_year_trucks_only(api_client):
    year, trucks = _census_trucks_latest_year()
    provenance = api_client.get("/api/data/provenance").json()["provenance"]
    composition = api_client.get("/api/fleet/composition").json()
    # Every census year summed (with motor carts) once read ~7,000 "trucks".
    assert composition["total_units"] == trucks == provenance["fleet_units_real"]
    assert composition["year"] == year == provenance["fleet_units_year"]
    assert "motor carts excluded" in provenance["fleet_units_class"]
    assert composition["source"] == f"DKI truck census {year} (data.go.id)"
    assert "Gerobak Motor" not in composition["by_vehicle_type"]
    assert sum(composition["by_vehicle_type"].values()) == trucks
    assert sum(composition["by_wilayah"].values()) == trucks
