"""One-driver messages, escalations and the routing rule behind them.

A message for one truck reaches only that truck's driver: the app inbox, plus a private
WhatsApp when the contact registry has a real number. Never the alert group.
"""

from __future__ import annotations

import json

import pytest

from app.api.routers import whatsapp as wa_router
from app.api.state import history_store
from app.field import driver_messages as dm
from app.field import needs_you as feed
from app.integrations.whatsapp import PLACEHOLDER_CHAT_ID, OpenWAClient

DRIVER_JID = "6281200000047@c.us"  # placeholder-style test number, not a real person
GROUP_JID = "6281200000000-1620000000@g.us"


@pytest.fixture(autouse=True)
def _no_local_contacts(tmp_path, monkeypatch):
    """Never the machine's own (git-ignored) contacts file: each test sets the registry it needs."""
    monkeypatch.setattr(wa_router, "CONTACTS_FILE", tmp_path / "absent.json")


@pytest.fixture()
def contacts(tmp_path, monkeypatch):
    """A contacts file where T-047's driver (Pengemudi Sim 02) has a private chat."""
    path = tmp_path / "driver_contacts.json"

    def write(drivers, **extra):
        path.write_text(
            json.dumps(
                {
                    "group_jid": GROUP_JID,
                    "send_to_group": True,
                    "send_to_driver": True,
                    "drivers": drivers,
                    **extra,
                }
            ),
            encoding="utf-8",
        )

    monkeypatch.setattr(wa_router, "CONTACTS_FILE", path)
    write({"Pengemudi Sim 02": DRIVER_JID})
    return write


@pytest.fixture(autouse=True)
def sent(monkeypatch):
    """Every WhatsApp send, captured instead of reaching a gateway."""
    calls: list[tuple[str, str]] = []

    def fake_send(self, chat_id, text):
        calls.append((chat_id, text))
        return {"sent": True}

    monkeypatch.setattr(OpenWAClient, "send_text", fake_send)
    return calls


# ---- the routing rule ---------------------------------------------------------


def test_without_a_contacts_file_a_driver_gets_the_app_inbox_only():
    assert dm.delivery_channels({"type": "driver", "truck_code": "T-047"}) == [{"channel": "in_app"}]


def test_a_driver_with_a_contact_also_gets_a_private_chat_never_the_group(contacts):
    channels = dm.delivery_channels({"type": "driver", "truck_code": "T-047"})
    assert channels == [{"channel": "in_app"}, {"channel": "whatsapp_private", "chat_id": DRIVER_JID}]
    assert all(c.get("chat_id") != GROUP_JID for c in channels)


def test_another_truck_does_not_borrow_that_contact(contacts):
    # T-088's driver has no entry: no fallback to the default chat or the group.
    assert dm.channel_names({"type": "driver", "truck_code": "T-088"}) == ["in_app"]


@pytest.mark.parametrize(
    ("drivers", "extra"),
    [
        ({"Pengemudi Sim 02": PLACEHOLDER_CHAT_ID}, {}),
        ({"Pengemudi Sim 02": DRIVER_JID}, {"send_to_driver": False}),
    ],
)
def test_a_placeholder_or_disabled_driver_delivery_is_no_private_chat(contacts, drivers, extra):
    contacts(drivers, **extra)
    assert dm.private_chat_id("T-047") is None


def test_a_group_id_typed_as_a_driver_contact_never_reaches_the_group(contacts):
    contacts({"Pengemudi Sim 02": GROUP_JID})
    assert dm.private_chat_id("T-047") is None


SHARED_JID = "6281299999999@c.us"  # a configured default chat (placeholder-style test number)


def test_a_malformed_contacts_file_never_falls_back_to_the_default_chat(tmp_path, monkeypatch):
    # load_contacts() serves every driver mapped to the default chat for such a file.
    path = tmp_path / "driver_contacts.json"
    path.write_text("{ not json", encoding="utf-8")
    monkeypatch.setattr(wa_router, "CONTACTS_FILE", path)
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_CHAT_ID", SHARED_JID)
    assert set(wa_router.load_contacts()["drivers"].values()) <= {SHARED_JID}
    assert dm.private_chat_id("T-047") is None
    assert dm.channel_names({"type": "driver", "truck_code": "T-047"}) == ["in_app"]


def test_a_driver_mapped_to_the_shared_default_chat_has_no_private_chat(contacts, monkeypatch):
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_CHAT_ID", SHARED_JID)
    contacts({"Pengemudi Sim 02": "+62 812-9999-9999"})
    assert dm.private_chat_id("T-047") is None


