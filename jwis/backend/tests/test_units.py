"""One unit contract for every resource quantity (issue #25).

The regression these tests defend: the same field name meant a truck count in
the forecast pipeline and a headcount in the permit pipeline, so identical
tonnage produced crew numbers that differed by 4x, and no test noticed because
nothing asserted the relationship between the fields.
"""
import unittest

from app.units import (BIN_CAPACITY_TONS, CREW_SIZE_WORKERS, SHIFT_HOURS,
                       TRUCK_CAPACITY_TONS, resource_basis,
                       resource_requirements)


class ResourceUnitTests(unittest.TestCase):
    def test_block_is_internally_consistent(self):
        """trucks == crews, workers == 4 x crews, man-hours == workers x shift."""
        block = resource_requirements(72.0)
        self.assertEqual(block["trucks_required"], 4)  # ceil(72/18)
        self.assertEqual(block["crews_required"], block["trucks_required"])
        self.assertEqual(block["workers_required"],
                         block["crews_required"] * CREW_SIZE_WORKERS)
        self.assertEqual(block["man_hours_required"],
                         block["workers_required"] * SHIFT_HOURS)
        self.assertEqual(block["bins_required"], 29)  # ceil(72/2.5)

    def test_marginal_fleet_is_measured_against_the_baseline(self):
        block = resource_requirements(72.0, baseline_tons=54.0)
        self.assertEqual(block["recommended_extra_trucks"], 1)  # ceil(18/18)
        self.assertEqual(block["recommended_extra_crews"],
                         block["recommended_extra_trucks"])
        self.assertEqual(block["recommended_extra_workers"],
                         block["recommended_extra_trucks"] * CREW_SIZE_WORKERS)
        # No spike -> no extra fleet, while the total requirement is unchanged.
        flat = resource_requirements(54.0, baseline_tons=54.0)
        self.assertEqual(flat["recommended_extra_trucks"], 0)
        self.assertEqual(flat["trucks_required"], 3)

    def test_zero_demand_asks_for_nothing(self):
        block = resource_requirements(0.0)
        self.assertEqual((block["trucks_required"], block["crews_required"],
                          block["workers_required"], block["man_hours_required"],
                          block["bins_required"]), (0, 0, 0, 0.0, 0))

    def test_basis_string_matches_the_constants(self):
        basis = resource_basis()
        self.assertIn(f"{TRUCK_CAPACITY_TONS:g} t", basis)
        self.assertIn(f"{CREW_SIZE_WORKERS} workers", basis)
        self.assertIn(f"{BIN_CAPACITY_TONS:g} t", basis)


class ForecastPipelineUnitTests(unittest.TestCase):
    def test_kecamatan_payload_publishes_the_glossary(self):
        from app.main import predictions_kecamatan
        payload = predictions_kecamatan(rainfall_mm=0.0, event_attendance=0)
        self.assertIn("crews_required", payload["units"])
        self.assertIn("workers_required", payload["units"])
        for row in payload["kecamatan"]:
            self.assertEqual(row["crews_required"], row["trucks_required"])
            self.assertEqual(row["workers_required"],
                             row["crews_required"] * CREW_SIZE_WORKERS)
            self.assertEqual(row["man_hours_required"],
                             row["workers_required"] * SHIFT_HOURS)
            self.assertNotIn("disposal_bins_required", row)
            self.assertIn("bins_required", row)

    def test_permit_intake_uses_the_same_formula(self):
        from fastapi.testclient import TestClient
        from app.main import app
        client = TestClient(app, raise_server_exceptions=False)
        login = client.post("/api/auth/login", json={
            "username": "administrator", "password": "administrator-demo-pass"})
        client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        res = client.post("/api/events/permits", json={
            "name": "Konser Uji", "location_name": "GBK Senayan",
            "event_date": "2026-08-30", "expected_attendance": 70000,
            "lat": -6.2183, "lng": 106.8022})
        self.assertEqual(res.status_code, 201)
        impact = res.json()["impact"]
        expected = resource_requirements(impact["predicted_waste_tons"])
        self.assertEqual(impact["crews_required"], expected["crews_required"])
        self.assertEqual(impact["workers_required"], expected["workers_required"])
        self.assertEqual(impact["man_hours_required"],
                         expected["man_hours_required"])
        self.assertEqual(impact["trucks_required"], expected["trucks_required"])
        self.assertEqual(impact["bins_required"], expected["bins_required"])

    def test_fixture_permits_use_the_same_formula(self):
        """Fixture events must not ship numbers no producer would emit."""
        from app.data import events_permits_payload
        for event in events_permits_payload():
            expected = resource_requirements(event["predicted_waste_tons"])
            self.assertEqual(event["crews_required"], expected["crews_required"])
            self.assertEqual(event["workers_required"], expected["workers_required"])
            self.assertEqual(event["man_hours_required"],
                             expected["man_hours_required"])
            self.assertEqual(event["trucks_required"], expected["trucks_required"])
            self.assertEqual(event["bins_required"], expected["bins_required"])
            # Legacy aliases are gone: one name per quantity.
            self.assertNotIn("backup_trucks_required", event)
            self.assertNotIn("large_bins_required", event)


if __name__ == "__main__":
    unittest.main()
