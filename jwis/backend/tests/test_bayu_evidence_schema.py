"""#54: server-side validation of SPJ stop evidence.

The store must reject evidence that only carries filenames: missing
image data, missing/malformed coordinates, non-positive weights,
unsupported fractions, and empty officer identity are all invalid.
Every error names the offending field.
"""

from __future__ import annotations

import unittest

from app.spj import SpjStore, _validate_evidence

from spj_testutil import fresh_store_path


VALID = {
    "arrival": {"photo_name": "datang.jpg", "photo_b64": "data:image/jpeg;base64,AAA",
                "lat": -6.2379, "lng": 106.7826},
    "weighing": [{"fraction": "Residu", "weight_kg": 37.2,
                  "photo_name": "timbang1.jpg", "photo_b64": "data:image/jpeg;base64,BBB"}],
    "officer": {"photo_name": "petugas.jpg", "photo_b64": "data:image/jpeg;base64,CCC",
                "name": "Dicky"},
}


def _store():
    return SpjStore(persist_path=fresh_store_path("bayu54_evidence.db"))


def _active_spj(store):
    spj = store.create(driver_name="A", truck_code="T-54",
                       destination="TPST Bantargebang", weigh_on_site=True,
                       priority="normal", note="")
    store.add_stop(spj.spj_id, name="S1", kecamatan="K", address="A",
                   lat=-6.2, lng=106.8)
    return store.activate(spj.spj_id)


class EvidenceSchemaTests(unittest.TestCase):
    def _reject(self, evidence, field_hint):
        with self.assertRaises(ValueError) as ctx:
            _validate_evidence(evidence)
        self.assertIn(field_hint, str(ctx.exception))

    def test_valid_evidence_passes(self):
        _validate_evidence(VALID)  # must not raise

    # -- arrival ---------------------------------------------------------
    def test_arrival_photo_b64_required(self):
        ev = {"arrival": {"photo_name": "a.jpg", "lat": -6.2, "lng": 106.8},
              "weighing": [], "officer": {"name": "X", "photo_name": "p.jpg",
                                          "photo_b64": "data:image/jpeg;base64,C"}}
        self._reject(ev, "arrival.photo_b64")

    def test_arrival_photo_name_required(self):
        ev = {"arrival": {"photo_b64": "data:image/jpeg;base64,A", "lat": -6.2, "lng": 106.8},
              "weighing": [], "officer": VALID["officer"]}
        self._reject(ev, "arrival.photo_name")

    def test_arrival_lat_required(self):
        ev = {"arrival": {"photo_name": "a.jpg", "photo_b64": "data:image/jpeg;base64,A",
                          "lng": 106.8},
              "weighing": [], "officer": VALID["officer"]}
        self._reject(ev, "arrival.lat")

    def test_arrival_lat_out_of_region(self):
        ev = {"arrival": {"photo_name": "a.jpg", "photo_b64": "data:image/jpeg;base64,A",
                          "lat": 51.5, "lng": 106.8},  # London, not Jakarta
              "weighing": [], "officer": VALID["officer"]}
        self._reject(ev, "arrival.lat")

    def test_arrival_lng_out_of_region(self):
        ev = {"arrival": {"photo_name": "a.jpg", "photo_b64": "data:image/jpeg;base64,A",
                          "lat": -6.2, "lng": -0.12},
              "weighing": [], "officer": VALID["officer"]}
        self._reject(ev, "arrival.lng")

    # -- weighing ---------------------------------------------------------
    def test_weighing_weight_must_be_positive(self):
        ev = {"arrival": VALID["arrival"],
              "weighing": [{"fraction": "Residu", "weight_kg": 0,
                            "photo_name": "t.jpg", "photo_b64": "data:image/jpeg;base64,B"}],
              "officer": VALID["officer"]}
        self._reject(ev, "weighing[0].weight_kg")

    def test_weighing_weight_above_bound(self):
        ev = {"arrival": VALID["arrival"],
              "weighing": [{"fraction": "Residu", "weight_kg": 60_001,
                            "photo_name": "t.jpg", "photo_b64": "data:image/jpeg;base64,B"}],
              "officer": VALID["officer"]}
        self._reject(ev, "weighing[0].weight_kg")

    def test_weighing_unsupported_fraction(self):
        ev = {"arrival": VALID["arrival"],
              "weighing": [{"fraction": "Batu Bara", "weight_kg": 10,
                            "photo_name": "t.jpg", "photo_b64": "data:image/jpeg;base64,B"}],
              "officer": VALID["officer"]}
        self._reject(ev, "weighing[0].fraction")

    def test_weighing_missing_photo(self):
        ev = {"arrival": VALID["arrival"],
              "weighing": [{"fraction": "Residu", "weight_kg": 10,
                            "photo_name": "t.jpg"}],
              "officer": VALID["officer"]}
        self._reject(ev, "weighing[0].photo_b64")

    # -- officer ------------------------------------------------------------
    def test_officer_name_required(self):
        ev = {"arrival": VALID["arrival"], "weighing": [],
              "officer": {"photo_name": "p.jpg", "photo_b64": "data:image/jpeg;base64,C"}}
        self._reject(ev, "officer.name")


    def test_officer_photo_required(self):
        ev = {"arrival": VALID["arrival"], "weighing": [],
              "officer": {"name": "Dicky"}}
        with self.assertRaises(ValueError) as ctx:
            _validate_evidence(ev)
        # photo_name is validated first; both fields are required.
        self.assertIn("officer.photo_name", str(ctx.exception))
        store = _store()
        spj = _active_spj(store)
        bad = {"arrival": {"photo_name": "name-only.jpg"}, "weighing": [],
               "officer": {}}
        with self.assertRaises(ValueError):
            store.complete_stop(spj.spj_id, 0, evidence=bad)
        fresh = store.get(spj.spj_id)
        self.assertEqual(fresh.stops[0].status, "pending")
        self.assertIsNone(fresh.stops[0].evidence)
        self.assertEqual(fresh.status, "aktif")

    def test_valid_evidence_completes_stop(self):
        store = _store()
        spj = _active_spj(store)
        done = store.complete_stop(spj.spj_id, 0, evidence=VALID)
        self.assertEqual(done.stops[0].status, "completed")
        self.assertEqual(done.status, "selesai")


if __name__ == "__main__":
    unittest.main()
