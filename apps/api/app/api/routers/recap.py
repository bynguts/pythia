"""Close-of-day recap: actual vs forecast (wave 12 lane E)."""

from __future__ import annotations

from datetime import date as date_type

from fastapi import APIRouter, Depends, Query

from app.api.deps import require_any_permission
from app.core.env import local_today
from app.field.recap import daily_recap

router = APIRouter()


@router.get("/api/recap/daily")
def get_daily_recap(
    date: date_type | None = Query(None, description="Working day (WIB); defaults to today"),
    _role: str = Depends(require_any_permission("reports:read", "dashboard:read")),
):
    return daily_recap(date or local_today())
