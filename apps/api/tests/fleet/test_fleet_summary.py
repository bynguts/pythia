"""`/api/fleet/summary` is built from live payloads, not canned demo text (gsc v3 N9)."""

from __future__ import annotations

import app.api.routers.fleet as fleet_router


def _truck(code: str, plate: str, violated: bool, meters: float) -> dict:
    return {
        "truck_code": code,
        "plate_number": plate,
        "deviation": {"violated": violated, "distance_meters": meters},
    }


def test_summary_reports_the_live_worst_deviation(api_client, monkeypatch):
    trucks = [
        _truck("T-900", "B 1111 AA", True, 412.0),
        _truck("T-901", "B 2222 BB", True, 1875.4),
        _truck("T-902", "B 3333 CC", False, 12.0),
    ]
    monkeypatch.setattr(fleet_router, "get_dynamic_trucks", lambda: trucks)
    report = api_client.get("/api/fleet/summary").json()["report"]

    assert "2 truk saat ini di luar koridor" in report
    assert "T-901 (1,875 m)" in report
    assert "B 2222 BB (T-901)" in report
    assert "SIMULATED" in report
    # The canned demo lines are gone.
    assert "2.373 m" not in report
    assert "B 5678 EF" not in report
    assert "Kebon Jeruk dan Tebet" not in report


def test_summary_without_deviation_says_so(api_client, monkeypatch):
    monkeypatch.setattr(fleet_router, "get_dynamic_trucks", lambda: [_truck("T-1", "B 1 A", False, 3.0)])
    report = api_client.get("/api/fleet/summary").json()["report"]

    assert "tidak ada truk di luar koridor" in report
    assert "Tidak ada notifikasi deviasi" in report


def test_summary_labels_the_rain_scenario_by_bmkg_band(api_client):
    report = api_client.get("/api/fleet/summary").json()["report"]

    # 42 mm/day is BMKG "sedang" (20-50 mm), never "ekstrim"/"ekstrem" (>150 mm).
    assert "ekstrim" not in report.lower()
    assert "ekstrem" not in report.lower()
    assert 'kategori BMKG "sedang" 20–50 mm' in report
    assert "MODEL OUTPUT" in report
    # The spike is printed signed, never "+-x%".
    assert "+-" not in report
