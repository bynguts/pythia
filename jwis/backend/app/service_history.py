"""Vehicle service history and next-due tracking (Fase 3)."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.storage import RecordStore

logger = logging.getLogger(__name__)

HEAVY_COMPONENTS = {"rem", "mesin", "ban"}

TABLE = "jwis_service_history"
LEGACY_JSON = "jwis_service_history.json"


@dataclass
class ServiceRecord:
    record_id: str
    truck_code: str
    service_date: str
    component: str
    description: str
    cost_idr: int | None
    odometer_km: float | None
    technician: str
    source: str  # admin | damage_resolve
    next_due_date: str | None
    created_at: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def due_date_for(component: str, from_date: date) -> str:
    days = 90 if component in HEAVY_COMPONENTS else 180
    return (from_date + __import__("datetime").timedelta(days=days)).isoformat()


class ServiceStore:
    """Durable service-history store; a record exists only after it has committed."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._records = RecordStore(TABLE, db_path)
        if db_path is None:
            self._records.migrate_legacy_json(
                self._records.db_path.parent / LEGACY_JSON, "record_id")

    def create(self, truck_code: str, service_date: str, component: str,
               description: str, cost_idr: int | None = None,
               odometer_km: float | None = None, technician: str = "",
               source: str = "admin",
               next_due_date: str | None = None) -> ServiceRecord:
        rec = ServiceRecord(
            record_id=uuid4().hex[:12], truck_code=truck_code,
            service_date=service_date, component=component,
            description=description, cost_idr=cost_idr,
            odometer_km=odometer_km, technician=technician,
            source=source, next_due_date=next_due_date,
            created_at=_utc_now())
        self._records.write(rec.record_id, asdict(rec))
        return rec

    def list(self, truck_code: str | None = None) -> list[ServiceRecord]:
        items = [ServiceRecord(**raw) for raw in self._records.all()]
        items.reverse()
        if truck_code is None:
            return items
        return [r for r in items if r.truck_code == truck_code]

    def latest_per_truck(self) -> dict[str, ServiceRecord]:
        latest: dict[str, ServiceRecord] = {}
        for raw in self._records.all():
            rec = ServiceRecord(**raw)
            prev = latest.get(rec.truck_code)
            if prev is None or rec.service_date >= prev.service_date:
                latest[rec.truck_code] = rec
        return latest

    def due_soon(self, days: int = 30, today: str | None = None) -> list[dict]:
        ref = date.fromisoformat(today) if today else date.today()
        due: list[dict] = []
        for truck_code, rec in self.latest_per_truck().items():
            if not rec.next_due_date:
                continue
            try:
                due_date = date.fromisoformat(rec.next_due_date)
            except ValueError:
                continue
            days_left = (due_date - ref).days
            if days_left <= days:
                due.append({"truck_code": truck_code,
                            "component": rec.component,
                            "next_due_date": rec.next_due_date,
                            "days_left": days_left})
        due.sort(key=lambda d: d["days_left"])
        return due


SERVICE_STORE = ServiceStore()
