import unittest

from app.fleet import data
from app.fleet.facilities import route_ground_truth


class DataPayloadHelpersTests(unittest.TestCase):
    def test_fleet_history_payload_tracks_mock_trips(self):
        rows = data.fleet_history_payload(truck_code="T-047")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["truck_code"], "T-047")
        self.assertIn("deviations_detected", rows[0])

    def test_tpa_queue_status_payload_has_status_shape(self):
        payload = data.tpa_queue_status_payload()
        for key in ("trucks_in_queue", "avg_wait_minutes", "status_label", "method"):
            self.assertIn(key, payload)
        self.assertEqual(payload["method"], "seeded discrete-event queue simulation")

    def test_tpa_queue_status_point_is_the_verified_bantargebang_facility(self):
        # The AR spotter measures its 1.5 km radius from this point. The A*
        # weighbridge-approach node (-6.331, 106.991) sits ~2.2 km outside the
        # landfill, so a crew on site never reached the spotter view.
        payload = data.tpa_queue_status_payload()
        self.assertEqual((payload["lat"], payload["lng"]), route_ground_truth("TPST Bantargebang"))
        self.assertEqual(payload["facility_name"], "TPST Bantargebang")

    def test_events_permits_payload_has_at_least_one_event(self):
        payload = data.events_permits_payload()
        self.assertGreaterEqual(len(payload), 1)
        self.assertIn("name", payload[0])

    def test_unlicensed_collectors_payload_reports_authorized_count(self):
        payload = data.unlicensed_collectors_payload()
        self.assertIn("observed_count", payload)
        self.assertIn("alerts", payload)


if __name__ == "__main__":
    unittest.main()
