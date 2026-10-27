"""Settings: the WhatsApp connection screen's API (status, alert group, test send)."""

import json
import re
from pathlib import Path

import pytest

from app.api.routers import whatsapp as wa_router
from app.api.state import history_store
from app.integrations.whatsapp import PLACEHOLDER_GROUP_ID, OpenWAClient

GROUP = "120363000000000042@g.us"


@pytest.fixture()
def contacts_file(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "driver_contacts.json"
    monkeypatch.setattr(wa_router, "CONTACTS_FILE", path)
    monkeypatch.delenv("PYTHIA_WA_DEFAULT_CHAT_ID", raising=False)
    monkeypatch.delenv("PYTHIA_WA_DEFAULT_GROUP_ID", raising=False)
    return path


@pytest.fixture()
def gateway(monkeypatch):
    """A fake gateway: tests set `health` / `groups` and read the texts it was asked to send."""
    fake = {"health": {"connected": False}, "groups": [], "sent": []}
    monkeypatch.setattr(OpenWAClient, "health", lambda self: dict(fake["health"]))
    monkeypatch.setattr(
        OpenWAClient,
        "groups",
        lambda self: {"connected": True, "groups": [dict(g) for g in fake["groups"]], "message": ""},
    )

    def send_text(self, chat_id, text):
        fake["sent"].append((chat_id, text))
        return {"sent": True, "message": "WhatsApp message sent."}

    monkeypatch.setattr(OpenWAClient, "send_text", send_text)
    return fake


@pytest.mark.parametrize(
    ("path", "body"),
    [("/api/whatsapp/alert-group", {"group_jid": GROUP}), ("/api/whatsapp/test", None)],
)
def test_changing_whatsapp_settings_is_for_the_dispatcher_and_administrator(
    api_client, auth_headers, contacts_file, gateway, path, body
):
    assert api_client.post(path, json=body).status_code == 401
    for role in ("driver", "supervisor"):
        assert api_client.post(path, json=body, headers=auth_headers(role)).status_code == 403, role
    assert gateway["sent"] == []


def test_a_dispatcher_picks_the_alert_group_and_sends_a_test(
    api_client, auth_headers, contacts_file, gateway
):
    headers = auth_headers("dispatcher")
    res = api_client.post("/api/whatsapp/alert-group", json={"group_jid": GROUP}, headers=headers)
    assert res.status_code == 200, res.text
    assert json.loads(contacts_file.read_text(encoding="utf-8"))["group_jid"] == GROUP
    res = api_client.post("/api/whatsapp/test", headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["sent"] is True
    assert [chat for chat, _text in gateway["sent"]] == [GROUP]


@pytest.mark.parametrize(
    ("health", "expected"),
    [
        ({"connected": True, "state": "open"}, "connected"),
        ({"connected": False, "state": "qr"}, "pairing"),
        ({"connected": False, "state": "starting"}, "starting"),
        ({"connected": False, "state": "closed"}, "starting"),
        # The client's exception branch: no `state` because the gateway never answered.
        ({"connected": False, "message": "WhatsApp gateway is offline: refused"}, "offline"),
    ],
)
def test_status_reports_one_link_state(api_client, auth_headers, contacts_file, gateway, health, expected):
    gateway["health"] = health
    body = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert body["link_state"] == expected


def test_link_state_is_unconfigured_without_a_gateway_url():
    assert wa_router.link_state(False, {"connected": True}) == "unconfigured"


def test_linked_account_is_masked_without_the_device_suffix(api_client, auth_headers, contacts_file, gateway):
    gateway["health"] = {"connected": True, "state": "open", "me": "6281234567890:12@s.whatsapp.net"}
    body = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert body["linked_account"] == "62812****7890@s.whatsapp.net"
    gateway["health"] = {"connected": True, "state": "open"}
    body = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()
    assert body["linked_account"] is None


def test_alert_group_source_follows_the_alert_route_precedence(
    api_client, auth_headers, contacts_file, gateway, monkeypatch
):
    def group():
        return api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher")).json()[
            "alert_group"
        ]

    assert group()["source"] == "placeholder"
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_GROUP_ID", "6280000000001-1600000000@g.us")
    assert group()["source"] == "env"
    assert not re.search(r"\d{9,}", group()["jid"])
    contacts_file.write_text(json.dumps({"drivers": {}, "group_jid": GROUP}), encoding="utf-8")
    assert group() == {"jid": "12036****0042@g.us", "source": "contacts_file"}


def test_choosing_the_alert_group_persists_it_and_keeps_the_drivers(
    api_client, auth_headers, contacts_file, gateway
):
    contacts_file.write_text(
        json.dumps({"drivers": {"Pengemudi Sim 01": "6281234567890@c.us"}, "group_jid": ""}), encoding="utf-8"
    )
    res = api_client.post(
        "/api/whatsapp/alert-group", json={"group_jid": GROUP}, headers=auth_headers("administrator")
    )
    assert res.status_code == 200, res.text
    assert res.json()["alert_group"]["source"] == "contacts_file"
    stored = json.loads(contacts_file.read_text(encoding="utf-8"))
    assert stored["group_jid"] == GROUP
    assert stored["drivers"] == {"Pengemudi Sim 01": "6281234567890@c.us"}
    # The alert route reads the same choice.
    assert wa_router.alert_group() == (GROUP, "contacts_file")
    event = next(e for e in history_store.list_events(limit=20) if e["event_type"] == "whatsapp_alert_group")
    assert event["payload"]["actor"] == "administrator"
    assert not re.search(r"\d{9,}", event["payload"]["recipient"])


def test_choosing_a_group_without_a_contacts_file_writes_no_driver_numbers(
    api_client, auth_headers, contacts_file, gateway
):
    res = api_client.post(
        "/api/whatsapp/alert-group", json={"group_jid": GROUP}, headers=auth_headers("administrator")
    )
    assert res.status_code == 200, res.text
    stored = json.loads(contacts_file.read_text(encoding="utf-8"))
    assert stored["group_jid"] == GROUP
    assert "drivers" not in stored


@pytest.mark.parametrize("jid", ["6281234567890@c.us", "not-a-group", "", "6281234567890@g.us; rm"])
def test_alert_group_must_be_a_group_jid(api_client, auth_headers, contacts_file, gateway, jid):
    res = api_client.post(
        "/api/whatsapp/alert-group", json={"group_jid": jid}, headers=auth_headers("administrator")
    )
    assert res.status_code == 422
    assert not contacts_file.exists()


def test_groups_mark_the_current_alert_group(api_client, auth_headers, contacts_file, gateway):
    contacts_file.write_text(json.dumps({"group_jid": GROUP}), encoding="utf-8")
    gateway["groups"] = [
        {"jid": "120363000000000001@g.us", "subject": "Posko Utara"},
        {"jid": GROUP, "subject": "Pythia Ops"},
    ]
    body = api_client.get("/api/whatsapp/groups", headers=auth_headers("administrator")).json()
    assert [g["selected"] for g in body["groups"]] == [False, True]


def test_test_message_refuses_the_placeholder_group(api_client, auth_headers, contacts_file, gateway):
    res = api_client.post("/api/whatsapp/test", headers=auth_headers("administrator"))
    assert res.status_code == 409
    assert gateway["sent"] == []
    assert wa_router.alert_group() == (PLACEHOLDER_GROUP_ID, "placeholder")


def test_test_message_goes_to_the_alert_group_only(api_client, auth_headers, contacts_file, gateway):
    contacts_file.write_text(
        json.dumps({"drivers": {"Pengemudi Sim 01": "6289999999999@c.us"}, "group_jid": GROUP}),
        encoding="utf-8",
    )
    res = api_client.post("/api/whatsapp/test", headers=auth_headers("administrator"))
    assert res.status_code == 200, res.text
    assert res.json() == {"sent": True, "recipient": "12036****0042@g.us"}
    assert gateway["sent"] == [(GROUP, wa_router.wa_text("test"))]
    event = next(e for e in history_store.list_events(limit=20) if e["event_type"] == "whatsapp_test")
    assert event["payload"]["sent"] is True
    assert not re.search(r"\d{9,}", event["payload"]["recipient"])


def test_gateway_account_is_masked_end_to_end(api_client, auth_headers, contacts_file, monkeypatch):
    # The real client parsing a gateway /api/health body: the raw `me` never leaves the API.
    from app.integrations import whatsapp as wa_client

    class Body:
        def __init__(self, payload):
            self.payload = json.dumps(payload).encode()

        def read(self):
            return self.payload

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    health = {"connected": True, "state": "open", "me": "6281234567890:12@s.whatsapp.net"}
    monkeypatch.setattr(wa_client, "urlopen", lambda url, timeout: Body(health))
    res = api_client.get("/api/whatsapp/status", headers=auth_headers("dispatcher"))
    assert res.status_code == 200
    assert res.json()["linked_account"] == "62812****7890@s.whatsapp.net"
    assert "6281234567890" not in res.text


def _choose_group(contacts_file: Path) -> None:
    contacts_file.write_text(json.dumps({"drivers": {}, "group_jid": GROUP}), encoding="utf-8")


def test_summary_goes_to_the_alert_group_and_logs_no_text(api_client, auth_headers, contacts_file, gateway):
    _choose_group(contacts_file)
    text = "26 Oct: 61 trips, 486 t weighed. Call 6281234567890 for details."
    assert api_client.post("/api/whatsapp/summary", json={"text": text}).status_code == 401
    denied = api_client.post("/api/whatsapp/summary", json={"text": text}, headers=auth_headers("driver"))
    assert denied.status_code == 403
    res = api_client.post(
        "/api/whatsapp/summary", json={"text": text, "lang": "en"}, headers=auth_headers("dispatcher")
    )
    assert res.status_code == 200, res.text
    assert res.json()["sent"] is True and res.json()["recipient"] == "12036****0042@g.us"
    ((chat, sent_text),) = gateway["sent"]
    assert chat == GROUP and "486 t" in sent_text and "6281234567890" not in sent_text
    event = next(e for e in history_store.list_events(limit=20) if e["event_type"] == "whatsapp_summary")
    assert "486" not in json.dumps(event["payload"]) and event["payload"]["chars"] == len(sent_text)


def test_summary_refuses_the_placeholder_group(api_client, auth_headers, contacts_file, gateway):
    res = api_client.post("/api/whatsapp/summary", json={"text": "x"}, headers=auth_headers("dispatcher"))
    assert res.status_code == 409 and gateway["sent"] == []


def test_summary_is_503_when_the_gateway_does_not_deliver(
    api_client, auth_headers, contacts_file, monkeypatch
):
    _choose_group(contacts_file)
    monkeypatch.setattr(
        OpenWAClient, "send_text", lambda self, chat, text: {"sent": False, "message": "down"}
    )
    res = api_client.post("/api/whatsapp/summary", json={"text": "x"}, headers=auth_headers("supervisor"))
    assert res.status_code == 503
