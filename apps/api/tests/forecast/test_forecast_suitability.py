"""#18: synthetic-target validation must not be labeled reliable (nor city-day observed).

Weekly/monthly per-district metrics are evaluated against a
calibrated-synthetic district series (avg daily-district R² -0.033),
not observed ground truth. The suitability contract must separate
validation target classes and only claim 'reliable' where observed
holdout evidence exists at that resolution.
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

from app.core import paths
from app.forecast.forecast_metrics import beats_naive, suitability_details, suitability_labels


class SuitabilityTaxonomyTests(unittest.TestCase):
    def test_no_reliable_without_observed_target(self):
        details = suitability_details()
        labels = suitability_labels()
        for key, label in labels.items():
            detail = details.get(key)
            if label == "reliable":
                self.assertIsNotNone(detail, f"{key} needs detail to claim reliable")
                self.assertIn(
                    detail["validation_target"],
                    ("observed", "real"),
                    f"{key} claims reliable on a {detail['validation_target']} "
                    f"target — synthetic-target validation must not be "
                    f"labeled reliable",
                )
            if detail and detail["validation_target"] == "synthetic":
                self.assertNotEqual(
                    label, "reliable", f"{key} validates against a synthetic target and must not be reliable"
                )

    def test_details_expose_target_class_sample_period_baseline(self):
        details = suitability_details()
        required = {"validation_target", "sample", "period", "baseline"}
        for key, detail in details.items():
            missing = required - set(detail.keys())
            self.assertEqual(missing, set(), f"suitability detail for {key} missing {missing}")

    def test_city_day_is_synthetic_not_reliable(self):
        # City-day is a sum of the calibrated-synthetic kecamatan series: no
        # observed daily city series exists, so it may not be called reliable.
        self.assertEqual(suitability_details()["city_day"]["validation_target"], "synthetic")
        self.assertEqual(suitability_labels()["city_day"], "synthetic_validated")
        self.assertFalse(suitability_details()["city_day"]["evidence_of_skill"])

    def test_hotspot_rank_is_not_evidence_of_skill(self):
        detail = suitability_details()["hotspot_rank"]
        self.assertEqual(suitability_labels()["hotspot_rank"], "reproduces_input")
        self.assertFalse(detail["evidence_of_skill"])
        self.assertIn("not evidence of skill", detail["baseline"])

    def test_only_real_backtests_carry_evidence_of_skill(self):
        for key, detail in suitability_details().items():
            if detail["evidence_of_skill"]:
                self.assertEqual(detail["validation_target"], "real", key)
                self.assertEqual(suitability_labels()[key], "backtested_real", key)

    def test_district_week_month_are_synthetic(self):
        details = suitability_details()
        for key in ("district_week", "district_month"):
            self.assertEqual(
                details[key]["validation_target"],
                "synthetic",
                f"{key} is validated on the calibrated-synthetic district series and must say so",
            )
            self.assertNotEqual(suitability_labels()[key], "reliable")

    def test_labels_still_carry_daily_district_not_supported(self):
        self.assertEqual(suitability_labels()["district_day"], "not_supported")

    def test_gate_arrivals_input_is_a_real_backtest_classed_by_beats_naive(self):
        # The TPA queue's daily-arrival input, backtested on the real Bantargebang trips
        # (queue_calibration.json); the simulated waits themselves stay unvalidated.
        artifact = json.loads(paths.QUEUE_CALIBRATION.read_text(encoding="utf-8"))
        detail = suitability_details()["tpa_gate_arrivals_day"]
        self.assertEqual(detail["validation_target"], "real")
        self.assertEqual(detail["metrics"], artifact["backtest"])
        self.assertEqual(detail["period"], artifact["backtest"]["period"])
        self.assertIs(detail["evidence_of_skill"], beats_naive(artifact["backtest"]))
        self.assertEqual(detail["wait_validation"], "not_observed")

    def test_gate_arrivals_detail_without_the_artifact_claims_nothing(self):
        with mock.patch.object(
            paths, "QUEUE_CALIBRATION", paths.MODELS_DIR / "missing_queue_calibration.json"
        ):
            detail = suitability_details()["tpa_gate_arrivals_day"]
        self.assertFalse(detail["evidence_of_skill"])
        self.assertEqual(detail["period"], "unavailable")
        self.assertNotIn("metrics", detail)

    def test_suitability_endpoint_exposes_details(self):
        from fastapi.testclient import TestClient

        from app.main import app as fastapp

        client = TestClient(fastapp)
        res = client.get("/api/ml/suitability")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        details = body.get("details")
        self.assertIsNotNone(details, "endpoint must expose target details")
        for detail in details.values():
            self.assertIn("validation_target", detail)
        self.assertEqual(details["tpa_gate_arrivals_day"]["validation_target"], "real")


if __name__ == "__main__":
    unittest.main()
