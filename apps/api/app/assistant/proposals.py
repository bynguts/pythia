"""Ana's human-in-the-loop proposals: she may draft a send, never make one.

``propose_action`` validates a draft against a small whitelist and returns it as data.
It writes nothing, sends nothing and records nothing; the console shows the draft as a
card (recipient, channels, the full editable text) and only the operator's Send click,
with the operator's own token, calls ``/api/driver/messages`` or ``/api/escalations``.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from app.field.driver_messages import (
    INSTRUCTION_KINDS,
    SUBJECT_MAX,
    TEXT_MAX,
    channel_names,
    plain_text,
    truck_exists,
)
from app.integrations.whatsapp import message_language

ACTION_TYPES = ("message_driver", "send_instruction", "escalate_to_supervisor")
MAX_PROPOSALS = 3  # per answer

PROPOSE_ACTION_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "propose_action",
        "description": (
            "Usulkan SATU tindakan untuk disetujui operator; tool ini TIDAK mengirim apa pun. Operator "
            "melihat teks lengkap, boleh mengubahnya, lalu menekan Kirim atau Abaikan. Jenis: "
            "message_driver (pesan ke sopir satu truk: aplikasi sopir + WhatsApp pribadi bila ada kontak, "
            "tidak pernah ke grup), send_instruction (instruksi ke sopir satu truk; kind general/use_route/"
            "handle_alert), escalate_to_supervisor (eskalasi ke pengawas lapangan; subject + text). Teks "
            "polos tanpa tautan atau markdown, maksimal 500 karakter. Teks untuk sopir dalam bahasa pesan sopir "
            "yang disebut instruksi sistem; teks eskalasi dalam bahasa operator."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": list(ACTION_TYPES)},
                "truck_code": {"type": "string", "description": "Wajib untuk pesan/instruksi, misal T-047"},
                "kind": {"type": "string", "enum": list(INSTRUCTION_KINDS), "description": "Untuk instruksi"},
                "subject": {"type": "string", "description": "Untuk eskalasi, satu baris"},
                "text": {"type": "string", "description": "Teks lengkap yang akan dibaca penerima"},
            },
            "required": ["action", "text"],
        },
    },
}


def validate_proposal(args: dict[str, Any]) -> dict[str, Any]:
    """One whitelisted draft, normalised; ValueError says what is wrong. Executes nothing."""
    action = str(args.get("action") or "")
    if action not in ACTION_TYPES:
        raise ValueError(f"action must be one of {', '.join(ACTION_TYPES)}")
    text = plain_text(args.get("text"), TEXT_MAX)
    proposal: dict[str, Any] = {"id": uuid4().hex[:12], "action": action, "text": text, "executed": False}
    if action == "escalate_to_supervisor":
        # A long subject is cut to one line's length, not refused.
        subject = plain_text(args.get("subject") or text.split("\n", 1)[0], TEXT_MAX)[:SUBJECT_MAX]
        recipient = {"type": "supervisor"}
        truck = str(args.get("truck_code") or "").strip().upper() or None
        if truck and not truck_exists(truck):
            raise ValueError(f"truck {truck} does not exist")
        proposal.update(subject=subject, truck_code=truck)
    else:
        truck = str(args.get("truck_code") or "").strip().upper()
        if not truck:
            raise ValueError("truck_code is required")
        if not truck_exists(truck):
            raise ValueError(f"truck {truck} does not exist")
        recipient = {"type": "driver", "truck_code": truck}
        proposal["truck_code"] = truck
        # The language the driver reads (Settings -> WhatsApp message language); the console labels it.
        proposal["lang"] = message_language()[0]
        if action == "send_instruction":
            kind = str(args.get("kind") or "general")
            if kind not in INSTRUCTION_KINDS:
                raise ValueError(f"kind must be one of {', '.join(INSTRUCTION_KINDS)}")
            proposal["kind"] = kind
    proposal["recipient"] = recipient
    proposal["channels"] = channel_names(recipient)
    return proposal


def propose_action_tool(args: dict[str, Any]) -> dict[str, Any]:
    """The tool's answer to the model: the draft, and that nothing has been sent."""
    return {
        "proposal": validate_proposal(args),
        "note": "DRAFT ONLY - nothing was sent. The operator reviews, edits and presses Send.",
    }


# Local mode (no LLM): "kirim pesan ke T-047: ..." / "send T-047: ..." / "eskalasi ke pengawas: ...".
# Only a text the operator typed after a colon or in quotes becomes the draft; nothing is invented.
_TRUCK = re.compile(r"\bT-\d{1,4}\b", re.IGNORECASE)
_SEND = re.compile(
    r"\b(kirim|kirimkan|send|message|pesan|kabari|beri ?tahu|tell|instruksikan|instruct)\b", re.I
)
_ESCALATE = re.compile(r"\b(eskalasi|eskalasikan|escalate|pengawas|supervisor)\b", re.I)
_BODY = re.compile(r"[\"“](.+?)[\"”]|:\s+(.+)$", re.S)


def parse_proposal_request(question: str) -> dict[str, Any] | None:
    """The propose_action arguments a typed request spells out, or None."""
    body = _BODY.search(question)
    if not body:
        return None
    text = (body.group(1) or body.group(2) or "").strip()
    if not text:
        return None
    head = question[: body.start()]
    truck = _TRUCK.search(head)
    if _ESCALATE.search(head):
        return {
            "action": "escalate_to_supervisor",
            "text": text,
            "truck_code": truck.group().upper() if truck else None,
        }
    if truck and _SEND.search(head):
        return {"action": "message_driver", "truck_code": truck.group().upper(), "text": text}
    return None


def local_proposal_answer(proposal: dict[str, Any], language: str) -> str:
    """The local answer that goes with a parsed draft: what is ready and the one step that sends it."""
    en = language == "en"
    if proposal["action"] == "escalate_to_supervisor":
        return (
            "Your escalation to the field supervisor is ready below. Review it, edit it if you like, and "
            "press Send to put it in the supervisor's queue."
            if en
            else "Draf eskalasi ke pengawas lapangan siap di bawah. Periksa, ubah bila perlu, lalu tekan Kirim "
            "untuk memasukkannya ke antrean pengawas."
        )
    return (
        f"Your message to the driver of {proposal['truck_code']} is ready below. Review it, edit it if you "
        "like, and press Send to deliver it to their app, plus private WhatsApp when their number is registered."
        if en
        else f"Pesan untuk sopir {proposal['truck_code']} siap di bawah. Periksa, ubah bila perlu, lalu tekan "
        "Kirim untuk mengirimnya ke aplikasi sopir, juga WhatsApp pribadi bila nomornya terdaftar."
    )
