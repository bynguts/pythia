"""Tests for the single map-truth geospatial payload (Task 2)."""

import unittest
from unittest import mock

from app.fleet.data import TRUCKS
from app.fleet.map_truth import build_map_truth


class MapTruthTests(unittest.TestCase):
    def setUp(self):
        self.truck = next(t for t in TRUCKS if t["truck_code"] == "T-047")
        self.payload = build_map_truth(self.truck)

    def test_payload_has_all_geospatial_keys(self):
        for key in (
            "truck_code",
            "raw_gps",
            "snapped_gps",
            "assigned_route",
            "actual_route",
            "deviation_m",
            "deviation_segments",
            "recommendation",
            "traffic",
            "permit",
            "provenance",
            "timestamp",
        ):
            self.assertIn(key, self.payload)

    def test_snapped_gps_near_raw(self):
        from app.fleet.osrm import _haversine_km

        raw = self.payload["raw_gps"]
        snap = self.payload["snapped_gps"]
        d = _haversine_km((raw["lat"], raw["lng"]), (snap["lat"], snap["lng"])) * 1000
        self.assertLess(d, 200)

    def test_routes_are_road_following_or_labeled_fallback(self):
        for key in ("assigned_route", "actual_route"):
            route = self.payload[key]
            self.assertIn("source", route)
            if route["source"] == "LIVE_EXTERNAL":
                self.assertGreater(len(route["geometry"]), 20)
            else:
                self.assertEqual(route["source"], "FALLBACK_DEGRADED")

    def test_deviation_is_meter_float(self):
        self.assertIsInstance(self.payload["deviation_m"], float)

    def test_provenance_labels_present(self):
        prov = self.payload["provenance"]
        self.assertIn("raw_gps", prov)
        self.assertIn("snapped_gps", prov)
        self.assertEqual(prov["raw_gps"], "RAW_GPS_SIMULATED")


class SnapCacheTests(unittest.TestCase):
    """The cached snap must not lag a moving truck (it once trailed raw GPS by ~400 m)."""

    def setUp(self):
        from app.fleet import map_truth

        self.map_truth = map_truth
        map_truth._snap_cache.pop("T-TEST", None)
        self.calls = []

        def fake_snap(lat, lng):
            self.calls.append((lat, lng))
            return {"lat": lat, "lng": lng, "source": "LIVE_EXTERNAL"}

        patcher = mock.patch.object(map_truth, "snap_to_road", side_effect=fake_snap)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(map_truth._snap_cache.pop, "T-TEST", None)

    def _truck(self, lat, lng):
        return {"truck_code": "T-TEST", "latest_position": {"lat": lat, "lng": lng}}

    def test_reuses_snap_while_truck_is_close(self):
        self.map_truth._snapped_for(self._truck(-6.2000, 106.8000))
        self.map_truth._snapped_for(self._truck(-6.2002, 106.8000))  # ~22 m
        self.assertEqual(len(self.calls), 1)

    def test_resnaps_after_truck_moves_away(self):
        self.map_truth._snapped_for(self._truck(-6.2000, 106.8000))
        snap = self.map_truth._snapped_for(self._truck(-6.2040, 106.8000))  # ~445 m
        self.assertEqual(len(self.calls), 2)
        self.assertEqual((snap["lat"], snap["lng"]), (-6.2040, 106.8000))


if __name__ == "__main__":
    unittest.main()
