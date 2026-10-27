"""A DEMO SPJ (stops at an operator's phone) must not trigger false route deviations.

The simulated truck is nowhere near a DEMO stop, so measuring against that
path would raise a deviation alert and an AI auto-replay for a truck that is
on its corridor. Detection is suppressed and the reason is labelled.
"""

from __future__ import annotations

from unittest import mock

import pytest

from app.ai.actions.auto_state import EventFeed
from app.ai.detectors.deviation_trigger import DeviationTrigger
from app.field.spj import DEMO_LOCATION_TYPE, Spj, SpjStop, active_spj_is_demo
from app.fleet import data, deviation_state, map_truth
from app.fleet.deviation_state import deviation_suppression, reset_hysteresis

# A phone fix far outside Jakarta (Seoul): thousands of km from any simulated truck.
FAR = [(37.5045, 126.9571), (37.5145, 126.9671)]
TRUCK = "T-001"


def _active_spj(location_type: str, truck_code: str = TRUCK, gps_fix: bool = True) -> Spj:
    stop = SpjStop("DEMO · Stop", "Gambir", "Demo address", *FAR[0], location_type=location_type)
    if gps_fix:
        # A check-in with a device fix: a real position recorded on this SPJ.
        stop.status = "completed"
        stop.evidence = {"arrival": {"lat": FAR[0][0], "lng": FAR[0][1], "approx": False}}
    return Spj(
        spj_id="SPJ-TEST",
        spj_number="SPJ/TEST/1",
        date="2026-10-22",
        driver_name="Pengemudi Sim",
        truck_code=truck_code,
        destination="TPST Bantargebang",
        stops=[stop],
        status="aktif",
        route_geometry=list(FAR),
        route_source="FALLBACK_DEGRADED",
    )


def _truck_with(spj: Spj | None) -> dict:
    reset_hysteresis()
    with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", return_value=spj):
        truck = data._truck(TRUCK, "B 1234 CD", "Pengemudi Sim", "Jakarta Pusat", "active", False)
    reset_hysteresis()
    return truck


@pytest.fixture(autouse=True)
def _no_latch_leak():
    reset_hysteresis()
    yield
    reset_hysteresis()


def test_ordinary_far_spj_still_flags_a_deviation():
    # Control: the same far path on a non-DEMO SPJ is a real deviation.
    truck = _truck_with(_active_spj("Pemukiman Kelas Menengah"))
    assert truck["deviation"]["violated"] is True
    assert "deviation_suppressed" not in truck["deviation"]


def test_spj_without_a_recorded_position_is_not_measured_yet():
    # Just activated: the simulated map position is not on the SPJ path, so no
    # "left its corridor" alert until a GPS position is recorded on that SPJ.
    truck = _truck_with(_active_spj("Pemukiman Kelas Menengah", gps_fix=False))
    deviation = truck["deviation"]
    assert deviation["violated"] is False
    assert deviation["deviation_suppressed"] == "awaiting_spj_position"
    assert "no GPS position" in deviation["message"]
    assert truck["status"] != "deviation"


def test_an_approximate_check_in_is_not_a_position():
    spj = _active_spj("Pemukiman Kelas Menengah", gps_fix=False)
    spj.stops[0].status = "completed"
    spj.stops[0].evidence = {"arrival": {"lat": FAR[0][0], "lng": FAR[0][1], "approx": True}}
    truck = _truck_with(spj)
    assert truck["deviation"]["deviation_suppressed"] == "awaiting_spj_position"


def test_needs_you_raises_no_corridor_item_for_a_just_activated_spj():
    from app.field import needs_you

    spj = _active_spj("Pemukiman Kelas Menengah", gps_fix=False)
    with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", return_value=spj):
        items = needs_you._deviations({TRUCK: spj})
    assert TRUCK not in {item["truck_code"] for item in items}


def test_demo_spj_suppresses_deviation_with_a_label():
    truck = _truck_with(_active_spj(DEMO_LOCATION_TYPE))
    deviation = truck["deviation"]
    assert deviation["violated"] is False
    assert deviation["deviation_suppressed"] == "demo_spj"
    assert "DEMO" in deviation["message"]
    assert truck["status"] != "deviation"
    assert "route_deviation" not in deviation.get("violation_types", [])


