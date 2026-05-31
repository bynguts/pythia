import unittest

from fastapi.testclient import TestClient

from app.main import app


class MainApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)

    def test_ml_predict_rejects_invalid_target_date(self):
        response = self.client.post(
            "/api/ml/predict",
            json={"kelurahan": "Tebet", "target_date": "not-a-date"},
        )

        self.assertEqual(response.status_code, 422)

    def test_ml_predict_all_rejects_invalid_target_date(self):
        response = self.client.post("/api/ml/predict-all?target_date=not-a-date")

        self.assertEqual(response.status_code, 422)

    def test_dispatch_confirm_returns_404_for_unknown_dispatch(self):
        response = self.client.post(
            "/api/dispatch/no-such-id/confirm",
            json={"status": "DONE", "note": "unknown id"},
        )

        self.assertEqual(response.status_code, 404)

    def test_predictions_rejects_event_scale_outside_documented_range(self):
        low = self.client.get("/api/predictions?event_scale=-99")
        high = self.client.get("/api/predictions?event_scale=999")

        self.assertEqual(low.status_code, 422)
        self.assertEqual(high.status_code, 422)


if __name__ == "__main__":
    unittest.main()
