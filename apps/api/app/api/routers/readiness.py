"""Morning readiness board: one row per truck (wave 12 lane B)."""

from __future__ import annotations

from datetime import date as Date
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from app.api.deps import require_permission
from app.field.readiness import readiness_payload

router = APIRouter()


@router.get("/api/readiness")
def get_readiness(
    date: Date | None = Query(None, description="Operating day; defaults to today (WIB)"),
    scope: Literal["plan", "fleet"] = "plan",
    _role: str = Depends(require_permission("dashboard:read")),
) -> dict[str, Any]:
    """Per truck: pre-trip, duty, instruction ack, SPJ, damage and service, with blockers.

    `scope=plan` covers the trucks in the day's approved plans plus those with an
    SPJ that day, and falls back to the whole fleet (`scope_used: "fleet"`) when
    that set is empty.
    """
    return readiness_payload(date, scope)
