"""Who receives what: one routing rule for messages, instructions and escalations.

- A message or instruction for **one truck** goes only to that truck's driver: the driver
  app's inbox (a dispatch row the driver acknowledges) and, when the contact registry
  holds a real number for that driver, a private WhatsApp chat. Never the alert group.
- A **fleet-wide** alert goes to the WhatsApp alert group only.
- An **escalation** goes to the supervisor's queue in the console (the Needs-you feed and
  the bell), never to WhatsApp or a driver.

Nothing here is called by the assistant: Ana only proposes (app.assistant.proposals);
every send is an operator's click on an authenticated endpoint.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.api.state import dispatch_center, history_store
from app.core.storage import RecordStore
from app.field.privacy import mask_phones_in_text

TEXT_MAX = 500  # the dispatch row's limit (DispatchRequest.instruction)
SUBJECT_MAX = 120
# The instruction forms the console already sends: free text (New instruction), a route
# (Send route to driver) and "handle this alert" (the fleet action card).
INSTRUCTION_KINDS = ("general", "use_route", "handle_alert")
ESCALATION_EVENT = "supervisor_escalation"
ESCALATION_PREFIX = "escalation:"

# The supervisor's queue: one record per escalation, "open" until someone marks it handled.
ESCALATIONS = RecordStore("pythia_escalations")
# Replay guard for driver messages: one record per operation id / proposal id holding the
# first send's result, so a client retry never writes a second inbox row or WhatsApp.
SENT_OPERATIONS = RecordStore("pythia_driver_message_ops")

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def plain_text(value: Any, limit: int = TEXT_MAX) -> str:
    """The text as plain characters: no control codes, at most two line breaks in a row.

    Raises ValueError when nothing is left or the text is longer than ``limit``.
    Links and markdown stay as typed characters: every surface renders this as text.
    """
    text = _CONTROL.sub("", str(value or "")).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        raise ValueError("text is empty")
    if len(text) > limit:
        raise ValueError(f"text is longer than {limit} characters")
    return text


def truck_exists(truck_code: str) -> bool:
    from app.fleet.data import get_dynamic_trucks

    return any(t["truck_code"] == truck_code for t in get_dynamic_trucks())


def _digits(jid: str) -> str:
    return re.sub(r"\D", "", jid.split("@", 1)[0])


def private_chat_id(truck_code: str) -> str | None:
    """The private WhatsApp chat of this truck's driver, or None.

    Only a real entry of the local contact registry counts: no contacts file, an unreadable
    one, a driver without an entry, the repo placeholder, the configured default chat or
    any group all mean "no private chat", so a one-driver message never reaches a shared
    chat. The file is read directly: ``load_contacts`` serves default contacts (every
    driver mapped to the default chat) for a malformed file, and that must not count.
    """
    from app.api.routers import whatsapp as wa
    from app.integrations.whatsapp import PLACEHOLDER_CHAT_ID, default_chat_id, default_group_id

    try:
        contacts = json.loads(wa.CONTACTS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(contacts, dict) or not contacts.get("send_to_driver", True):
        return None
    drivers = contacts.get("drivers")
    name = wa.get_truck_info(truck_code).get("driver_name")
    raw = drivers.get(name) if isinstance(drivers, dict) and name else None
    if not isinstance(raw, str) or "@g.us" in raw:
        return None
    jid = wa.normalize_phone_number(raw)
    shared = {_digits(PLACEHOLDER_CHAT_ID), _digits(default_chat_id()), _digits(default_group_id())}
    if not jid.endswith("@c.us") or _digits(jid) in shared:
        return None
    return jid


def delivery_channels(recipient: dict[str, Any]) -> list[dict[str, Any]]:
    """recipient -> the channels it reaches. The one routing rule (see the module docstring).

    ``recipient`` is ``{"type": "driver", "truck_code": ...}``, ``{"type": "fleet"}`` or
    ``{"type": "supervisor"}``. A WhatsApp channel carries its raw ``chat_id``; callers
    mask it before it leaves the API.
    """
    kind = recipient.get("type")
    if kind == "driver":
        channels: list[dict[str, Any]] = [{"channel": "in_app"}]
        jid = private_chat_id(str(recipient.get("truck_code") or ""))
        if jid:
            channels.append({"channel": "whatsapp_private", "chat_id": jid})
        return channels
    if kind == "fleet":
        from app.api.routers.whatsapp import alert_group

        jid, source = alert_group()
        return [] if source == "placeholder" else [{"channel": "whatsapp_group", "chat_id": jid}]
    if kind == "supervisor":
        return [{"channel": "console_inbox"}]
    raise ValueError(f"unknown recipient type: {kind!r}")


def channel_names(recipient: dict[str, Any]) -> list[str]:
    """The channel names only (no chat ids): safe for the console and the assistant."""
    return [c["channel"] for c in delivery_channels(recipient)]


def whatsapp_driver_text(truck_code: str, text: str) -> str:
    return f"Pythia · {truck_code}\n{text}"


def send_private_whatsapp(truck_code: str, text: str) -> dict[str, Any]:
    """The WhatsApp leg of a one-driver message: its private chat, or ``no_contact``."""
    from app.integrations.whatsapp import OpenWAClient

    jid = private_chat_id(truck_code)
    if not jid:
        return {"channel": "whatsapp_private", "status": "no_contact"}
    result = OpenWAClient.from_env().send_text(jid, whatsapp_driver_text(truck_code, text))
    return {
        "channel": "whatsapp_private",
        "status": "sent" if result.get("sent") else "failed",
        "to": mask_phones_in_text(jid),
    }


def _replay_key(prefix: str, truck_code: str, value: str) -> str:
    return f"{prefix}-" + hashlib.sha256(f"{truck_code}|{value}".encode()).hexdigest()[:20]


def _claim_send(keys: list[str]) -> dict[str, Any] | None:
    """Claim one send for these replay keys, atomically.

    Returns the first send's stored result when a key was used before (a replay), None when
    this call owns the send. ValueError while the first send of the same keys is in flight.
    """
    with SENT_OPERATIONS.transaction() as connection:
        for key in keys:
            prior = SENT_OPERATIONS.get(key, connection) or {}
            if prior.get("status") == "done":
                return prior["result"]
            if prior.get("status") == "pending":
                raise ValueError("this message is already being sent")
        for key in keys:
            SENT_OPERATIONS.write(key, {"status": "pending"}, connection)
    return None


def deliver_to_driver(
    truck_code: str,
    text: str,
    *,
    actor: str,
    source: str,
    kind: str = "message",
    instruction_kind: str | None = None,
    proposal_id: str | None = None,
    operation_id: str | None = None,
) -> dict[str, Any]:
    """Send one operator-approved text to one truck's driver, on that driver's channels only.

    Idempotent: a repeated ``operation_id`` (X-Operation-Id) or ``proposal_id`` for the same
    truck returns the first send with ``replayed: True`` and sends nothing again.
    """
    keys = [_replay_key("op", truck_code, operation_id)] if operation_id else []
    if proposal_id:
        keys.append(_replay_key("proposal", truck_code, proposal_id))
    prior = _claim_send(keys) if keys else None
    if prior is not None:
        return {**prior, "replayed": True}
    try:
        result = _deliver(truck_code, text, actor, source, kind, instruction_kind, proposal_id)
    except Exception:
        for key in keys:  # nothing was recorded as sent: the same ids may retry
            SENT_OPERATIONS.write(key, {"status": "failed"})
        raise
    for key in keys:
        SENT_OPERATIONS.write(key, {"status": "done", "result": result})
    return result


def _deliver(
    truck_code: str,
    text: str,
    actor: str,
    source: str,
    kind: str,
    instruction_kind: str | None,
    proposal_id: str | None,
) -> dict[str, Any]:
    """The inbox row first (the driver app is the record), then WhatsApp, best effort.

    The audit event names who approved it, never the text's phone numbers in full.
    """
    dispatch = history_store.save_dispatch(truck_code, text, actor)
    dispatch_center._dispatches.append(dispatch)
    history_store.record_event("dispatch_created", {"truck_code": truck_code, "dispatch_id": dispatch["id"]})
    channels = [{"channel": "in_app", "status": "inbox", "dispatch_id": dispatch["id"]}]
    channels.append(send_private_whatsapp(truck_code, text))
    history_store.record_event(
        "driver_message",
        {
            "dispatch_id": dispatch["id"],
            "truck_code": truck_code,
            "kind": kind,
            "instruction_kind": instruction_kind,
            # What the client says the text came from: a hint for the reader, not proof.
            "client_hints": {"source": source, "proposal_id": proposal_id},
            "approved_by": actor,
            "chars": len(text),
            "channels": [{k: v for k, v in c.items() if k != "dispatch_id"} for c in channels],
        },
    )
    return {"dispatch": dispatch, "channels": channels}


def record_escalation(
    subject: str,
    text: str,
    *,
    actor: str,
    source: str,
    truck_code: str | None = None,
    proposal_id: str | None = None,
    operation_id: str | None = None,
) -> dict[str, Any]:
    """Put one escalation in the supervisor's queue (Needs you + bell). Sends nothing else.

    A repeated ``operation_id`` returns the stored escalation instead of queueing a second.
    """
    queued = [{"channel": "console_inbox", "status": "queued"}]
    if operation_id:
        escalation_id = ESCALATION_PREFIX + hashlib.sha256(operation_id.encode()).hexdigest()[:12]
        prior = ESCALATIONS.get(escalation_id)
        if prior is not None:
            return {**prior, "channels": queued, "replayed": True}
    else:
        escalation_id = f"{ESCALATION_PREFIX}{uuid4().hex[:12]}"
    escalation = {
        "id": escalation_id,
        "subject": subject,
        "text": text,
        "truck_code": truck_code,
        # What the client says it came from: a hint for the reader, not proof.
        "client_hints": {"source": source, "proposal_id": proposal_id},
        "approved_by": actor,
        "status": "open",
        "created_at": datetime.now(UTC).isoformat(),
    }
    ESCALATIONS.write(escalation_id, escalation)
    history_store.record_event(ESCALATION_EVENT, escalation)
    return {**escalation, "channels": queued}


def escalations(status: str | None = "open") -> list[dict[str, Any]]:
    """Escalations with this status ("open" / "handled"; None for all), newest first."""
    records = [r for r in ESCALATIONS.all() if status is None or r.get("status") == status]
    return sorted(records, key=lambda r: r["created_at"], reverse=True)


def mark_escalation_handled(escalation_id: str, *, actor: str) -> dict[str, Any]:
    """Close one escalation. KeyError when unknown; a second close keeps the first."""
    with ESCALATIONS.transaction() as connection:
        record = ESCALATIONS.get(escalation_id, connection)
        if record is None:
            raise KeyError(escalation_id)
        if record.get("status") == "handled":
            return record
        record = {
            **record,
            "status": "handled",
            "handled_by": actor,
            "handled_at": datetime.now(UTC).isoformat(),
        }
        ESCALATIONS.write(escalation_id, record, connection)
    history_store.record_event(f"{ESCALATION_EVENT}_handled", {"id": escalation_id, "handled_by": actor})
    return record