def test_a_fleet_wide_alert_goes_to_the_group_only(contacts):
    assert dm.delivery_channels({"type": "fleet"}) == [{"channel": "whatsapp_group", "chat_id": GROUP_JID}]


def test_an_escalation_goes_to_the_console_queue_only():
    assert dm.delivery_channels({"type": "supervisor"}) == [{"channel": "console_inbox"}]


def test_an_unknown_recipient_type_is_an_error():
    with pytest.raises(ValueError):
        dm.delivery_channels({"type": "everyone"})


# ---- POST /api/driver/messages -------------------------------------------------


def test_a_message_lands_in_that_drivers_inbox_and_private_chat(api_client, auth_headers, contacts, sent):
    response = api_client.post(
        "/api/driver/messages",
        json={"truck_code": "T-047", "text": "Tunggu di gerbang 10 menit.", "source": "assistant"},
        headers=auth_headers("dispatcher"),
    )
    assert response.status_code == 201
    body = response.json()
    dispatch = body["dispatch"]
    assert dispatch["truck_code"] == "T-047" and dispatch["instruction"] == "Tunggu di gerbang 10 menit."
    assert [p["id"] for p in history_store.pending_dispatches("T-047")].count(dispatch["id"]) == 1
    assert sent == [(DRIVER_JID, "Pythia · T-047\nTunggu di gerbang 10 menit.")]
    statuses = {c["channel"]: c["status"] for c in body["channels"]}
    assert statuses == {"in_app": "inbox", "whatsapp_private": "sent"}
    # The response and the audit log carry the number masked, never in full.
    assert DRIVER_JID not in response.text
    audit = next(e for e in history_store.list_events(limit=50) if e["event_type"] == "driver_message")
    assert audit["payload"]["dispatch_id"] == dispatch["id"]
    assert audit["payload"]["approved_by"] == "dispatcher"
    # Where the client says it came from is kept as a hint, not as proof.
    assert audit["payload"]["client_hints"] == {"source": "assistant", "proposal_id": None}
    assert DRIVER_JID not in json.dumps(audit["payload"])


def test_without_a_contact_the_message_still_reaches_the_app(api_client, auth_headers, contacts, sent):
    response = api_client.post(
        "/api/driver/messages",
        json={
            "truck_code": "T-088",
            "text": "Cek muatan.",
            "kind": "instruction",
            "instruction_kind": "general",
        },
        headers=auth_headers("supervisor"),
    )
    assert response.status_code == 201
    assert {c["channel"]: c["status"] for c in response.json()["channels"]} == {
        "in_app": "inbox",
        "whatsapp_private": "no_contact",
    }
    assert sent == []


def test_the_channel_preview_names_channels_without_numbers(api_client, auth_headers, contacts):
    response = api_client.get("/api/driver/messages/channels/T-047", headers=auth_headers("dispatcher"))
    assert response.json() == {"truck_code": "T-047", "channels": ["in_app", "whatsapp_private"]}


@pytest.mark.parametrize(
    ("payload", "status"),
    [
        ({"truck_code": "T-9999", "text": "Halo"}, 404),
        ({"truck_code": "T-047", "text": "   "}, 422),
        ({"truck_code": "T-047", "text": "a" * 501}, 422),
        ({"truck_code": "T-047", "text": "Halo", "kind": "broadcast"}, 422),
    ],
)
def test_an_invalid_message_is_refused(api_client, auth_headers, payload, status, sent):
    response = api_client.post("/api/driver/messages", json=payload, headers=auth_headers("dispatcher"))
    assert response.status_code == status
    assert sent == []


def test_a_driver_account_cannot_send_messages(api_client, auth_headers):
    response = api_client.post(
        "/api/driver/messages", json={"truck_code": "T-047", "text": "x"}, headers=auth_headers("driver")
    )
    assert response.status_code == 403
    assert (
        api_client.post("/api/driver/messages", json={"truck_code": "T-047", "text": "x"}).status_code == 401
    )


def _pending_ids(truck):
    return [p["id"] for p in history_store.pending_dispatches(truck)]


