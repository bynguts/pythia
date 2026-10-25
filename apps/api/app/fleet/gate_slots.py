"""Gate-slot assignment for approved plan dispatches (wave 12 lane C)."""

from __future__ import annotations

from datetime import date


def assign_gate_slots(dispatches: list[dict], plan_date: date, occupied: list[dict] = ()) -> dict[str, dict]:
    """Map truck_code -> gate slot for a plan's dispatches.

    Stub until lane C lands: no truck gets a slot yet.
    """
    return {}
