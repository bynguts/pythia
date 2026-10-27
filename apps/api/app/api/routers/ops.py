"""Console-wide operational feeds: the "Needs you" list and driver-phone sync."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from app.api.deps import require_permission
from app.api.state import _OPERATIONS_PLAN_STORE
from app.core.env import local_today
from app.field.devices import devices_payload
from app.field.drivers_week import MAX_DAYS, drivers_week
from app.field.needs_you import needs_you

router = APIRouter()


@router.get("/api/ops/needs-you")
def get_needs_you(_role: str = Depends(require_permission("dashboard:read"))) -> dict[str, Any]:
    """Every open item that wants a dispatcher decision today, urgent first, with per-item provenance."""
    return needs_you()


@router.get("/api/field/devices")
def get_field_devices(_role: str = Depends(require_permission("dashboard:read"))) -> dict[str, Any]:
    """How many trucks' driver phones called this server in the last 30 minutes.

    ``expected`` is the number of trucks in today's approved plans, or null when
    no plan is approved for today.
    """
    day = local_today().isoformat()
    trucks = {
        d["truck_code"]
        for p in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=100)
        if p.get("plan_date") == day
        for d in p.get("dispatches") or p.get("assignments") or []
        if d.get("truck_code")
    }
    return devices_payload(len(trucks) or None)


# A per-driver performance table names people, so it follows /api/compliance/drivers (history:read).
@router.get("/api/fleet/drivers-week")
def get_drivers_week(
    days: int = Query(7, ge=1, le=MAX_DAYS),
    _role: str = Depends(require_permission("history:read")),
) -> dict[str, Any]:
    """Per driver over the last ``days`` local days: trips, proof, gate punctuality and duty (field records)."""
    return drivers_week(days, local_today())
