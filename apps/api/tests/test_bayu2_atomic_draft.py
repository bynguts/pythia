"""#60: creating an SPJ with its stops must be one atomic operation.

The old flow (POST /spj then one POST per stop) could leave an empty or
partially populated draft when a stop failed. Creating a draft with
stops in a single request must either persist the SPJ with ALL stops
in exact order, or persist nothing.
"""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app.main import app
from app.spj import SpjStore

from spj_testutil import fresh_store_path


def _stops(n: int):
    return [{"name": f"S{i}", "kecamatan": "K", "address": f"A{i}",
             "lat": -6.2 - i * 0.01, "lng": 106.8 + i * 0.01} for i in range(n)]


class AtomicDraftCreationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "administrator", "password": "administrator-demo-pass"})
        self.client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})

    def _body(self, stops, **over):
        payload = {"driver_name": "B", "truck_code": "T-60",
                   "destination": "TPST Bantargebang", "weigh_on_site": True,
                   "priority": "normal", "note": "", "stops": stops}
        payload.update(over)
        return payload

    def test_create_with_stops_persists_all_in_order(self):
        res = self.client.post("/api/spj", json=self._body(_stops(3)))
        self.assertEqual(res.status_code, 201)
        spj = res.json()
        self.assertEqual(len(spj["stops"]), 3)
        self.assertEqual([s["name"] for s in spj["stops"]], ["S0", "S1", "S2"])
        self.assertEqual([s["lat"] for s in spj["stops"]],
                         [-6.2, -6.21, -6.22])

    def test_legacy_create_without_stops_still_works(self):
        res = self.client.post("/api/spj", json={
            "driver_name": "B", "truck_code": "T-60b",
            "destination": "TPST Bantargebang", "weigh_on_site": False,
            "priority": "normal", "note": ""})
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["stops"], [])

    def test_failing_stop_leaves_no_partial_draft(self):
        bad_stops = _stops(2) + [{"name": "", "kecamatan": "", "address": "",
                                  "lat": 999.0, "lng": 0.0}]  # invalid stop
        before = self.client.get("/api/spj").json()["count"]
        res = self.client.post("/api/spj", json=self._body(bad_stops))
        self.assertIn(res.status_code, (409, 422))
        after = self.client.get("/api/spj").json()["count"]
        self.assertEqual(after, before,
                         "failed composed create must not leave a partial draft")

    def test_duplicate_stop_name_rejected_atomically(self):
        stops = _stops(2)
        stops[1]["name"] = stops[0]["name"]
        before = self.client.get("/api/spj").json()["count"]
        res = self.client.post("/api/spj", json=self._body(stops))
        self.assertIn(res.status_code, (409, 422))
        after = self.client.get("/api/spj").json()["count"]
        self.assertEqual(after, before)


class StoreAtomicCreateTests(unittest.TestCase):
    """Direct store-level atomicity for #60."""

    def test_create_with_stops_atomic_rollback_on_bad_stop(self):
        store = SpjStore(persist_path=fresh_store_path("bayu60_store.db"))
        with self.assertRaises(ValueError) as ctx:
            store.create_with_stops(
                driver_name="B", truck_code="T-60c",
                destination="TPST Bantargebang", weigh_on_site=True,
                priority="normal", note="",
                stops=[{"name": "S0", "kecamatan": "K", "address": "A",
                        "lat": -6.2, "lng": 106.8},
                       {"name": "bad", "kecamatan": "", "address": "",
                        "lat": None, "lng": None}])
        self.assertIn("stops[1]", str(ctx.exception))
        self.assertEqual(len(store.list()), 0,
                         "failed composed create must leave no SPJ row")

    def test_create_with_stops_ok(self):
        store = SpjStore(persist_path=fresh_store_path("bayu60_store_ok.db"))
        try:
            spj = store.create_with_stops(
                driver_name="B", truck_code="T-60d",
                destination="TPST Bantargebang", weigh_on_site=True,
                priority="normal", note="",
                stops=_stops(2))
        except ValueError:
            self.fail("valid stops must not raise")
        self.assertEqual(len(store.get(spj.spj_id).stops), 2)

    def test_rollback_leaves_no_row(self):
        store = SpjStore(persist_path=fresh_store_path("bayu60_rollback.db"))
        count_before = len(store.list())
        try:
            store.create_with_stops(
                driver_name="B", truck_code="T-60e",
                destination="TPST Bantargebang", weigh_on_site=True,
                priority="normal", note="",
                stops=[{"name": "S0", "kecamatan": "K", "address": "A",
                        "lat": -6.2, "lng": 106.8},
                       {"name": "bad", "kecamatan": "K", "address": "A",
                        "lat": "not-a-number", "lng": 0.0}])
            self.fail("expected ValueError")
        except ValueError:
            pass
        self.assertEqual(len(store.list()), count_before,
                         "rolled-back composed create must leave no SPJ row")


if __name__ == "__main__":
    unittest.main()
