"""R9: personal data never leaves for an external LLM provider.

Every request the assistant sends to the OpenAI-compatible gateway goes through
``scrub_outgoing``: phone numbers (and WhatsApp JIDs), Indonesian plate numbers
and the names of known people (the local driver-contacts file and the display
names in PYTHIA_USERS_FILE) are replaced with placeholders. Images are passed
through untouched; only text is scrubbed.
"""

from __future__ import annotations

import copy
import json
from typing import Any

from app.core import paths
from app.core.auth import load_users
from app.field.privacy import scrub_pii


def known_person_names() -> list[str]:
    """Names of real people this server knows about (contacts file, users file)."""
    names: list[str] = []
    try:
        contacts = json.loads(paths.DRIVER_CONTACTS_FILE.read_text(encoding="utf-8"))
        drivers = contacts.get("drivers") if isinstance(contacts, dict) else None
        if isinstance(drivers, dict):
            names.extend(str(name) for name in drivers)
    except (OSError, ValueError):
        pass
    names.extend(user["display_name"] for user in load_users().values() if user.get("display_name"))
    return names


def _scrub_content(content: Any, names: list[str]) -> Any:
    if isinstance(content, str):
        return scrub_pii(content, names)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                part["text"] = scrub_pii(part["text"], names)
    return content


def scrub_outgoing(payload: dict[str, Any]) -> dict[str, Any]:
    """A copy of a chat-completions payload with personal data removed from every message."""
    names = known_person_names()
    clean = copy.deepcopy(payload)
    for message in clean.get("messages") or []:
        if isinstance(message, dict) and "content" in message:
            message["content"] = _scrub_content(message["content"], names)
    return clean
