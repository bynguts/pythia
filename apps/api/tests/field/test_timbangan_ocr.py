import json
import os
import unittest
from unittest import mock

from app.field.timbangan_ocr import is_configured, read_weight_from_photo

PHOTO = "data:image/jpeg;base64,AA"
NO_KEYS = {"GUTS_API_KEY": "", "OPENAI_API_KEY": ""}


def _vision_response(weight):
    content = json.dumps({"weight_kg": weight})
    return {"choices": [{"message": {"content": content}}]}


def _content(content):
    return lambda **kw: {"choices": [{"message": {"content": content}}]}


FULL_TICKET = {
    "document": "weighbridge_ticket",
    "gross_kg": 18420,
    "tare_kg": 9210.5,
    "net_kg": 9209.5,
    "ticket_no": "  TB-000123 ",
    "plate": "B 1234 XYZ",
    "weighed_in_at": "2026-10-27 08:15",
    "weighed_out_at": "2026-10-27 08:41",
    "site": "TPST Contoh",
}


def _read(content, env=None):
    with mock.patch.dict(os.environ, {**NO_KEYS, "GUTS_API_KEY": "k", **(env or {})}):
        return read_weight_from_photo(PHOTO, http_post=_content(content))


class TimbanganOcrTests(unittest.TestCase):
    def test_success_high_confidence_sends_guts_vision_request(self):
        calls = []

        def post(**kwargs):
            calls.append(kwargs)
            return _vision_response(12340)

        with mock.patch.dict(
            os.environ,
            {
                "GUTS_API_KEY": "example-key",
                "GUTS_BASE_URL": "https://vision.example/v1/",
                "GUTS_VISION_MODEL": "gemini-3.8-flash",
                "OPENAI_API_KEY": "openai-key",
            },
        ):
            result = read_weight_from_photo(PHOTO, http_post=post)
        self.assertEqual(result["weight_kg"], 12340)
        self.assertEqual(result["gross_kg"], 12340)
        self.assertEqual(result["confidence"], "high")
        self.assertIn("gutsai-vision", result["source"])
        self.assertEqual(calls[0]["url"], "https://vision.example/v1/chat/completions")
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer example-key")
        self.assertEqual(calls[0]["json_body"]["model"], "gemini-3.8-flash")
        self.assertEqual(calls[0]["json_body"]["messages"][1]["content"][1]["image_url"]["url"], PHOTO)

    def test_openai_gateway_is_used_without_a_guts_key(self):
        calls = []

        def post(**kwargs):
            calls.append(kwargs)
            return _vision_response(12340)

        env = {
            **NO_KEYS,
            "OPENAI_API_KEY": "openai-key",
            "OPENAI_BASE_URL": "https://gateway.example/v1/",
            "OPENAI_MODEL": "chat-model",
            "OPENAI_VISION_MODEL": "ag",
        }
        with mock.patch.dict(os.environ, env):
            self.assertTrue(is_configured())
            result = read_weight_from_photo(PHOTO, http_post=post)
        self.assertEqual(result["weight_kg"], 12340)
        self.assertEqual(result["source"], "vision (ag)")
        self.assertEqual(calls[0]["url"], "https://gateway.example/v1/chat/completions")
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer openai-key")
        self.assertEqual(calls[0]["json_body"]["model"], "ag")
        # The gateway streams by default; the reader expects one JSON body.
        self.assertIs(calls[0]["json_body"]["stream"], False)

    def test_openai_model_is_the_fallback_vision_model(self):
        calls = []

        def post(**kwargs):
            calls.append(kwargs)
            return _vision_response(500)

        env = {**NO_KEYS, "OPENAI_API_KEY": "openai-key", "OPENAI_MODEL": "ag", "OPENAI_VISION_MODEL": ""}
        with mock.patch.dict(os.environ, env):
            result = read_weight_from_photo(PHOTO, http_post=post)
        self.assertEqual(calls[0]["json_body"]["model"], "ag")
        self.assertEqual(result["source"], "vision (ag)")

    def test_full_ticket_is_parsed_and_trimmed(self):
        result = _read("```json\n" + json.dumps(FULL_TICKET) + "\n```")
        self.assertEqual(result["document"], "weighbridge_ticket")
        self.assertEqual(result["weight_kg"], 18420)
        self.assertEqual(result["gross_kg"], 18420)
        self.assertEqual(result["tare_kg"], 9210.5)
        self.assertEqual(result["net_kg"], 9209.5)
        self.assertEqual(result["ticket_no"], "TB-000123")
        self.assertEqual(result["plate"], "B 1234 XYZ")
        self.assertEqual(result["weighed_in_at"], "2026-10-27 08:15")
        self.assertEqual(result["weighed_out_at"], "2026-10-27 08:41")
        self.assertEqual(result["site"], "TPST Contoh")
        self.assertEqual(result["confidence"], "high")

    def test_invalid_fields_become_null_without_failing_the_read(self):
        ticket = {
            **FULL_TICKET,
            "tare_kg": -5,
            "net_kg": 25000,  # more than the gross
            "plate": "X" * 200,
            "site": {"name": "nested"},
            "ticket_no": "   ",
        }
        result = _read(json.dumps(ticket))
        self.assertEqual(result["gross_kg"], 18420)
        self.assertIsNone(result["tare_kg"])
        self.assertIsNone(result["net_kg"])
        self.assertEqual(len(result["plate"]), 20)
        self.assertIsNone(result["site"])
        self.assertIsNone(result["ticket_no"])
        self.assertEqual(result["confidence"], "high")

    def test_tare_not_below_gross_is_null(self):
        result = _read(json.dumps({**FULL_TICKET, "tare_kg": 18420, "net_kg": None}))
        self.assertIsNone(result["tare_kg"])

    def test_partial_ticket_without_gross_is_low(self):
        ticket = {"document": "weighbridge_ticket", "gross_kg": None, "tare_kg": 9000, "ticket_no": "TB-9"}
        result = _read(json.dumps(ticket))
        self.assertIsNone(result["weight_kg"])
        self.assertEqual(result["tare_kg"], 9000)
        self.assertEqual(result["ticket_no"], "TB-9")
        self.assertEqual(result["confidence"], "low")

    def test_truncated_json_is_low_and_unreadable(self):
        result = _read('{"document": "weighbridge_ticket", "gross_kg": 18420, "tare')
        self.assertIsNone(result["weight_kg"])
        self.assertIsNone(result["tare_kg"])
        self.assertEqual(result["document"], "unreadable")
        self.assertEqual(result["confidence"], "low")

    def test_not_a_ticket_drops_every_reading(self):
        result = _read(json.dumps({**FULL_TICKET, "document": "not_a_ticket"}))
        self.assertEqual(result["document"], "not_a_ticket")
        for key in ("weight_kg", "gross_kg", "tare_kg", "net_kg", "ticket_no", "plate", "site"):
            self.assertIsNone(result[key], key)
        self.assertEqual(result["confidence"], "low")

    def test_unknown_document_type_is_not_passed_through(self):
        result = _read(json.dumps({**FULL_TICKET, "document": "receipt<script>"}))
        self.assertEqual(result["document"], "weighbridge_ticket")

    def test_out_of_range_is_low(self):
        with mock.patch.dict(os.environ, {**NO_KEYS, "GUTS_API_KEY": "k"}):
            result = read_weight_from_photo(PHOTO, http_post=lambda **kw: _vision_response(999999999))
        self.assertIsNone(result["weight_kg"])
        self.assertEqual(result["confidence"], "low")

    def test_null_reading_is_low(self):
        with mock.patch.dict(os.environ, {**NO_KEYS, "GUTS_API_KEY": "k"}):
            result = read_weight_from_photo(PHOTO, http_post=lambda **kw: _vision_response(None))
        self.assertIsNone(result["weight_kg"])
        self.assertEqual(result["confidence"], "low")

    def test_malformed_reading_is_low(self):
        result = _read("tidak terbaca sama sekali")
        self.assertIsNone(result["weight_kg"])
        self.assertEqual(result["document"], "unreadable")
        self.assertEqual(result["confidence"], "low")

    def test_boolean_is_not_a_weight(self):
        with mock.patch.dict(os.environ, {**NO_KEYS, "GUTS_API_KEY": "k"}):
            result = read_weight_from_photo(PHOTO, http_post=lambda **kw: _vision_response(True))
        self.assertIsNone(result["weight_kg"])

    def test_http_failure_is_failed(self):
        def boom(**kw):
            raise TimeoutError("timeout")

        with mock.patch.dict(os.environ, {**NO_KEYS, "GUTS_API_KEY": "k"}):
            result = read_weight_from_photo(PHOTO, http_post=boom)
        self.assertIsNone(result["weight_kg"])
        self.assertIsNone(result["tare_kg"])
        self.assertEqual(result["confidence"], "failed")

    def test_missing_api_key_does_not_call_provider(self):
        with mock.patch.dict(os.environ, NO_KEYS):
            self.assertFalse(is_configured())
            result = read_weight_from_photo(
                PHOTO,
                http_post=lambda **kw: self.fail("OCR must not call provider without a key"),
            )
        self.assertIsNone(result["weight_kg"])
        self.assertIsNone(result["gross_kg"])
        self.assertEqual(result["confidence"], "failed")
        self.assertIn("GUTS_API_KEY", result["raw_text"])
        self.assertIn("OPENAI_API_KEY", result["raw_text"])


if __name__ == "__main__":
    unittest.main()
