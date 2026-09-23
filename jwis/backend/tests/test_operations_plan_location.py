"""Event location must reach the operations plan (issue #16).

`PlanningDecisionFlow` sent `event_lat`/`event_lng` to `/api/operations/plan`,
the endpoint neither declared nor forwarded them, and two distant event sites
therefore produced an identical plan.
"""
import unittest

from fastapi.testclient import TestClient

from app.main import app


class OperationsPlanLocationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "administrator", "password": "administrator-demo-pass"})
        self.client.headers.update(
            {"Authorization": f"Bearer {login.json()['token']}"})

    def _plan(self, **params):
        res = self.client.post("/api/operations/plan", params=params)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def test_plan_records_the_full_normalized_scenario(self):
        plan = self._plan(rainfall_mm=42, event_attendance=50000, is_weekend="true",
                          event_lat=-6.1754, event_lng=106.8272, top_n=5)
        scenario = plan["scenario"]
        self.assertEqual(scenario["event_lat"], -6.1754)
        self.assertEqual(scenario["event_lng"], 106.8272)
        self.assertEqual(scenario["event_attendance"], 50000)
        self.assertEqual(scenario["top_n"], 5)
        # The event is localized to the districts around Monas ...
        self.assertIn("gambir", scenario["targeted_kecamatan"])
        # ... which is reported separately from the plan's top demand areas:
        # targeting says where the crowd is, top_kecamatan says where the
        # optimizer put the fleet. Conflating them was the old behaviour.
        self.assertEqual(len(scenario["top_kecamatan"]), 5)
        self.assertTrue({a["area"] for a in plan["assignments"]}
                        <= set(scenario["top_kecamatan"]),
                        "assignments must come from the plan's demand areas")
        self.assertNotEqual(scenario["top_kecamatan"],
                            scenario["targeted_kecamatan"])
        self.assertIn("total_predicted_tons", scenario)

    def test_distant_event_locations_produce_different_plans(self):
        north = self._plan(event_attendance=50000, event_lat=-6.1200,
                           event_lng=106.8900)  # Cilincing side
        south = self._plan(event_attendance=50000, event_lat=-6.2900,
                           event_lng=106.7900)  # Cilandak side
        self.assertNotEqual(north["scenario"]["targeted_kecamatan"],
                            south["scenario"]["targeted_kecamatan"])
        self.assertNotEqual(
            [(a["area"], a["assigned_tons"]) for a in north["assignments"]],
            [(a["area"], a["assigned_tons"]) for a in south["assignments"]])

    def test_without_attendance_the_location_does_not_move_demand(self):
        """A location with no crowd attached must not fabricate demand."""
        plain = self._plan(event_attendance=0)
        located = self._plan(event_attendance=0, event_lat=-6.1754,
                             event_lng=106.8272)
        self.assertEqual(plain["scenario"]["targeted_kecamatan"], [])
        self.assertEqual(located["scenario"]["targeted_kecamatan"], [])
        self.assertEqual(plain["total_demand_tons"], located["total_demand_tons"])

    def test_coordinates_are_validated(self):
        bad = self.client.post("/api/operations/plan",
                               params={"event_lat": -95.0, "event_lng": 200.0})
        self.assertEqual(bad.status_code, 422)


if __name__ == "__main__":
    unittest.main()
