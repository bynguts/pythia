"""Ana's propose_action: a validated draft for the operator, never a send (wave 16)."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock

import pytest

from app.api.routers import whatsapp as wa_router
from app.api.state import history_store
from app.assistant.assistant import answer_with_openai_if_configured
from app.assistant.proposals import parse_proposal_request, validate_proposal
from app.assistant.tools import ToolContext, execute_tool
from app.core.storage import RecordStore
from app.integrations import whatsapp as wa
from app.integrations.whatsapp import OpenWAClient


def _ctx():
    return ToolContext(dispatch_center=MagicMock(audit_log=lambda: []), history_store=MagicMock())


@pytest.fixture(autouse=True)
def _no_local_contacts(tmp_path, monkeypatch):
    """Never the machine's own (git-ignored) contacts file."""
    monkeypatch.setattr(wa_router, "CONTACTS_FILE", tmp_path / "absent.json")


@pytest.fixture(autouse=True)
def _wa_settings(tmp_path, monkeypatch):
    """A fresh WhatsApp settings store (message language) and no PYTHIA_WA_LANG."""
    monkeypatch.setattr(wa, "_SETTINGS", RecordStore("pythia_whatsapp_settings", tmp_path / "wa.db"))
    monkeypatch.delenv("PYTHIA_WA_LANG", raising=False)


@pytest.fixture()
def no_sends(monkeypatch):
    """Fails the test if anything writes a dispatch or calls WhatsApp."""
    calls = []
    monkeypatch.setattr(history_store, "save_dispatch", lambda *a, **k: calls.append(("dispatch", a)))
    monkeypatch.setattr(OpenWAClient, "send_text", lambda self, *a: calls.append(("whatsapp", a)))
    return calls


def test_a_driver_message_draft_names_its_recipient_and_channels(no_sends):
    proposal = validate_proposal(
        {"action": "message_driver", "truck_code": "t-047", "text": "Tunggu di TPS."}
    )
    assert proposal["truck_code"] == "T-047"
    assert proposal["recipient"] == {"type": "driver", "truck_code": "T-047"}
    # No contacts file in tests: the app inbox only, and never the WhatsApp group.
    assert proposal["channels"] == ["in_app"]
    assert proposal["executed"] is False and proposal["id"]
    assert no_sends == []


def test_an_instruction_draft_keeps_its_whitelisted_kind():
    proposal = validate_proposal(
        {"action": "send_instruction", "truck_code": "T-047", "kind": "use_route", "text": "Pakai Rute B."}
    )
    assert proposal["kind"] == "use_route"


def test_an_escalation_draft_goes_to_the_supervisor_queue_only():
    proposal = validate_proposal(
        {"action": "escalate_to_supervisor", "subject": "Kecelakaan T-047", "text": "Mohon cek lokasi."}
    )
    assert proposal["recipient"] == {"type": "supervisor"}
    assert proposal["channels"] == ["console_inbox"]
    assert proposal["subject"] == "Kecelakaan T-047"


@pytest.mark.parametrize(
    ("args", "reason"),
    [
        ({"action": "dispatch_now", "truck_code": "T-047", "text": "x"}, "action must be one of"),
        ({"action": "approve_plan", "text": "x"}, "action must be one of"),
        ({"action": "message_driver", "text": "Halo"}, "truck_code is required"),
        ({"action": "message_driver", "truck_code": "T-9999", "text": "Halo"}, "does not exist"),
        (
            {"action": "send_instruction", "truck_code": "T-047", "kind": "approve", "text": "x"},
            "kind must be",
        ),
        ({"action": "message_driver", "truck_code": "T-047", "text": "   "}, "text is empty"),
        ({"action": "message_driver", "truck_code": "T-047", "text": "a" * 501}, "longer than 500"),
    ],
)
def test_a_draft_outside_the_whitelist_is_refused(args, reason):
    with pytest.raises(ValueError, match=reason):
        validate_proposal(args)