def test_a_retry_with_the_same_operation_id_messages_the_driver_once(
    api_client, auth_headers, contacts, sent
):
    request = {
        "json": {"truck_code": "T-047", "text": "Ambil rute B."},
        "headers": {**auth_headers("dispatcher"), "X-Operation-Id": "op-retry-0001"},
    }
    first = api_client.post("/api/driver/messages", **request)
    again = api_client.post("/api/driver/messages", **request)
    assert first.status_code == again.status_code == 201
    dispatch_id = first.json()["dispatch"]["id"]
    assert again.json()["dispatch"]["id"] == dispatch_id and again.json()["replayed"] is True
    assert "replayed" not in first.json()
    assert len(sent) == 1
    assert _pending_ids("T-047").count(dispatch_id) == 1
    # A new operation id is a new message.
    other = api_client.post(
        "/api/driver/messages",
        json={"truck_code": "T-047", "text": "Ambil rute B."},
        headers={**auth_headers("dispatcher"), "X-Operation-Id": "op-retry-0002"},
    )
    assert other.json()["dispatch"]["id"] != dispatch_id and len(sent) == 2


def test_one_ana_proposal_is_sent_once_even_without_an_operation_id(api_client, auth_headers, sent):
    body = {"truck_code": "T-088", "text": "Cek muatan.", "source": "assistant", "proposal_id": "prop-once-1"}
    first = api_client.post("/api/driver/messages", json=body, headers=auth_headers("dispatcher"))
    again = api_client.post("/api/driver/messages", json=body, headers=auth_headers("supervisor"))
    assert again.json()["replayed"] is True
    assert again.json()["dispatch"]["id"] == first.json()["dispatch"]["id"]
    assert _pending_ids("T-088").count(first.json()["dispatch"]["id"]) == 1
    # The same id for another truck is not that proposal: it is sent.
    elsewhere = api_client.post(
        "/api/driver/messages", json={**body, "truck_code": "T-047"}, headers=auth_headers("dispatcher")
    )
    assert "replayed" not in elsewhere.json()


def test_a_send_in_flight_answers_409_and_a_failed_one_may_retry(api_client, auth_headers, monkeypatch, sent):
    def boom(*args):
        raise RuntimeError("store down")

    monkeypatch.setattr(dm, "_deliver", boom)
    with pytest.raises(RuntimeError):
        dm.deliver_to_driver(
            "T-088", "Halo.", actor="dispatcher", source="console", operation_id="op-fail-0001"
        )
    monkeypatch.undo()
    retried = dm.deliver_to_driver(
        "T-088", "Halo.", actor="dispatcher", source="console", operation_id="op-fail-0001"
    )
    assert "replayed" not in retried and retried["dispatch"]["truck_code"] == "T-088"

    dm.SENT_OPERATIONS.write(dm._replay_key("op", "T-088", "op-busy-0001"), {"status": "pending"})
    busy = api_client.post(
        "/api/driver/messages",
        json={"truck_code": "T-088", "text": "Halo."},
        headers={**auth_headers("dispatcher"), "X-Operation-Id": "op-busy-0001"},
    )
    assert busy.status_code == 409


def test_a_driver_acknowledgement_reaches_the_console(api_client, auth_headers):
    sent = api_client.post(
        "/api/driver/messages", json={"truck_code": "T-088", "text": "Baca ini."}, headers=auth_headers()
    ).json()
    dispatch_id = sent["dispatch"]["id"]
    confirm = api_client.post(
        f"/api/dispatch/{dispatch_id}/confirm", json={"status": "READY"}, headers=auth_headers("driver")
    )
    assert confirm.status_code == 200
    status = api_client.get(f"/api/dispatch/{dispatch_id}/status", headers=auth_headers())
    assert status.json()["field_status"] == "READY"


# ---- escalations ----------------------------------------------------------------


@pytest.fixture()
def quiet_feed(monkeypatch):
    monkeypatch.setattr(feed, "_gate_peaks", lambda day, follow_ups: [])


def test_an_escalation_waits_in_needs_you_until_handled(api_client, auth_headers, quiet_feed, sent):
    response = api_client.post(
        "/api/escalations",
        json={"subject": "Rem T-112 bermasalah", "text": "Sopir melapor rem blong.", "truck_code": "T-112"},
        headers=auth_headers("dispatcher"),
    )
    assert response.status_code == 201
    escalation = response.json()
    assert escalation["id"].startswith("escalation:")
    assert escalation["channels"] == [{"channel": "console_inbox", "status": "queued"}]
    assert sent == []

    items = api_client.get("/api/ops/needs-you", headers=auth_headers("supervisor")).json()["items"]
    item = next(i for i in items if i["id"] == escalation["id"])
    assert item["kind"] == "escalation" and item["truck_code"] == "T-112"
    assert item["facts"]["subject"] == "Rem T-112 bermasalah"
    assert item["facts"]["raised_by"] == "dispatcher"
    assert item["next_step"]["key"] == "ea_step_escalation"

    handled = api_client.post(
        f"/api/escalations/{escalation['id']}/handled", headers=auth_headers("supervisor")
    )
    assert handled.status_code == 200
    assert handled.json()["status"] == "handled" and handled.json()["handled_by"] == "supervisor"
    items = api_client.get("/api/ops/needs-you", headers=auth_headers("supervisor")).json()["items"]
    assert escalation["id"] not in {i["id"] for i in items}
    assert escalation["id"] in {e["id"] for e in dm.escalations("handled")}
    # The audit trail keeps both the escalation and its close.
    events = history_store.list_events(limit=50)
    assert any(
        e["event_type"] == "supervisor_escalation" and e["payload"]["id"] == escalation["id"] for e in events
    )
    assert any(e["event_type"] == "supervisor_escalation_handled" for e in events)


