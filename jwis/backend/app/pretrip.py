"""Pre-trip inspection records (Fase 2 Driver PWA)."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.storage import RecordStore

logger = logging.getLogger(__name__)

PRETRIP_ITEMS = ("rem", "mesin", "ban", "bbm", "oli", "bak_compactor", "lampu")

TABLE = "jwis_pretrip"
LEGACY_JSON = "jwis_pretrip.json"


@dataclass
class PreTripRecord:
    record_id: str
    truck_code: str
    driver_name: str
    date: str
    items: dict[str, bool]
    note: str
    created_at: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class PreTripStore:
    """Durable pre-trip store; a record exists only after it has committed."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._records = RecordStore(TABLE, db_path)
        if db_path is None:
            self._records.migrate_legacy_json(
                self._records.db_path.parent / LEGACY_JSON, "record_id")

    def submit(self, truck_code: str, driver_name: str,
               items: dict[str, bool], note: str = "") -> PreTripRecord:
        if set(items.keys()) != set(PRETRIP_ITEMS):
            raise ValueError(f"items must contain exactly: {PRETRIP_ITEMS}")
        if any(not v for v in items.values()) and not note.strip():
            raise ValueError("note is required when any inspection item fails")
        rec = PreTripRecord(
            record_id=uuid4().hex[:12], truck_code=truck_code,
            driver_name=driver_name, date=_today(),
            items={k: bool(v) for k, v in items.items()},
            note=note.strip(), created_at=_utc_now())
        self._records.write(rec.record_id, asdict(rec))
        return rec

    def today(self, truck_code: str) -> PreTripRecord | None:
        today = _today()
        for raw in reversed(self._records.all()):
            if raw["truck_code"] == truck_code and raw["date"] == today:
                return PreTripRecord(**raw)
        return None

    def list_recent(self, truck_code: str, days: int = 30) -> list[PreTripRecord]:
        records = [PreTripRecord(**raw) for raw in self._records.all()
                   if raw["truck_code"] == truck_code]
        return list(reversed(records))[:days]


PRETRIP_STORE = PreTripStore()
