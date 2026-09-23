"""#18: synthetic-target validation must not be labeled reliable.

Weekly/monthly per-district metrics are evaluated against a
calibrated-synthetic district series (avg daily-district R² -0.033),
not observed ground truth. The suitability contract must separate
validation target classes and only claim 'reliable' where observed
holdout evidence exists at that resolution.
"""

from __future__ import annotations

import unittest

from app.forecast_metrics import suitability_labels, suitability_details


class SuitabilityTaxonomyTests(unittest.TestCase):
    def test_no_reliable_without_observed_target(self):
        details = suitability_details()
        labels = suitability_labels()
        for key, label in labels.items():
            detail = details.get(key)
            if label == "reliable":
                self.assertIsNotNone(
                    detail, f"{key} needs detail to claim reliable")
                self.assertIn(
                    detail["validation_target"], ("observed", "real"),
                    f"{key} claims reliable on a {detail['validation_target']} "
                    f"target — synthetic-target validation must not be "
                    f"labeled reliable")
            if detail and detail["validation_target"] == "synthetic":
                self.assertNotEqual(
                    label, "reliable",
                    f"{key} validates against a synthetic target and must "
                    f"not be reliable")

    def test_details_expose_target_class_sample_period_baseline(self):
        details = suitability_details()
        required = {"validation_target", "sample", "period", "baseline"}
        for key, detail in details.items():
            missing = required - set(detail.keys())
            self.assertEqual(
                missing, set(),
                f"suitability detail for {key} missing {missing}")

    def test_city_day_is_observed(self):
        # City-level daily has SIPSN-observed city timbulan to validate
        # against at aggregate level.
        self.assertEqual(suitability_details()["city_day"]["validation_target"],
                         "observed")

    def test_district_week_month_are_synthetic(self):
        details = suitability_details()
        for key in ("district_week", "district_month"):
            self.assertEqual(
                details[key]["validation_target"], "synthetic",
                f"{key} is validated on the calibrated-synthetic district "
                f"series and must say so")
            self.assertNotEqual(suitability_labels()[key], "reliable")

    def test_labels_still_carry_daily_district_not_supported(self):
        self.assertEqual(suitability_labels()["district_day"], "not_supported")

    def test_suitability_endpoint_exposes_details(self):
        from fastapi.testclient import TestClient
        from app.main import app as fastapp
        client = TestClient(fastapp)
        res = client.get("/api/ml/suitability")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        labels = body.get("resolutions") or body.get("labels") or body
        details = body.get("details")
        self.assertIsNotNone(details, "endpoint must expose target details")
        for key, detail in details.items():
            self.assertIn("validation_target", detail)


if __name__ == "__main__":
    unittest.main()
