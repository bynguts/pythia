"""Tests for deviation alert hysteresis and TPA queue scenario contract."""

import unittest

from app.fleet.data import tpa_queue_status_payload
from app.fleet.deviation_state import apply_hysteresis, reset_hysteresis


class HysteresisTests(unittest.TestCase):
    def setUp(self):
        reset_hysteresis()

    def test_opens_above_500m(self):
        self.assertTrue(apply_hysteresis("T-X", 600.0))

    def test_holds_in_deadband(self):
        apply_hysteresis("T-X", 600.0)
        self.assertTrue(apply_hysteresis("T-X", 300.0), "alert must hold between 50-500m (no flicker)")

    def test_clears_under_50m(self):
        apply_hysteresis("T-X", 600.0)
        apply_hysteresis("T-X", 300.0)
        self.assertFalse(apply_hysteresis("T-X", 30.0))

    def test_clean_truck_stays_clean(self):
        self.assertFalse(apply_hysteresis("T-Y", 120.0))


class TpaQueueScenarioTests(unittest.TestCase):
    def test_peak_scenario_shows_bottleneck(self):
        peak = tpa_queue_status_payload(scenario="peak")
        self.assertEqual(peak["scenario"], "peak")
        self.assertIn("modelled_peak_hour", peak["arrival_profile"])
        # The peak is modelled from real daily ritasi, never called a documented count.
        self.assertIn("modelled", peak["arrival_profile"])
        self.assertNotIn("documented", peak["arrival_profile"])
        self.assertEqual(peak["classification"], "SIMULATED")
        # More trucks reach the gate in the modelled peak hour than the lanes clear.
        self.assertGreater(peak["utilization"], 1.0)
        self.assertGreater(peak["avg_wait_minutes"], 60, "the modelled peak hour is a bottleneck")
        self.assertEqual(peak["status_label"], "CRITICAL (Antrian Padat)")

    def test_live_scenario_shows_the_modelled_peak_hour_not_the_clock(self):
        live = tpa_queue_status_payload(scenario="live")
        peak = tpa_queue_status_payload(scenario="peak")
        self.assertEqual(live["scenario"], "live")
        self.assertIn("modelled_peak_hour", live["arrival_profile"])
        self.assertEqual(live["modelled_hour"], peak["modelled_hour"])
        self.assertEqual(live["avg_wait_minutes"], peak["avg_wait_minutes"])


if __name__ == "__main__":
    unittest.main()
