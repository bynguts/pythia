"""Gate-slot recommendations for the Bantargebang weighbridge (wave 12 lane C).

The board reads the gate slots of approved plans; accepting a hold sends the
truck one plain dispatch instruction. The plan's own instructions are untouched.
"""

from __future__ import annotations

import threading
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import require_permission
from app.api.state import _OPERATIONS_PLAN_STORE, dispatch_center, history_store
from app.core.env import today
from app.core.storage import RecordStore
from app.fleet.gate_slots import assign_gate_slots, slot_board

router = APIRouter()

# One accepted hold per recommendation id, durable across workers.
ACCEPTS = RecordStore("gate_slot_accepts")
_accept_lock = threading.Lock()
_PLAN_SCAN_LIMIT = 500


def _planned_slots(slot_date: date) -> list[dict[str, Any]]:
    """`{truck_code, gate_slot}` of approved plans whose slot falls on `slot_date`.

    A plan for the day before counts too: its night-shift trucks reach the gate
    after midnight. Plans stored before gate slots existed get theirs computed
    here, in approval order, each seeing the earlier plans' slots.
    """
    days = {slot_date.isoformat(), (slot_date - timedelta(days=1)).isoformat()}
    plans = [
        p
        for p in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=_PLAN_SCAN_LIMIT)
        if p.get("plan_date") in days
    ]
    plans.sort(key=lambda p: (p.get("approved_at") or "", p.get("plan_id") or ""))
    taken: list[dict[str, Any]] = []
    planned: list[dict[str, Any]] = []
    for plan in plans:
        dispatches = [d for d in plan.get("dispatches") or [] if d.get("truck_code")]
        stored = {d["truck_code"]: (d.get("fields") or {}) for d in dispatches}
        missing = [d for d in dispatches if "gate_slot" not in stored[d["truck_code"]]]
        computed = assign_gate_slots(missing, date.fromisoformat(plan["plan_date"]), taken) if missing else {}
        for dispatch in dispatches:
            truck_code = dispatch["truck_code"]
            fields = stored[truck_code]
            slot = fields["gate_slot"] if "gate_slot" in fields else computed.get(truck_code)
            if not slot:
                continue
            taken.append(slot)
            if slot.get("date") == slot_date.isoformat():
                planned.append({"truck_code": truck_code, "gate_slot": slot})
    return planned


def gate_slots_payload(slot_date: date) -> dict[str, Any]:
    planned = _planned_slots(slot_date)
    board = slot_board(slot_date, planned)
    if not planned:
        board["reason"] = "no_approved_plan"
    elif board["saturated"] and not board["recommendations"]:
        board["reason"] = "saturated"
    else:
        board["reason"] = None
    accepted = {a["rec_id"]: a for a in ACCEPTS.all()}
    for rec in board["recommendations"]:
        if rec["id"] in accepted:
            rec["accepted"] = True
            rec["dispatch_id"] = accepted[rec["id"]]["dispatch_id"]
    return board


@router.get("/api/gate/slots")
def get_gate_slots(
    slot_date: date | None = Query(None, alias="date", description="Slot day; defaults to today"),
    _role: str = Depends(require_permission("dashboard:read")),
) -> dict[str, Any]:
    """Weighbridge slots of a day: background load, planned trucks, modelled wait and holds (SIMULATED)."""
    return gate_slots_payload(slot_date or today())


@router.post("/api/gate/slots/recommendations/{rec_id}/accept")
def accept_gate_slot_recommendation(
    rec_id: str, _role: str = Depends(require_permission("dispatch:create"))
) -> dict[str, Any]:
    """Send the held truck one dispatch instruction; a repeat returns the first acceptance."""
    existing = ACCEPTS.get(rec_id)
    if existing:
        return existing
    try:
        slot_date = date.fromisoformat(rec_id[len("rec-") : len("rec-") + 10])
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Recommendation {rec_id} not found.") from None
    rec = next((r for r in gate_slots_payload(slot_date)["recommendations"] if r["id"] == rec_id), None)
    if rec is None:
        raise HTTPException(
            status_code=404, detail=f"Recommendation {rec_id} not found or no longer current."
        )

    with _accept_lock, ACCEPTS.transaction() as connection:
        existing = ACCEPTS.get(rec_id, connection)
        if existing:
            return existing
        dispatch = history_store.save_dispatch(
            truck_code=rec["truck_code"],
            instruction=(
                f"Tahan keberangkatan {rec['hold_minutes']} menit; slot gerbang baru "
                f"{rec['to_slot']}–{rec['to_slot_end']} (simulasi)"
            ),
            manager_id="gate_slot_recommendation",
        )
        result = {
            "rec_id": rec_id,
            "dispatch_id": dispatch["id"],
            "truck_code": rec["truck_code"],
            "new_slot": {
                "facility": rec["facility"],
                "slot_index": rec["to_slot_index"],
                "date": rec["date"],
                "start": rec["to_slot"],
                "end": rec["to_slot_end"],
                "hold_minutes": rec["hold_minutes"],
                "classification": "SIMULATED",
            },
        }
        ACCEPTS.write(rec_id, result, connection)
    dispatch_center._dispatches.append(dispatch)
    history_store.record_event(
        "gate_slot_recommendation_accepted",
        {
            "rec_id": rec_id,
            "truck_code": rec["truck_code"],
            "dispatch_id": dispatch["id"],
            "accepted_by": _role,
        },
    )
    return result