def test_an_open_escalation_never_drops_out_of_needs_you(api_client, auth_headers, quiet_feed, monkeypatch):
    escalation = api_client.post(
        "/api/escalations", json={"subject": "Cek T-088", "text": "Tolong cek."}, headers=auth_headers()
    ).json()
    # However many newer events the audit log holds, the queue reads its own store.
    monkeypatch.setattr(history_store, "list_events", lambda *args, **kwargs: [])
    items = api_client.get("/api/ops/needs-you", headers=auth_headers("supervisor")).json()["items"]
    assert escalation["id"] in {i["id"] for i in items}


def test_a_retried_escalation_is_queued_once(api_client, auth_headers):
    request = {
        "json": {"subject": "Ban T-088", "text": "Ban kempes.", "source": "assistant", "proposal_id": "p-9"},
        "headers": {**auth_headers("dispatcher"), "X-Operation-Id": "op-esc-0001"},
    }
    first = api_client.post("/api/escalations", **request).json()
    again = api_client.post("/api/escalations", **request).json()
    assert again["id"] == first["id"] and again["replayed"] is True
    assert [e["id"] for e in dm.escalations()].count(first["id"]) == 1
    assert first["client_hints"] == {"source": "assistant", "proposal_id": "p-9"}


def test_only_a_supervisor_closes_an_escalation(api_client, auth_headers, quiet_feed):
    unknown = api_client.post("/api/escalations/escalation:nope/handled", headers=auth_headers("supervisor"))
    assert unknown.status_code == 404
    escalation = api_client.post(
        "/api/escalations", json={"subject": "x", "text": "y"}, headers=auth_headers("dispatcher")
    ).json()
    for role in ("dispatcher", "driver"):
        denied = api_client.post(f"/api/escalations/{escalation['id']}/handled", headers=auth_headers(role))
        assert denied.status_code == 403, role
    # A generic alert follow-up (any dispatcher) does not close it either.
    api_client.post(
        "/api/alert/follow-up",
        json={"alert_id": escalation["id"], "status": "RESOLVED", "operator": "supervisor"},
        headers=auth_headers("dispatcher"),
    )
    items = api_client.get("/api/ops/needs-you", headers=auth_headers("supervisor")).json()["items"]
    assert escalation["id"] in {i["id"] for i in items}
    # The administrator may; the record names the signed-in account.
    closed = api_client.post(
        f"/api/escalations/{escalation['id']}/handled", headers=auth_headers("administrator")
    )
    assert closed.status_code == 200 and closed.json()["handled_by"] == "administrator"


def test_an_escalation_subject_is_cut_to_one_line(api_client, auth_headers):
    response = api_client.post(
        "/api/escalations", json={"subject": "s" * 300, "text": "Teks."}, headers=auth_headers()
    )
    assert response.status_code == 201
    assert len(response.json()["subject"]) == dm.SUBJECT_MAX
    # A long, multi-line subject is trimmed to its first line, not refused.
    long = api_client.post(
        "/api/escalations",
        json={"subject": "  Rem T-112 " + "x" * 1500 + "\nbaris kedua", "text": "Teks."},
        headers=auth_headers(),
    )
    assert long.status_code == 201
    assert long.json()["subject"].startswith("Rem T-112 x") and len(long.json()["subject"]) == dm.SUBJECT_MAX
    assert "baris kedua" not in long.json()["subject"]


def test_a_driver_account_cannot_escalate(api_client, auth_headers):
    response = api_client.post(
        "/api/escalations", json={"subject": "x", "text": "y"}, headers=auth_headers("driver")
    )
    assert response.status_code == 403
