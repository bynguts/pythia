"""Operator-approved sends to one driver, and escalations to the supervisor (wave 16).

Every call here is an operator's click (an assistant proposal, a Needs-you suggestion
or a gate hold, previewed and possibly edited first) made with the operator's own token.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import require_any_principal
from app.field import driver_messages as dm

router = APIRouter()


class DriverMessageBody(BaseModel):
    truck_code: str = Field(min_length=1, max_length=20)
    text: str = Field(min_length=1, max_length=2000)
    kind: Literal["message", "instruction"] = "message"
    instruction_kind: Literal["general", "use_route", "handle_alert"] | None = None
    source: Literal["assistant", "needs_you", "console"] = "console"
    proposal_id: str | None = Field(default=None, max_length=64)


class EscalationBody(BaseModel):
    subject: str = Field(min_length=1, max_length=2000)
    text: str = Field(min_length=1, max_length=2000)
    truck_code: str | None = Field(default=None, max_length=20)
    source: Literal["assistant", "needs_you", "console"] = "console"
    proposal_id: str | None = Field(default=None, max_length=64)


def _plain_or_422(value: str, limit: int) -> str:
    try:
        return dm.plain_text(value, limit)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _known_truck_or_404(truck_code: str) -> None:
    if not dm.truck_exists(truck_code):
        raise HTTPException(status_code=404, detail=f"Truck {truck_code} not found.")


@router.get("/api/driver/messages/channels/{truck_code}")
def driver_message_channels(
    truck_code: str, _principal: dict = Depends(require_any_principal("dispatch:create"))
) -> dict:
    """Where a message to this truck's driver would go (channel names only, no numbers)."""
    _known_truck_or_404(truck_code)
    return {
        "truck_code": truck_code,
        "channels": dm.channel_names({"type": "driver", "truck_code": truck_code}),
    }


@router.post("/api/driver/messages", status_code=201)
def send_driver_message(
    body: DriverMessageBody,
    x_operation_id: str | None = Header(default=None, min_length=8, max_length=80),
    principal: dict = Depends(require_any_principal("dispatch:create")),
) -> dict:
    """One text to one truck's driver: the driver app inbox, plus a private WhatsApp when a
    contact exists. Never the alert group. 404 unknown truck, 422 empty or too long.

    A retry with the same X-Operation-Id, or a second send of the same Ana proposal, returns
    the first send (``replayed: true``) instead of messaging the driver twice; 409 while
    that first send is still in flight.
    """
    _known_truck_or_404(body.truck_code)
    text = _plain_or_422(body.text, dm.TEXT_MAX)
    try:
        return dm.deliver_to_driver(
            body.truck_code,
            text,
            actor=principal["username"],
            source=body.source,
            kind=body.kind,
            instruction_kind=body.instruction_kind if body.kind == "instruction" else None,
            proposal_id=body.proposal_id,
            operation_id=x_operation_id,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/api/escalations", status_code=201)
def create_escalation(
    body: EscalationBody,
    x_operation_id: str | None = Header(default=None, min_length=8, max_length=80),
    principal: dict = Depends(require_any_principal("dispatch:create")),
) -> dict:
    """Put an escalation in the supervisor's queue (Needs you and the bell).
    A retry with the same X-Operation-Id returns the queued one (``replayed: true``)."""
    if body.truck_code:
        _known_truck_or_404(body.truck_code)
    return dm.record_escalation(
        # One line, cut to fit before it is checked: a long subject is trimmed, not refused.
        _plain_or_422((body.subject.strip().splitlines() or [""])[0][: dm.SUBJECT_MAX], dm.SUBJECT_MAX),
        _plain_or_422(body.text, dm.TEXT_MAX),
        actor=principal["username"],
        source=body.source,
        truck_code=body.truck_code,
        proposal_id=body.proposal_id,
        operation_id=x_operation_id,
    )


@router.post("/api/escalations/{escalation_id}/handled")
def handle_escalation(
    escalation_id: str, principal: dict = Depends(require_any_principal("operations:approve"))
) -> dict:
    """Mark an escalation handled: it leaves Needs you and the bell. 404 when unknown.

    Closing one is the supervisor's decision (operations:approve: supervisor, administrator);
    the record names the signed-in account, never a name from the request.
    """
    try:
        return dm.mark_escalation_handled(escalation_id, actor=principal["username"])
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"Escalation {escalation_id} not found.") from error
