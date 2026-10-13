"""#24: dispatch confirm status must be a documented enum.

Any 1-30 character string used to be accepted and persisted as a
terminal field status (BANANA was accepted with HTTP 200). The status
is now a Literal of the documented operational values; unknown values
return 422 without mutating the dispatch.
"""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app.main import app
from app.storage import HistoryStore

LEGAL_STATUSES = ("READY", "ISSUE", "SIAP", "DONE")


class DispatchStatusEnumTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "administrator", "password": "administrator-demo-pass"})
        self.client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        created = self.client.post("/api/dispatch", json={
            "truck_code": "T-24", "instruction": "#24 enum test", "manager_id": "MGR"})
        self.assertEqual(created.status_code, 200)
        self.dispatch_id = created.json()["id"]

    def tearDown(self):
        # Terminal confirmations cannot be undone; the per-session DB
        # dies with the test session.
        pass

    def test_every_legal_status_accepted(self):
        for status in LEGAL_STATUSES:
            created = self.client.post("/api/dispatch", json={
                "truck_code": "T-24b", "instruction": f"enum {status}",
                "manager_id": "MGR"})
            did = created.json()["id"]
            res = self.client.post(f"/api/dispatch/{did}/confirm",
                                   json={"status": status, "note": "ok"})
            self.assertEqual(res.status_code, 200, f"legal status {status} must pass")
            self.assertEqual(res.json()["field_status"], status)

    def test_banana_rejected_422(self):
        res = self.client.post(f"/api/dispatch/{self.dispatch_id}/confirm",
                               json={"status": "BANANA", "note": ""})
        self.assertEqual(res.status_code, 422)

    def test_empty_rejected_422(self):
        res = self.client.post(f"/api/dispatch/{self.dispatch_id}/confirm",
                               json={"status": "", "note": ""})
        self.assertEqual(res.status_code, 422)

    def test_lowercase_variant_rejected_422(self):
        res = self.client.post(f"/api/dispatch/{self.dispatch_id}/confirm",
                               json={"status": "ready", "note": ""})
        self.assertEqual(res.status_code, 422)

    def test_rejection_does_not_mutate_dispatch(self):
        rows_before = [r for r in HistoryStore().list_dispatches()
                       if r["id"] == self.dispatch_id]
        self.client.post(f"/api/dispatch/{self.dispatch_id}/confirm",
                         json={"status": "BANANA", "note": ""})
        rows_after = [r for r in HistoryStore().list_dispatches()
                      if r["id"] == self.dispatch_id]
        self.assertEqual(len(rows_after), 1)
        self.assertEqual(rows_after[0]["field_status"], rows_before[0]["field_status"])
        # And the dispatch is still pending for its truck.
        pending = self.client.get("/api/dispatch/T-24").json()
        self.assertTrue(any(d["id"] == self.dispatch_id for d in pending))


if __name__ == "__main__":
    unittest.main()
