"""Driver damage reports with fleet-status override (Fase 2 Driver PWA)."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.storage import RecordStore

logger = logging.getLogger(__name__)

SEVERITIES = ("ringan", "berat")

TABLE = "jwis_damage_reports"
LEGACY_JSON = "jwis_damage_reports.json"


@dataclass
class DamageReport:
    report_id: str
    truck_code: str
    driver_name: str
    component: str
    severity: str  # ringan | berat
    note: str
    photo_name: str | None
    photo_b64: str | None
    source: str  # driver_pwa | pretrip
    status: str  # baru | selesai
    created_at: str
    resolved_at: str | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class DamageReportStore:
    """Durable damage-report store; a report exists only after it has committed."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._records = RecordStore(TABLE, db_path)
        if db_path is None:
            self._records.migrate_legacy_json(
                self._records.db_path.parent / LEGACY_JSON, "report_id")

    def create(self, truck_code: str, driver_name: str, component: str,
               severity: str, note: str, photo_name: str | None = None,
               photo_b64: str | None = None,
               source: str = "driver_pwa") -> DamageReport:
        if severity not in SEVERITIES:
            raise ValueError(f"severity must be one of {SEVERITIES}")
        rep = DamageReport(
            report_id=uuid4().hex[:12], truck_code=truck_code,
            driver_name=driver_name, component=component,
            severity=severity, note=note, photo_name=photo_name,
            photo_b64=photo_b64, source=source, status="baru",
            created_at=_utc_now())
        self._records.write(rep.report_id, asdict(rep))
        return rep

    def list(self, status: str | None = None) -> list[DamageReport]:
        items = [DamageReport(**raw) for raw in self._records.all()]
        items.reverse()
        if status is None:
            return items
        return [r for r in items if r.status == status]

    def resolve(self, report_id: str) -> DamageReport:
        raw = self._records.get(report_id)
        if raw is None:
            raise ValueError(f"report {report_id} not found")
        if raw["status"] == "selesai":
            raise ValueError(f"report {report_id} already resolved")
        raw["status"] = "selesai"
        raw["resolved_at"] = _utc_now()
        self._records.write(report_id, raw)
        return DamageReport(**raw)

    def active_override_for(self, truck_code: str) -> DamageReport | None:
        for raw in reversed(self._records.all()):
            if (raw["truck_code"] == truck_code
                    and raw["severity"] == "berat"
                    and raw["status"] != "selesai"):
                return DamageReport(**raw)
        return None


DAMAGE_STORE = DamageReportStore()