def test_demo_spj_path_is_not_the_reference_path():
    with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", return_value=_active_spj(DEMO_LOCATION_TYPE)):
        reference = data._assigned_reference_path(TRUCK)
    assert reference != FAR
    assert all(-7.5 < lat < -5.5 for lat, _ in reference)


def test_deviation_trigger_ignores_suppressed_trucks():
    feed = EventFeed(maxlen=10)
    trigger = DeviationTrigger(feed=feed, cooldown_seconds=0.0)
    truck = {
        "truck_code": TRUCK,
        "latest_position": {"lat": -6.2, "lng": 106.8, "speed_kmh": 20.0},
        "deviation": {"violated": True, "distance_meters": 9000.0, "deviation_suppressed": "demo_spj"},
    }

    class Source:
        def current_positions(self):
            return [truck]

    assert trigger.check(Source()) == []
    assert feed.snapshot() == []


# ── Every deviation surface reads the same suppression ──

# A simulated position far (tens of km) from T-001's corridor.
OFF_CORRIDOR = {"lat": -6.6, "lng": 107.3}


def _straight_route(coords):
    return {
        "geometry": [{"lat": la, "lng": ln} for la, ln in coords],
        "distance_km": 0.0,
        "duration_min": 0.0,
        "source": "FALLBACK_DEGRADED",
    }


def _map_truth_with(spj: Spj | None) -> dict:
    truck = {"truck_code": TRUCK, "latest_position": {**OFF_CORRIDOR, "speed_kmh": 20.0}}
    snap = {"snapped": dict(OFF_CORRIDOR), "source": "RAW_GPS_UNSNAPPED"}
    with (
        mock.patch("app.field.spj.SPJ_STORE.active_for_truck", return_value=spj),
        mock.patch.object(map_truth, "_snapped_for", return_value=snap),
        mock.patch.object(map_truth, "road_route", side_effect=_straight_route),
    ):
        return map_truth.build_map_truth(truck)


def test_map_truth_flags_an_ordinary_truck_off_its_corridor():
    payload = _map_truth_with(None)
    assert payload["deviation_segments"] == ["violation"]
    assert "deviation_suppressed" not in payload


def test_map_truth_suppresses_a_demo_spj_without_latching():
    payload = _map_truth_with(_active_spj(DEMO_LOCATION_TYPE))
    assert payload["deviation_suppressed"] == "demo_spj"
    assert payload["deviation_segments"] == []
    assert payload["deviation_m"] == 0.0
    assert "DEMO" in payload["recommendation"]
    # The shared latch is untouched, so the fleet table cannot flip to "deviation".
    assert TRUCK not in deviation_state._states


def test_trip_history_does_not_count_deviations_for_a_demo_spj():
    always_off = {"violated": True}
    with mock.patch.object(data, "detect_route_deviation", return_value=always_off):
        with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", return_value=None):
            ordinary = data._curated_trip_record(TRUCK, "Pengemudi Sim 01", "2026-10-21")
        with mock.patch(
            "app.field.spj.SPJ_STORE.active_for_truck", return_value=_active_spj(DEMO_LOCATION_TYPE)
        ):
            demo = data._curated_trip_record(TRUCK, "Pengemudi Sim 01", "2026-10-21")
    assert ordinary["deviations_count"] > 0
    assert "deviation_suppressed" not in ordinary
    assert demo["deviations_count"] == 0
    assert demo["deviation_suppressed"] == "demo_spj"


# ── A failed SPJ lookup is "unknown", not "not DEMO" ──


def test_failed_lookup_is_unknown_and_never_suppresses():
    with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", side_effect=RuntimeError("db")):
        assert active_spj_is_demo(TRUCK) is None
        assert deviation_suppression(TRUCK) is None
        truck = data._truck(TRUCK, "B 1234 CD", "Pengemudi Sim", "Jakarta Pusat", "active", False)
    assert "deviation_suppressed" not in truck["deviation"]


def test_failed_lookup_keeps_the_corridor_even_if_a_retry_would_return_a_demo_path():
    with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", return_value=None):
        corridor = data._assigned_reference_path(TRUCK)
    # Transient failure: the first lookup raises, the next would return the DEMO SPJ.
    flaky = [RuntimeError("db"), _active_spj(DEMO_LOCATION_TYPE)]
    with mock.patch("app.field.spj.SPJ_STORE.active_for_truck", side_effect=flaky):
        reference = data._assigned_reference_path(TRUCK)
    assert reference == corridor
    assert reference != FAR
