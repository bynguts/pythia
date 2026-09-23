import os
import unittest
from unittest import mock

with mock.patch.dict(os.environ, {"JWIS_SPJ_SEED": "off"}):
    import app.spj as spj_module
    from app.spj import SpjStore, active_path_for, spj_polyline


class SpjPolylineTests(unittest.TestCase):
    def _active_spj(self, store, truck="T-001"):
        spj = store.create(driver_name="A", truck_code=truck,
                           destination="TPST Bantargebang", weigh_on_site=False,
                           priority="normal", note="")
        store.add_stop(spj.spj_id, name="S1", kecamatan="K", address="A",
                       lat=-6.20, lng=106.80)
        store.add_stop(spj.spj_id, name="S2", kecamatan="K", address="B",
                       lat=-6.25, lng=106.85)
        store.activate(spj.spj_id)
        # Store methods return the state they committed; re-read to see it all.
        return store.get(spj.spj_id)

    def test_polyline_appends_destination(self):
        import tempfile
        path = os.path.join(tempfile.gettempdir(), "test_spj_poly.json")
        if os.path.exists(path):
            os.remove(path)
        store = SpjStore(db_path=path)
        spj = self._active_spj(store)
        line = spj_polyline(spj)
        self.assertEqual(len(line), 3)
        self.assertEqual(line[0], (-6.20, 106.80))
        # Verified TPST Bantargebang coordinate (see app.facilities provenance).
        self.assertAlmostEqual(line[-1][0], -6.3495, places=3)
        self.assertAlmostEqual(line[-1][1], 106.9981, places=3)

    def test_polyline_refuses_unverified_destination(self):
        """A destination without a sourced coordinate cannot become ground truth."""
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
        store.activate(spj.spj_id)
        self.assertFalse(FACILITIES["JRC Pesanggrahan"].is_ground_truth)
        self.assertIsNone(spj_polyline(store.get(spj.spj_id)))
        provenance = provenance_payload("JRC Pesanggrahan")
        self.assertEqual(provenance["verification_status"], "unverified")
        self.assertFalse(provenance["usable_for_routing"])
        self.assertTrue(provenance["source_url"])

    def test_active_path_for_truck_with_spj(self):
        import tempfile
        path = os.path.join(tempfile.gettempdir(), "test_spj_active.json")
        if os.path.exists(path):
            os.remove(path)
        store = SpjStore(db_path=path)
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
        import tempfile
        path = os.path.join(tempfile.gettempdir(), "test_spj_degenerate.json")
        if os.path.exists(path):
            os.remove(path)
        store = SpjStore(db_path=path)
        spj = self._active_spj(store, truck="T-998")
        # Zero-stop edge: the polyline is destination-only, so no usable path.
        spj.stops.clear()
        store._commit(spj)
        old = spj_module.SPJ_STORE
        try:
            spj_module.SPJ_STORE = store
            self.assertIsNone(active_path_for("T-998"))
        finally:
            spj_module.SPJ_STORE = old

    def test_reference_path_prefers_spj(self):
        import tempfile
        from app.data import _assigned_reference_path
        path = os.path.join(tempfile.gettempdir(), "test_spj_ref.json")
        if os.path.exists(path):
            os.remove(path)
        store = SpjStore(db_path=path)
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
            import tempfile
            empty = SpjStore(db_path=os.path.join(
                tempfile.gettempdir(), "test_spj_empty.json"))
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
