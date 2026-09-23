"""#38: modeled SILIKA values must not count as actual data.

timbulan_kecamatan_2023.csv values are modeled from the SILIKA
population formula (documented limitation), yet the registry
classified them as `real` — inflating the actual-data count shown to
auditors. Modeled baselines get their own classification and are
excluded from the actual count.
"""

from __future__ import annotations

import unittest

from app.real_data import (
    ACTUAL_DATA_CLASSIFICATIONS,
    build_provenance_records,
    data_provenance,
)

MODELED_FILE = "timbulan_kecamatan_2023.csv"


class ModeledSilikaClassificationTests(unittest.TestCase):
    def test_timbulan_kecamatan_is_modeled_from_real_baseline(self):
        records = build_provenance_records()
        rec = next((r for r in records if r["name"] == MODELED_FILE), None)
        self.assertIsNotNone(rec, "registry entry must exist")
        self.assertEqual(
            rec["classification"], "modeled_from_real_baseline",
            "SILIKA-modeled values must not be classified as real/actual")

    def test_actual_data_count_excludes_modeled(self):
        summary = data_provenance()
        actual = summary["real_data_count"] if isinstance(summary, dict) else None
        self.assertIsNotNone(actual, "data_provenance must expose real_data_count")
        records = build_provenance_records()
        recount = sum(
            1 for r in records
            if r["classification"] in ACTUAL_DATA_CLASSIFICATIONS)
        self.assertEqual(actual, recount,
                         "real_data_count must match only actual classifications")
        modeled = [r for r in records
                   if r["classification"] == "modeled_from_real_baseline"]
        self.assertTrue(any(r["name"] == MODELED_FILE for r in modeled),
                        "the SILIKA-modeled file must be present and excluded")

    def test_actual_classifications_do_not_include_modeled(self):
        for banned in ("modeled_from_real_baseline", "proxy",
                       "calibrated_synthetic", "derived"):
            self.assertNotIn(banned, ACTUAL_DATA_CLASSIFICATIONS)

    def test_registry_classifications_are_documented(self):
        allowed = set(ACTUAL_DATA_CLASSIFICATIONS) | {
            "modeled_from_real_baseline", "proxy", "calibrated_synthetic",
            "derived"}
        for rec in build_provenance_records():
            self.assertIn(rec["classification"], allowed,
                          f"undocumented classification {rec['classification']} "
                          f"on {rec['name']}")


if __name__ == "__main__":
    unittest.main()