def test_the_tool_returns_a_draft_and_executes_nothing(no_sends):
    before = len(history_store.list_events(limit=2000))
    result = execute_tool(
        "propose_action", {"action": "message_driver", "truck_code": "T-047", "text": "Cek ban."}, _ctx()
    )
    assert result["proposal"]["text"] == "Cek ban."
    assert "nothing was sent" in result["note"]
    assert no_sends == []
    assert len(history_store.list_events(limit=2000)) == before


def test_a_refused_draft_comes_back_to_the_model_as_an_error():
    result = execute_tool("propose_action", {"action": "message_driver", "text": "x"}, _ctx())
    assert "error" in result and "truck_code is required" in result["error"]


def test_link_and_markdown_text_stays_plain_characters():
    text = "Buka [rute](https://evil.example/x) ![p](https://evil.example/p.png) <b>sekarang</b>"
    proposal = validate_proposal({"action": "message_driver", "truck_code": "T-047", "text": text})
    # Kept verbatim for the operator to read and edit; every surface renders it as text.
    assert proposal["text"] == text


def test_control_characters_are_dropped_from_a_draft():
    proposal = validate_proposal(
        {"action": "message_driver", "truck_code": "T-047", "text": "Satu\x00\x1b[31m\n\n\n\nDua"}
    )
    assert proposal["text"] == "Satu[31m\n\nDua"


@pytest.mark.parametrize(
    ("question", "expected"),
    [
        (
            "Kirim pesan ke T-047: Tunggu di TPS Kalideres.",
            {"action": "message_driver", "truck_code": "T-047", "text": "Tunggu di TPS Kalideres."},
        ),
        (
            'send t-088 "Go back to the depot"',
            {"action": "message_driver", "truck_code": "T-088", "text": "Go back to the depot"},
        ),
        (
            "Eskalasi ke pengawas soal T-112: rem blong, mohon dicek.",
            {"action": "escalate_to_supervisor", "truck_code": "T-112", "text": "rem blong, mohon dicek."},
        ),
        ("berapa truk aktif jam 10:30", None),
        ("kirim pesan ke T-047", None),
    ],
)
def test_local_mode_drafts_only_what_the_operator_typed(question, expected):
    assert parse_proposal_request(question) == expected


def test_local_answer_carries_the_draft_and_says_nothing_was_sent(monkeypatch, no_sends):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = answer_with_openai_if_configured(
        "Send T-047: Wait at the TPS gate.", {}, tool_ctx=_ctx(), language="en"
    )
    assert result["proposed_actions"][0]["text"] == "Wait at the TPS gate."
    assert "press Send to deliver it" in result["answer"]
    assert no_sends == []


