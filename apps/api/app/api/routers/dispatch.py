"""Dispatch orders, alert follow-ups and the history audit trail."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import (
    ensure_truck_access,
    require_any_permission,
    require_any_principal,
    require_permission,
)
from app.api.schemas import DispatchConfirmRequest, DispatchRequest
from app.api.state import dispatch_center, history_store
from app.field.privacy import mask_phones_in_text

router = APIRouter()


def _masked_event(event: dict) -> dict:
    """Phone numbers / WhatsApp JIDs in event payloads leave the API masked (62812****7890).

    Events written before masking existed (e.g. whatsapp_alert recipients) are
    masked here on the way out, so no stored number is ever served in full.
    """
    payload = event.get("payload")
    if isinstance(payload, dict):
        payload = {k: mask_phones_in_text(v) if isinstance(v, str) else v for k, v in payload.items()}
    return {**event, "payload": payload}


@router.get("/api/history")
def history(_role: str = Depends(require_permission("history:read"))) -> list[dict]:
    """The operational event log (gap 7: personal data, so history:read only)."""
    return [_masked_event(event) for event in history_store.list_events()]


FOLLOW_UP_STATUSES = {"OPEN", "DISPATCHED", "RESOLVED"}


@router.get("/api/alert/follow-ups")
def alert_follow_ups(
    _role: str = Depends(require_any_permission("dashboard:read", "history:read")),
) -> list[dict]:
    """Audit trail of alert follow-ups (OPEN -> DISPATCHED -> RESOLVED)."""
    return [
        event for event in history_store.list_events(limit=200) if event["event_type"] == "alert_followup"
    ]


@router.post("/api/alert/follow-up")
def alert_follow_up(
    payload: dict[str, Any], _role: str = Depends(require_permission("dispatch:create"))
) -> dict[str, Any]:
    """Record a supervisor follow-up action (status + operator + note)."""
    alert_id = str(payload.get("alert_id", "")).strip()
    status = str(payload.get("status", "OPEN")).upper()
    if status not in FOLLOW_UP_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(FOLLOW_UP_STATUSES)}")
    if not alert_id:
        raise HTTPException(status_code=400, detail="alert_id is required")
    record = {
        "alert_id": alert_id,
        "status": status,
        "operator": str(payload.get("operator", "dispatcher")).strip() or "dispatcher",
        "note": str(payload.get("note", "")).strip(),
    }
    history_store.record_event("alert_followup", record)
    return {"recorded": True, **record}


@router.post("/api/dispatch")
def create_dispatch(
    payload: DispatchRequest, _role: str = Depends(require_permission("dispatch:create"))
) -> dict:
    d = history_store.save_dispatch(payload.truck_code, payload.instruction, payload.manager_id)
    dispatch_center._dispatches.append(d)
    history_store.record_event("dispatch_created", {"truck_code": payload.truck_code, "dispatch_id": d["id"]})
    return d


@router.get("/api/dispatch/{truck_code}")
def pending_dispatches(
    truck_code: str,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create", "dashboard:read")),
) -> list[dict]:
    """Pending instructions for one truck; a truck-bound driver account reads only its own."""
    ensure_truck_access(principal, truck_code)
    return history_store.pending_dispatches(truck_code)


@router.get("/api/dispatch/{dispatch_id}/status")
def dispatch_status(
    dispatch_id: str, _role: str = Depends(require_any_permission("dispatch:create", "dispatch:confirm"))
) -> dict:
    dispatch = history_store.get_dispatch(dispatch_id)
    if dispatch is None:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    return dispatch


@router.post("/api/dispatch/{dispatch_id}/confirm")
def confirm_dispatch(
    dispatch_id: str,
    payload: DispatchConfirmRequest,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create")),
) -> dict:
    # #44: operation_id replay detection. A confirmation carrying an
    # operation_id already recorded for this dispatch returns the stored
    # state without writing a second history event, so outbox flush retries
    # stay exactly-once observable.
    if payload.operation_id is not None:
        prior = history_store.get_dispatch_operation(dispatch_id, payload.operation_id)
        if prior is not None:
            # Replay of an already-recorded operation: return stored state,
            # do not write a second history event (#44).
            return prior
    try:
        d = history_store.update_dispatch_status(
            dispatch_id, payload.status, payload.note, payload.operation_id
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    history_store.record_event("dispatch_confirmed", {"dispatch_id": dispatch_id, "status": payload.status})
    return d
