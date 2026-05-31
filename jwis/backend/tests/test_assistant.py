import unittest

from app.assistant import answer_operational_question, build_executive_summary


class AssistantTests(unittest.TestCase):
    def test_answer_operational_question_uses_snapshot_numbers(self):
        snapshot = {
            "kpis": {"active_trucks": 5, "trucks_with_issues": 2, "tpa_wait_minutes": 116},
            "critical_predictions": [{"district": "Jakarta Barat", "spike_percent": 41}],
            "alerts": [{"truck_code": "T-047", "title": "Route deviation"}],
        }

        answer = answer_operational_question("apa masalah terbesar hari ini?", snapshot)

        self.assertIn("Jakarta Barat", answer)
        self.assertIn("T-047", answer)
        self.assertIn("116", answer)

    def test_build_executive_summary_is_concise_and_actionable(self):
        snapshot = {
            "kpis": {"active_trucks": 5, "trucks_with_issues": 2, "tpa_wait_minutes": 116},
            "critical_predictions": [{"district": "Jakarta Barat", "spike_percent": 41, "recommended_extra_trucks": 29}],
            "alerts": [{"truck_code": "T-047", "title": "Route deviation"}],
        }

        summary = build_executive_summary(snapshot)

        self.assertLessEqual(len(summary.split()), 150)
        self.assertIn("29", summary)
        self.assertIn("T-047", summary)


if __name__ == "__main__":
    unittest.main()
