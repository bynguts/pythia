"""R9: nothing personal leaves the server for an external LLM provider."""

from __future__ import annotations

import json
from unittest import mock

from app.assistant import assistant as assistant_module
from app.assistant import pii
from app.core import paths
from app.field.privacy import NAME_PLACEHOLDER, PHONE_PLACEHOLDER, PLATE_PLACEHOLDER, scrub_pii


def test_scrub_replaces_phones_plates_and_names():
    text = (
        "Hubungi Budi Santoso di +62 812-3456-7890 atau 081234567890 "
        "(WA 6281234567890@c.us), truk B 1234 CD dan B9876XYZ, unit T-088."
    )
    out = scrub_pii(text, ["Budi Santoso"])
    for leaked in ("Budi", "3456", "081234567890", "6281234567890", "B 1234 CD", "B9876XYZ"):
        assert leaked not in out
    assert NAME_PLACEHOLDER in out and PHONE_PLACEHOLDER in out and PLATE_PLACEHOLDER in out
    assert "T-088" in out  # fleet codes are not personal data


def test_known_names_come_from_contacts_and_users_file(tmp_path, monkeypatch):
    contacts = tmp_path / "driver_contacts.json"
    contacts.write_text(json.dumps({"drivers": {"Siti Contoh": "6281200000000@c.us"}}), encoding="utf-8")
    monkeypatch.setattr(paths, "DRIVER_CONTACTS_FILE", contacts)
    monkeypatch.setattr(pii, "load_users", lambda: {"u": {"display_name": "Andi Contoh"}})
    assert set(pii.known_person_names()) == {"Siti Contoh", "Andi Contoh"}


def test_gateway_request_is_scrubbed(tmp_path, monkeypatch):
    contacts = tmp_path / "driver_contacts.json"
    contacts.write_text(json.dumps({"drivers": {"Siti Contoh": "6281200000000@c.us"}}), encoding="utf-8")
    monkeypatch.setattr(paths, "DRIVER_CONTACTS_FILE", contacts)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    sent: list[dict] = []

    class _Response:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(request, timeout):
        sent.append(json.loads(request.data.decode("utf-8")))
        body = {"model": "m", "choices": [{"message": {"role": "assistant", "content": "ok"}}]}
        return _Response(json.dumps(body).encode("utf-8"))

    with mock.patch.object(assistant_module, "urlopen", fake_urlopen):
        assistant_module.answer_with_openai_if_configured(
            "Kenapa Siti Contoh (0812-0000-0000, B 4321 XY) belum sampai?",
            {},
            history=[{"role": "user", "content": "nomor saya 081299990000"}],
        )
    assert sent, "the gateway was not called"
    wire = json.dumps(sent[0], ensure_ascii=False)
    for leaked in ("Siti Contoh", "0812-0000-0000", "081299990000", "B 4321 XY"):
        assert leaked not in wire
    assert NAME_PLACEHOLDER in wire