@pytest.fixture()
def provider(monkeypatch):
    """A fake OpenAI-compatible gateway playing back scripted replies."""
    replies: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 (http.server API)
            self.rfile.read(int(self.headers["Content-Length"]))
            data = json.dumps(replies.pop(0)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-real")
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    try:
        yield replies
    finally:
        server.shutdown()
        server.server_close()


def _reply(content=None, tool_calls=None):
    message = {"role": "assistant", "content": content, **({"tool_calls": tool_calls} if tool_calls else {})}
    return {"model": "fake", "choices": [{"message": message}]}


def test_the_llm_path_returns_proposed_actions_and_sends_nothing(provider, no_sends):
    args = {"action": "message_driver", "truck_code": "T-047", "text": "Lewat Rute B, lalu konfirmasi."}
    call = {
        "id": "c1",
        "type": "function",
        "function": {"name": "propose_action", "arguments": json.dumps(args)},
    }
    provider.extend([_reply(tool_calls=[call]), _reply("Draf pesan untuk T-047 menunggu persetujuan Anda.")])
    result = answer_with_openai_if_configured(
        "Kabari sopir T-047 soal rute", {}, tool_ctx=_ctx(), language="id"
    )
    assert result["mode"] == "llm"
    assert [p["text"] for p in result["proposed_actions"]] == ["Lewat Rute B, lalu konfirmasi."]
    assert no_sends == []


def test_the_assistant_endpoint_always_carries_proposed_actions(api_client, auth_headers, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = api_client.post(
        "/api/assistant/query",
        json={"question": "Kirim pesan ke T-047: Cek tekanan ban.", "language": "id"},
        headers=auth_headers("dispatcher"),
    )
    assert response.status_code == 200
    assert response.json()["proposed_actions"][0]["truck_code"] == "T-047"
    plain = api_client.post(
        "/api/assistant/query",
        json={"question": "halo", "language": "id"},
        headers=auth_headers("dispatcher"),
    )
    assert plain.json()["proposed_actions"] == []


def test_a_driver_cannot_ask_ana_for_a_draft(api_client, auth_headers):
    response = api_client.post(
        "/api/assistant/query",
        json={"question": "Kirim pesan ke T-047: tes", "language": "id"},
        headers=auth_headers("driver"),
    )
    assert response.status_code == 403


def test_a_driver_draft_carries_the_drivers_message_language():
    args = {"action": "message_driver", "truck_code": "T-047", "text": "Wait at the gate."}
    assert validate_proposal(args)["lang"] == "id"  # the default: drivers read Indonesian
    wa.set_message_language("en")
    assert validate_proposal(args)["lang"] == "en"
    escalation = validate_proposal({"action": "escalate_to_supervisor", "text": "Check T-047."})
    assert "lang" not in escalation  # written for the operator's supervisor, in the console's language


def test_ana_is_told_to_write_driver_drafts_in_the_message_language(provider, monkeypatch):
    from app.assistant import assistant as assistant_module

    prompts = []
    original = assistant_module.scrub_outgoing

    def capture(payload):
        prompts.append(payload["messages"][0]["content"])
        return original(payload)

    monkeypatch.setattr(assistant_module, "scrub_outgoing", capture)
    wa.set_message_language("en")
    provider.append(_reply("Siap."))
    answer_with_openai_if_configured("halo", {}, tool_ctx=_ctx(), language="id")
    assert "Teks propose_action untuk sopir ditulis dalam English." in prompts[0]


def test_a_role_that_cannot_send_gets_no_drafts(api_client, monkeypatch, no_sends):
    # An executive reads Ana but sends nothing: a Send card would only ever answer 403.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    login = api_client.post(
        "/api/auth/login", json={"username": "executive", "password": "executive-demo-pass"}
    )
    executive = {"Authorization": f"Bearer {login.json()['token']}"}
    response = api_client.post(
        "/api/assistant/query",
        json={"question": "Kirim pesan ke T-047: Cek tekanan ban.", "language": "id"},
        headers=executive,
    )
    assert response.status_code == 200
    assert response.json()["proposed_actions"] == []
    assert no_sends == []


def test_without_send_permission_the_model_is_not_offered_propose_action(provider, monkeypatch, no_sends):
    from app.assistant import assistant as assistant_module

    offered = []
    original = assistant_module.scrub_outgoing

    def capture(payload):
        offered.append([tool["function"]["name"] for tool in payload.get("tools", [])])
        return original(payload)

    monkeypatch.setattr(assistant_module, "scrub_outgoing", capture)
    args = {"action": "message_driver", "truck_code": "T-047", "text": "Lewat Rute B."}
    call = {
        "id": "c1",
        "type": "function",
        "function": {"name": "propose_action", "arguments": json.dumps(args)},
    }
    # Even a model that calls it anyway gets an error back, not a draft.
    provider.extend([_reply(tool_calls=[call]), _reply("Baik.")])
    ctx = ToolContext(
        dispatch_center=MagicMock(audit_log=lambda: []), history_store=MagicMock(), can_send=False
    )
    result = answer_with_openai_if_configured("Kabari sopir T-047", {}, tool_ctx=ctx, language="id")
    assert offered and "propose_action" not in offered[0] and "get_readiness" in offered[0]
    assert not result.get("proposed_actions")
    assert "propose_action" not in result.get("tools_used", [])
    assert execute_tool("propose_action", args, ctx) == {"error": "this role does not send messages"}
