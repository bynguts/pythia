import unittest

from app.api.routers.whatsapp import normalize_group_jid, normalize_phone_number
from app.integrations.whatsapp import OpenWAClient, build_alert_message


class WhatsAppTests(unittest.TestCase):
    def test_build_alert_message_contains_priority_context(self):
        message = build_alert_message(
            truck_code="T-047",
            issue="Route deviation 3448m from assigned corridor",
            recommendation="Use Route B - Daan Mogot Recovery",
            lang="en",
        )

        self.assertIn("PYTHIA ALERT", message)
        self.assertIn("T-047", message)
        self.assertIn("Route B", message)

    def test_openwa_client_reports_unconfigured_without_network_call(self):
        client = OpenWAClient(base_url="", api_key="", session_id="")

        result = client.send_text(chat_id="628123456789@c.us", text="test")

        self.assertFalse(result["sent"])
        self.assertEqual(result["provider"], "openwa")
        self.assertIn("not configured", result["message"].lower())

    def test_qr_reports_unconfigured_without_network_call(self):
        client = OpenWAClient(base_url="", api_key="", session_id="")

        result = client.qr()

        self.assertFalse(result["configured"])
        self.assertEqual(result["state"], "unconfigured")
        self.assertIsNone(result["qr"])

    def test_logout_reports_unconfigured_without_network_call(self):
        client = OpenWAClient(base_url="", api_key="", session_id="")

        result = client.logout()

        self.assertFalse(result["configured"])
        self.assertFalse(result["logged_out"])
        self.assertIn("not configured", result["message"].lower())

    def test_normalize_phone_number_local_format(self):
        self.assertEqual(normalize_phone_number("081234567890"), "6281234567890@c.us")

    def test_normalize_phone_number_international_format(self):
        self.assertEqual(normalize_phone_number("6281234567890"), "6281234567890@c.us")
        self.assertEqual(normalize_phone_number("+62812-3456-7890"), "6281234567890@c.us")

    def test_normalize_phone_number_full_jid_unchanged(self):
        self.assertEqual(normalize_phone_number("6281234567890@c.us"), "6281234567890@c.us")

    def test_normalize_group_jid_phone_input(self):
        self.assertEqual(normalize_group_jid("081234567890"), "6281234567890@g.us")

    def test_normalize_group_jid_full_jid_unchanged(self):
        self.assertEqual(
            normalize_group_jid("6281234567890-1620000000@g.us"), "6281234567890-1620000000@g.us"
        )

    def test_normalize_phone_number_empty(self):
        self.assertEqual(normalize_phone_number(""), "")
        self.assertEqual(normalize_phone_number("   "), "")


if __name__ == "__main__":
    unittest.main()


def test_group_listing_waits_longer_than_the_short_gateway_timeout(monkeypatch):
    # The first listing after pairing waits for WhatsApp; a 3 s timeout made the picker empty.
    import io

    from app.integrations import whatsapp

    seen = {}

    def fake_urlopen(url, timeout):
        seen["timeout"] = timeout
        return io.BytesIO(b'{"connected": true, "groups": [{"jid": "1@g.us", "subject": "Drivers"}]}')

    monkeypatch.setattr(whatsapp, "urlopen", fake_urlopen)
    client = OpenWAClient(base_url="http://127.0.0.1:2785/api", session_id="default", timeout_seconds=3)
    result = client.groups()
    assert seen["timeout"] >= whatsapp.GROUPS_TIMEOUT_SECONDS
    assert result["groups"] == [{"jid": "1@g.us", "subject": "Drivers"}]


def test_every_gateway_call_carries_the_api_key(monkeypatch):
    # The gateway refuses every route but /health without X-API-Key once OPENWA_API_KEY is set.
    import io

    from app.integrations import whatsapp

    seen = {}

    def fake_urlopen(request, timeout):
        seen[request.full_url.rsplit("/", 1)[-1]] = request.get_header("X-api-key")
        return io.BytesIO(b"{}")

    monkeypatch.setattr(whatsapp, "urlopen", fake_urlopen)
    client = OpenWAClient(base_url="http://127.0.0.1:2785/api", api_key="k-test", session_id="default")
    client.health()
    client.qr()
    client.groups()
    client.logout()
    client.send_text("6281234567890@c.us", "hi")
    assert seen == {key: "k-test" for key in ("health", "qr", "groups", "logout", "send-text")}
