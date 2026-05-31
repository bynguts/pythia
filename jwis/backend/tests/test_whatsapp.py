import unittest

from app.whatsapp import OpenWAClient, build_alert_message


class WhatsAppTests(unittest.TestCase):
    def test_build_alert_message_contains_priority_context(self):
        message = build_alert_message(
            truck_code="T-047",
            issue="Route deviation 3448m from assigned corridor",
            recommendation="Use Route B - Daan Mogot Recovery",
        )

        self.assertIn("JWIS ALERT", message)
        self.assertIn("T-047", message)
        self.assertIn("Route B", message)

    def test_openwa_client_reports_unconfigured_without_network_call(self):
        client = OpenWAClient(base_url="", api_key="", session_id="")

        result = client.send_text(chat_id="628123456789@c.us", text="test")

        self.assertFalse(result["sent"])
        self.assertEqual(result["provider"], "openwa")
        self.assertIn("not configured", result["message"].lower())


if __name__ == "__main__":
    unittest.main()
