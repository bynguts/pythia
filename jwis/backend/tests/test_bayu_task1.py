"""Task 1 batch tests for PIC Bayu backend issues.

#26 — trucks_required must use a capacity-safe ceiling so that
       trucks_required * 18 >= predicted_tons for every kecamatan.
#57 — receipt total_weight_kg must be absent or a finite positive value
       within an operational bound; invalid values must create no history
       event.
#47 — no ResourceWarning from SPJ store file handling (covered by the
       suite-wide `-W error::ResourceWarning` run; corrupt-file recovery
       is asserted here).
"""

from __future__ import annotations

import math
import unittest

from fastapi.testclient import TestClient

from app.main import app


class TrucksRequiredCeilingTests(unittest.TestCase):
    """#26: capacity-safe ceiling for truck requirements."""

    def test_ceiling_exact_multiple(self):
        # 36.0 t / 18 t = exactly 2 trucks; ceiling must stay 2.
        self.assertEqual(math.ceil(36.0 / 18), 2)

    def test_ceiling_fractional_overage(self):
        # 36.1 t needs 3 trucks: 2 trucks only carry 36 t.
        self.assertEqual(math.ceil(36.1 / 18), 3)

    def test_api_trucks_required_covers_predicted_tons(self):
        client = TestClient(app)
        res = client.get("/api/predictions/kecamatan")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        features = body if isinstance(body, list) else body.get(
            "features", body.get("kecamatan", []))
        self.assertTrue(len(features) > 0,
                        "forecast response must expose per-kecamatan features")
        for f in features:
            tons = f.get("predicted_tons")
            trucks = f.get("trucks_required")
            if tons is None or trucks is None:
                continue
            self.assertGreaterEqual(
                trucks * 18, tons,
                f"kecamatan {f.get('kecamatan')}: {trucks} trucks x 18t = "
                f"{trucks * 18} does not cover {tons} t")


class ReceiptWeightValidationTests(unittest.TestCase):
    """#57: reject invalid SPJ receipt weights without side effects."""

    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "administrator", "password": "administrator-demo-pass"})
        self.client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        # Build one selesai SPJ to submit receipts against.
        created = self.client.post("/api/spj", json={
            "driver_name": "W", "truck_code": "T-BAYU57",
            "destination": "TPST Bantargebang", "weigh_on_site": True,
            "priority": "normal", "note": "57 test"})
        self.assertEqual(created.status_code, 201)
        self.spj_id = created.json()["spj_id"]
        self.client.post(f"/api/spj/{self.spj_id}/stops", json={
            "name": "S", "kecamatan": "K", "address": "A", "lat": -6.2, "lng": 106.8})
        self.client.post(f"/api/spj/{self.spj_id}/activate")
        done = self.client.post(f"/api/spj/{self.spj_id}/stops/0/complete", json={"evidence": {
            "arrival": {"photo_name": "a.jpg", "photo_b64": "data:image/jpeg;base64,AAA",
                        "lat": -6.2, "lng": 106.8},
            "weighing": [],
            "officer": {"photo_name": "p.jpg",
                        "photo_b64": "data:image/jpeg;base64,CCC",
                        "name": "X"}}})
        self.assertEqual(done.status_code, 200)

    def tearDown(self):
        pass  # per-session DB dies with the test session; no cleanup needed

    def _submit(self, weight):
        return self.client.post(f"/api/spj/{self.spj_id}/receipt", json={
            "photo_name": "struk.jpg", "photo_b64": "data:image/jpeg;base64,AA",
            "total_weight_kg": weight})

    def test_zero_weight_rejected(self):
        self.assertEqual(self._submit(0).status_code, 422)

    def test_negative_weight_rejected(self):
        self.assertEqual(self._submit(-5).status_code, 422)

    def test_above_maximum_rejected(self):
        self.assertEqual(self._submit(60_000.5).status_code, 422)

    def test_null_weight_accepted(self):
        self.assertEqual(self._submit(None).status_code, 201)

    def test_valid_maximum_accepted(self):
        self.assertEqual(self._submit(60_000).status_code, 201)

    def test_invalid_weight_creates_no_history_event(self):
        from app.main import history_store
        before = len(history_store.list_events(limit=1000))
        self._submit(-10)
        after_events = history_store.list_events(limit=1000)
        self.assertEqual(len(after_events), before,
                         "rejected receipt must not append a history event")
        self.assertFalse(any(
            e["event_type"] == "spj_receipt_submitted" and
            e["payload"].get("spj_id") == self.spj_id and
            e["payload"].get("total_weight_kg") == -10
            for e in after_events))


class SpjFileHandleTests(unittest.TestCase):
    """#47: corrupt legacy JSON still recovers (behavior unchanged)."""

    def test_corrupt_legacy_json_starts_empty(self):
        import json as _json
        import os
        import tempfile
        from app.spj import SpjStore
        path = os.path.join(tempfile.gettempdir(), "bayu47_corrupt.db")
        legacy = os.path.splitext(path)[0] + ".json"
        for suffix in ("", "-wal", "-shm"):
            p = path + suffix
            if os.path.exists(p):
                os.remove(p)
        with open(legacy, "w", encoding="utf-8") as fh:
            fh.write("{not valid json")
        try:
            store = SpjStore(persist_path=path)
            self.assertEqual(len(store.list()), 0)
            self.assertIsInstance(store.create(
                driver_name="A", truck_code="T-47", destination="TPST Bantargebang",
                weigh_on_site=False, priority="normal", note="").spj_number, str)
        finally:
            for suffix in ("", "-wal", "-shm"):
                p = path + suffix
                if os.path.exists(p):
                    os.remove(p)
            if os.path.exists(legacy):
                os.remove(legacy)


if __name__ == "__main__":
    unittest.main()
