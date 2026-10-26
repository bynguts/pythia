"""Driver trip view (wave 13): next stop ETA, gate slot and the queue ahead, for the driver's own truck."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from app.api.deps import ensure_truck_access, require_any_principal
from app.field.driver_trip import trip_payload

router = APIRouter()


@router.get("/api/driver/trip/{truck_code}")
def get_driver_trip(
    truck_code: str,
    lat: float | None = Query(None, ge=-90, le=90, description="The phone's latitude"),
    lng: float | None = Query(None, ge=-180, le=180, description="The phone's longitude"),
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create", "dashboard:read")),
) -> dict[str, Any]:
    """Next stop and drive to the TPA from the phone's position, the truck's gate slot today and
    the modelled gate queue of the next two hours. Values without a source are null with a reason."""
    ensure_truck_access(principal, truck_code)
    return trip_payload(truck_code, lat, lng)
