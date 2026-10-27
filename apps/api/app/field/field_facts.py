"""Field facts: what the dispatcher knows that no feed carries.

"Gate lane 3 closed 08:00-10:00", "T-112 stays in the workshop", "clean-up day
in Kembangan". These are the only manual input of the planning loop: weather,
events and holidays fill themselves in.

A fact may carry a structured ``effect``. Only ``truck_unavailable`` reaches the
plan this wave (the truck is left out of the solver's fleet); every other fact
is stored and shown with ``applied: false`` and says so. Deleting a fact keeps
the record (``deleted_at``), so the history of what the plan was told survives.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.core.storage import RecordStore

SOURCES = ("tpa_notice", "workshop", "district_office", "other")
EFFECT_KINDS = ("truck_unavailable", "gate_lane_closed")
APPLIED_NOTES = {
    "truck_unavailable": "the truck is left out of the plan's fleet when the plan is built with auto inputs",
    None: "recorded, not modelled",
    "gate_lane_closed": "recorded, not modelled: the gate model has no per-lane capacity",
}

FACTS = RecordStore("pythia_field_facts")


def _public(raw: dict[str, Any]) -> dict[str, Any]:
    kind = (raw.get("effect") or {}).get("kind")
    return {
        **raw,
        "applied": kind == "truck_unavailable",
        "applied_note": APPLIED_NOTES.get(kind, APPLIED_NOTES[None]),
        "classification": "FIELD",
    }


def _effect(effect: dict[str, Any] | None) -> dict[str, Any] | None:
    if not effect:
        return None
    kind = effect.get("kind")
    if kind not in EFFECT_KINDS:
        raise ValueError(f"effect.kind must be one of {EFFECT_KINDS}")
    if kind == "truck_unavailable":
        truck_code = str(effect.get("truck_code") or "").strip()
        if not truck_code:
            raise ValueError("truck_unavailable needs a truck_code")
        return {"kind": kind, "truck_code": truck_code}
    start, end = str(effect.get("from") or "").strip(), str(effect.get("to") or "").strip()
    return {"kind": kind, "from": start or None, "to": end or None}


def add_fact(day: str, text: str, source: str, effect: dict[str, Any] | None, actor: str) -> dict[str, Any]:
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    if not text.strip():
        raise ValueError("text is required")
    record = {
        "id": f"fact-{uuid4().hex[:12]}",
        "date": day,
        "text": text.strip(),
        "source": source,
        "effect": _effect(effect),
        "created_by": actor,
        "created_at": datetime.now(UTC).isoformat(),
        "deleted_at": None,
        "deleted_by": None,
    }
    FACTS.write(record["id"], record)
    return _public(record)


def list_facts(day: str | None = None) -> list[dict[str, Any]]:
    """Live facts (not deleted), oldest first; ``day`` narrows to one operating day."""
    return [
        _public(raw)
        for raw in FACTS.all()
        if raw.get("deleted_at") is None and (day is None or raw.get("date") == day)
    ]


def delete_fact(fact_id: str, actor: str) -> dict[str, Any]:
    """Mark a fact deleted; KeyError when unknown. Deleting twice is a no-op."""
    raw = FACTS.get(fact_id)
    if raw is None:
        raise KeyError(fact_id)
    if raw.get("deleted_at") is None:
        raw["deleted_at"] = datetime.now(UTC).isoformat()
        raw["deleted_by"] = actor
        FACTS.write(fact_id, raw)
    return _public(raw)


def unavailable_trucks(day: str) -> dict[str, str]:
    """truck_code -> fact id, for the trucks a live fact of ``day`` takes off the road."""
    return {
        f["effect"]["truck_code"]: f["id"]
        for f in list_facts(day)
        if (f.get("effect") or {}).get("kind") == "truck_unavailable"
    }
