"""#58: SPJ reference paths must follow roads, not straight chords.

Activating an SPJ must resolve road-following geometry for every leg
via OSRM. A degraded (straight-line) result FAILS activation visibly —
it is never silently promoted as ground truth — unless the explicit
JWIS_SPJ_STRAIGHT_FALLBACK=on escape hatch is set (recorded in the
audit trail).
"""

from __future__ import annotations

import unittest
from unittest import mock

from app.spj import SpjStore, spj_polyline

from spj_testutil import fresh_store_path


def _draft_with_two_stops(store, truck="T-58"):
    spj = store.create(driver_name="A", truck_code=truck,
                       destination="TPST Bantargebang", weigh_on_site=True,
                       priority="normal", note="")
    store.add_stop(spj.spj_id, name="S1", kecamatan="K", address="A",
                   lat=-6.20, lng=106.80)
    store.add_stop(spj.spj_id, name="S2", kecamatan="K", address="B",
                   lat=-6.25, lng=106.85)
    return spj.spj_id


def _road_result(points, source):
    return {"geometry": [{"lat": la, "lng": ln} for la, ln in points],
            "distance_km": 12.3, "duration_min": 33, "source": source}


class RoadGeometryActivationTests(unittest.TestCase):
    def test_activation_resolves_and_stores_road_route(self):
        store = SpjStore(persist_path=fresh_store_path("bayu58_ok.db"))
        spj_id = _draft_with_two_stops(store)
        curved = [(-6.20, 106.80), (-6.22, 106.83), (-6.25, 106.85),
                  (-6.331, 106.991)]
        with mock.patch("app.spj.road_route",
                        return_value=_road_result(curved, "LIVE_EXTERNAL")):
            spj = store.activate(spj_id)
        self.assertEqual(spj.status, "aktif")
        self.assertEqual(spj.route_source, "LIVE_EXTERNAL")
        self.assertIsNotNone(spj.route_resolved_at)
        # Compliance path follows the RESOLVED road geometry.
        line = spj_polyline(store.get(spj_id))
        self.assertEqual(len(line), len(curved))
        self.assertEqual(line[0], (-6.20, 106.80))
        self.assertIn((-6.22, 106.83), line)

    def test_degraded_route_fails_activation_visibly(self):
        import os
        store = SpjStore(persist_path=fresh_store_path("bayu58_fail.db"))
        spj_id = _draft_with_two_stops(store)
        straight = [(-6.20, 106.80), (-6.25, 106.85), (-6.331, 106.991)]
        with mock.patch.dict(os.environ, {"JWIS_SPJ_STRAIGHT_FALLBACK": "off"}), \
             mock.patch("app.spj.road_route",
                        return_value=_road_result(straight, "FALLBACK_DEGRADED")):
            with self.assertRaises(ValueError) as ctx:
                store.activate(spj_id)
        self.assertIn("road", str(ctx.exception).lower())
        self.assertEqual(store.get(spj_id).status, "draft",
                         "failed activation must leave the SPJ in draft")
    def test_straight_fallback_escape_hatch_is_audited(self):
        import os
        store = SpjStore(persist_path=fresh_store_path("bayu58_fallback.db"))
        spj_id = _draft_with_two_stops(store)
        straight = [(-6.20, 106.80), (-6.25, 106.85), (-6.331, 106.991)]
        with mock.patch.dict(os.environ, {"JWIS_SPJ_STRAIGHT_FALLBACK": "on"}), \
             mock.patch("app.spj.road_route",
                        return_value=_road_result(straight, "FALLBACK_DEGRADED")):
            spj = store.activate(spj_id)
        self.assertEqual(spj.status, "aktif")
        self.assertEqual(spj.route_source, "FALLBACK_DEGRADED")
        entries = store.audit_log(spj_id)
        self.assertTrue(any(e["action"] == "straight_fallback" for e in entries),
                        "the straight-line escape hatch must be audited")

    def test_curved_route_differs_from_chord_by_threshold(self):
        # The compliance case that motivates #58: a road route around an
        # inaccessible area must actually curve away from the chord.
        store = SpjStore(persist_path=fresh_store_path("bayu58_curve.db"))
        spj_id = _draft_with_two_stops(store)
        curved = [(-6.20, 106.80), (-6.14, 106.86), (-6.18, 106.92),
                  (-6.25, 106.85), (-6.331, 106.991)]
        with mock.patch("app.spj.road_route",
                        return_value=_road_result(curved, "LIVE_EXTERNAL")):
            store.activate(spj_id)
        line = spj_polyline(store.get(spj_id))
        # Chord midpoint between S1 and S2 is ~(-6.225, 106.825); the road
        # swings north to -6.14 — materially different geometry.
        self.assertTrue(any(lat > -6.16 for lat, _ in line),
                        "road geometry must differ from the straight chord")


if __name__ == "__main__":
    unittest.main()
