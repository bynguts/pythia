import os
import unittest
from unittest import mock

with mock.patch.dict(os.environ, {"JWIS_SPJ_SEED": "off"}):
    import app.spj as spj_module
    from app.spj import SpjStore, active_path_for, spj_polyline

from spj_testutil import fresh_store_path


class SpjPolylineTests(unittest.TestCase):
    def _road(self, coords):
        """Deterministic road geometry: exact waypoints (no network)."""
        return {"geometry": [{"lat": la, "lng": ln} for la, ln in coords],
                "distance_km": 1.0, "duration_min": 2, "source": "LIVE_EXTERNAL"}

    def _active_spj(self, store, truck="T-001"):
        spj = store.create(driver_name="A", truck_code=truck,
                           destination="TPST Bantargebang", weigh_on_site=False,
                           priority="normal", note="")
        store.add_stop(spj.spj_id, name="S1", kecamatan="K", address="A",
                       lat=-6.20, lng=106.80)
        store.add_stop(spj.spj_id, name="S2", kecamatan="K", address="B",
                       lat=-6.25, lng=106.85)
        with mock.patch("app.spj.road_route",
                        side_effect=lambda coords: self._road(coords)):
            return store.activate(spj.spj_id)

    def test_polyline_appends_destination(self):
        store = SpjStore(persist_path=fresh_store_path("test_spj_poly.json"))
        spj = self._active_spj(store)
        line = spj_polyline(spj)
        # Road geometry is the resolved waypoints: S1, S2, destination.
        self.assertEqual(len(line), 3)
        self.assertEqual(line[0], (-6.20, 106.80))
        # Verified TPST Bantargebang coordinate (see app.facilities provenance).
        self.assertAlmostEqual(line[-1][0], -6.3495, places=3)
        self.assertAlmostEqual(line[-1][1], 106.9981, places=3)

    def test_polyline_refuses_unverified_destination(self):
        """A destination without a sourced coordinate cannot become ground truth.

        Activation FAILS VISIBLY for an unverified destination (#59) —
        stricter than refusing only at polyline time: an SPJ must never go
        active with compliance geometry that cannot be resolved.
        """
        import tempfile
        from app.facilities import FACILITIES, provenance_payload
        path = os.path.join(tempfile.gettempdir(), "test_spj_unverified.json")
        if os.path.exists(path):
            os.remove(path)
        store = SpjStore(db_path=path)
        spj = store.create(driver_name="A", truck_code="T-997",
                           destination="JRC Pesanggrahan", weigh_on_site=False,
                           priority="normal", note="")
        store.add_stop(spj.spj_id, name="S1", kecamatan="K", address="A",
                       lat=-6.20, lng=106.80)
        with self.assertRaises(ValueError) as ctx:
            store.activate(spj.spj_id)
        self.assertIn("no verified ground-truth", str(ctx.exception))
        self.assertEqual(store.get(spj.spj_id).status, "draft")
        self.assertFalse(FACILITIES["JRC Pesanggrahan"].is_ground_truth)
        provenance = provenance_payload("JRC Pesanggrahan")
        self.assertEqual(provenance["verification_status"], "unverified")
        self.assertFalse(provenance["usable_for_routing"])
        self.assertTrue(provenance["source_url"])
    def test_active_path_for_truck_with_spj(self):
        store = SpjStore(persist_path=fresh_store_path("test_spj_active.json"))
        self._active_spj(store, truck="T-999")
        old = spj_module.SPJ_STORE
        try:
            spj_module.SPJ_STORE = store
            path_result = active_path_for("T-999")
            self.assertIsNotNone(path_result)
            self.assertEqual(path_result[0], (-6.20, 106.80))
            self.assertIsNone(active_path_for("T-000"))
        finally:
            spj_module.SPJ_STORE = old

    def test_active_path_none_when_polyline_degenerate(self):
        store = SpjStore(persist_path=fresh_store_path("test_spj_degenerate.json"))
        # A degenerate road geometry (single point) must not be promoted
        # as a compliance path: active_path_for returns None.
        spj = store.create(driver_name="A", truck_code="T-998",
                           destination="TPST Bantargebang", weigh_on_site=False,
                           priority="normal", note="")
        store.add_stop(spj.spj_id, name="S1", kecamatan="K", address="A",
                       lat=-6.20, lng=106.80)
        with mock.patch("app.spj.road_route",
                        return_value={"geometry": [{"lat": -6.20, "lng": 106.80}],
                                      "distance_km": 0.0, "duration_min": 0,
                                      "source": "LIVE_EXTERNAL"}):
            activated = store.activate(spj.spj_id)
        self.assertEqual(len(activated.route_geometry), 1)  # degenerate
        old = spj_module.SPJ_STORE
        try:
            spj_module.SPJ_STORE = store
            self.assertIsNone(active_path_for("T-998"))
        finally:
            spj_module.SPJ_STORE = old

    def test_reference_path_prefers_spj(self):
        from app.data import _assigned_reference_path
        store = SpjStore(persist_path=fresh_store_path("test_spj_ref.json"))
        self._active_spj(store, truck="T-001")
        old = spj_module.SPJ_STORE
        try:
            spj_module.SPJ_STORE = store
            ref = _assigned_reference_path("T-001")
            self.assertEqual(ref[0], (-6.20, 106.80))
        finally:
            spj_module.SPJ_STORE = old

    def test_reference_path_fallback_without_spj(self):
        from app.data import _assigned_reference_path
        old = spj_module.SPJ_STORE
        try:
            empty = SpjStore(persist_path=fresh_store_path("test_spj_empty.json"))
            spj_module.SPJ_STORE = empty
            ref = _assigned_reference_path("T-001")
            # With no SPJ in the store, the road-cache-or-ASSIGNED_PATHS
            # fallback must still yield a usable reference path.
            self.assertIsNotNone(ref)
            self.assertGreaterEqual(len(ref), 2)
        finally:
            spj_module.SPJ_STORE = old


if __name__ == "__main__":
    unittest.main()
