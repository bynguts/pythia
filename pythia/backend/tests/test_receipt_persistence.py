# -*- coding: utf-8 -*-
"""Receipt persistence contract for issue #52.

The receipt is written to `spj_receipts` and exposed as metadata (never bytes)
by both the SPJ detail read and the evidence summary. The evidence summary
previously raised NameError (HTTP 500) as soon as a receipt existed, so the
`test_evidence_summary_after_receipt` case is the regression lock for that.
"""
import unittest

from fastapi.testclient import TestClient

from app.main import app

PNG_BYTES = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dw"
             "HwAFAAH/q842iQAAAABJRU5ErkJggg==")

EVIDENCE = {
    "arrival": {"photo_name": "a.jpg", "photo_b64": "ZGF0YQ==",
                "lat": -6.2, "lng": 106.8},
    "weighing": [],
    "officer": {"name": "Dicky", "photo_name": "p.jpg", "photo_b64": "ZGF0YQ=="},
}


class ReceiptPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "administrator", "password": "administrator-demo-pass"})
        self.client.headers.update(
            {"Authorization": f"Bearer {login.json()['token']}"})

    def _completed_spj(self, truck_code: str) -> str:
        created = self.client.post("/api/spj", json={
            "driver_name": "E2E", "truck_code": truck_code,
            "destination": "TPST Bantargebang", "weigh_on_site": False,
            "priority": "normal", "note": "",
            "stops": [{"name": "S", "kecamatan": "K", "address": "A",
                       "lat": -6.2, "lng": 106.8}]})
        self.assertEqual(created.status_code, 201, created.text)
        spj_id = created.json()["spj_id"]
        self.client.post(f"/api/spj/{spj_id}/activate")
        done = self.client.post(f"/api/spj/{spj_id}/stops/0/complete",
                                json={"evidence": EVIDENCE})
        self.assertEqual(done.status_code, 200, done.text)
        return spj_id

    def _submit_receipt(self, spj_id: str, **overrides):
        body = {"photo_name": "struk.jpg", "photo_b64": PNG_BYTES,
                "total_weight_kg": 42.0}
        body.update(overrides)
        return self.client.post(f"/api/spj/{spj_id}/receipt", json=body)

    def test_receipt_persists_and_is_exposed_without_bytes(self):
        spj_id = self._completed_spj("T-401")
        response = self._submit_receipt(spj_id)
        self.assertEqual(response.status_code, 201)

        detail = self.client.get(f"/api/spj/{spj_id}")
        self.assertEqual(detail.status_code, 200)
        receipt = detail.json()["receipt"]
        self.assertEqual(receipt["photo_name"], "struk.jpg")
        self.assertEqual(receipt["total_weight_kg"], 42.0)
        self.assertEqual(receipt["submitted_by"], "administrator")
        self.assertTrue(receipt["has_photo"])
        self.assertTrue(receipt["recorded_at"])
        self.assertNotIn(PNG_BYTES, detail.text,
                         "detail must not embed the receipt image bytes")

    def test_evidence_summary_after_receipt(self):
        spj_id = self._completed_spj("T-402")
        self.assertEqual(self._submit_receipt(spj_id).status_code, 201)
        summary = self.client.get(f"/api/spj/{spj_id}/evidence-summary")
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertIsNotNone(summary.json()["receipt"])

    def test_receipt_survives_across_store_reads(self):
        spj_id = self._completed_spj("T-403")
        self.assertEqual(self._submit_receipt(spj_id).status_code, 201)
        listing = self.client.get("/api/spj").json()["spj"]
        entry = next(s for s in listing if s["spj_id"] == spj_id)
        self.assertEqual(entry["receipt"]["photo_name"], "struk.jpg")
        self.assertNotIn("photo_b64", entry["receipt"])

    def test_receipt_photo_endpoint_serves_the_image(self):
        spj_id = self._completed_spj("T-404")
        self.assertEqual(self._submit_receipt(spj_id).status_code, 201)
        photo = self.client.get(f"/api/spj/{spj_id}/receipt/photo")
        self.assertEqual(photo.status_code, 200)
        self.assertIn(PNG_BYTES, photo.text)

    def test_second_different_submission_is_a_conflict(self):
        spj_id = self._completed_spj("T-405")
        self.assertEqual(self._submit_receipt(spj_id).status_code, 201)
        conflict = self._submit_receipt(spj_id, photo_name="lain.jpg")
        self.assertEqual(conflict.status_code, 409)
        receipt = self.client.get(f"/api/spj/{spj_id}").json()["receipt"]
        self.assertEqual(receipt["photo_name"], "struk.jpg",
                         "a rejected second submission must not replace evidence")


if __name__ == "__main__":
    unittest.main()
