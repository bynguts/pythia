"""Driver contacts never come from the repo: no real numbers, local file only."""

import json
import re
from pathlib import Path

import pytest

from app.api import schemas
from app.api.routers import whatsapp as wa_router
from app.core.paths import API_DIR, DRIVER_CONTACTS_EXAMPLE_FILE
from app.integrations.whatsapp import PLACEHOLDER_CHAT_ID, PLACEHOLDER_GROUP_ID


@pytest.fixture()
def contacts_file(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "driver_contacts.json"
    monkeypatch.setattr(wa_router, "CONTACTS_FILE", path)
    monkeypatch.delenv("PYTHIA_WA_DEFAULT_CHAT_ID", raising=False)
    monkeypatch.delenv("PYTHIA_WA_DEFAULT_GROUP_ID", raising=False)
    return path


def test_contacts_file_lives_next_to_the_api_not_the_cwd():
    assert wa_router.CONTACTS_FILE == API_DIR / "driver_contacts.json"


def test_missing_file_serves_placeholders_without_writing(contacts_file):
    data = wa_router.load_contacts()
    assert data["drivers"], "example driver names keep the shrink guard meaningful"
    assert set(data["drivers"].values()) == {PLACEHOLDER_CHAT_ID}
    assert data["group_jid"] == PLACEHOLDER_GROUP_ID
    assert not contacts_file.exists()


def test_missing_example_file_degrades_to_empty_drivers(contacts_file, tmp_path, monkeypatch):
    monkeypatch.setattr(wa_router, "EXAMPLE_CONTACTS_FILE", tmp_path / "absent.json")
    data = wa_router.load_contacts()
    assert data["drivers"] == {}
    assert data["group_jid"] == PLACEHOLDER_GROUP_ID


def test_env_defaults_replace_placeholders(contacts_file, monkeypatch):
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_CHAT_ID", "6280000000001@c.us")
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_GROUP_ID", "6280000000001-1600000000@g.us")
    data = wa_router.load_contacts()
    assert set(data["drivers"].values()) == {"6280000000001@c.us"}
    assert data["group_jid"] == "6280000000001-1600000000@g.us"
    request = schemas.WhatsAppAlertRequest(truck_code="T-001", issue="i", recommendation="r")
    assert request.chat_id == "6280000000001@c.us"


def test_alert_request_defaults_to_placeholder_chat(contacts_file):
    request = schemas.WhatsAppAlertRequest(truck_code="T-001", issue="i", recommendation="r")
    assert request.chat_id == PLACEHOLDER_CHAT_ID


def test_save_writes_the_local_file(contacts_file):
    contacts_file.write_text('{"drivers": {}}', encoding="utf-8")
    wa_router.save_contacts({"drivers": {"A": "081234567890"}, "group_jid": "", "send_to_group": False})
    stored = json.loads(contacts_file.read_text(encoding="utf-8"))
    assert stored["drivers"] == {"A": "6281234567890@c.us"}
    assert wa_router.load_contacts()["drivers"] == {"A": "6281234567890@c.us"}


def test_example_file_holds_only_placeholder_numbers():
    text = DRIVER_CONTACTS_EXAMPLE_FILE.read_text(encoding="utf-8")
    numbers = set(re.findall(r"\d{9,}", text))
    assert numbers <= {"6281234567890", "1620000000"}


def test_reading_contacts_requires_admin(api_client, auth_headers, contacts_file):
    # The list maps driver names to phone numbers; it is not public.
    assert api_client.get("/api/whatsapp/contacts").status_code == 401
    assert api_client.get("/api/whatsapp/contacts", headers=auth_headers("driver")).status_code == 403
    resp = api_client.get("/api/whatsapp/contacts", headers=auth_headers("administrator"))
    assert resp.status_code == 200
    assert "drivers" in resp.json()


def test_unmatched_driver_name_falls_back_and_is_logged_once(contacts_file, monkeypatch, caplog):
    # Contact keys must be the fleet's driver names ("Pengemudi Sim NN").
    monkeypatch.setattr(wa_router, "_UNMATCHED_DRIVERS_LOGGED", set())
    config = {"drivers": {"Pengemudi Sim 01": "6281234567890@c.us"}}
    with caplog.at_level("WARNING", logger=wa_router.logger.name):
        assert wa_router.driver_chat_id(config, "Pengemudi Sim 01") == "6281234567890@c.us"
        assert wa_router.driver_chat_id(config, "Budi") == PLACEHOLDER_CHAT_ID
        assert wa_router.driver_chat_id(config, "Budi") == PLACEHOLDER_CHAT_ID
    unmatched = [r for r in caplog.records if "Budi" in r.getMessage()]
    assert len(unmatched) == 1
    assert "Pengemudi Sim 01" in unmatched[0].getMessage()


def test_example_contact_keys_match_the_fleet_driver_names():
    from app.fleet.data import _CURATED_DRIVERS

    example = json.loads(DRIVER_CONTACTS_EXAMPLE_FILE.read_text(encoding="utf-8"))
    assert set(example["drivers"]) <= set(_CURATED_DRIVERS.values())
