"""Driver exception reports from the field app: one tap, an optional photo, replay-safe.

A driver reports what stops the work at the curb or on the road (an empty TPS,
a closed road, a broken-down truck, an accident). The report is stored as the
driver sent it; it does not complete or skip an SPJ stop, so the stop stays
open until the supervisor decides.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.storage import RecordStore

TABLE = "pythia_driver_exceptions"

# tps_empty: the TPS is empty or the waste was not put out (the most common
# curbside exception); road_closed: the planned road is blocked.
# "driver_message" is a free-text note to dispatch (the driver app's "Message dispatch").
KINDS = ("tps_empty", "road_closed", "truck_breakdown", "accident", "driver_message")
# What the day's recap counts as an incident: everything but a plain message.
INCIDENT_KINDS = tuple(kind for kind in KINDS if kind != "driver_message")
# These two take the truck out of service, so they also file a damage report.
VEHICLE_KINDS = ("truck_breakdown", "accident")


@dataclass
class DriverException:
    exception_id: str
    kind: str
    truck_code: str
    driver_name: str
    reported_by: str
    spj_id: str | None
    stop_index: int | None
    note: str
    photo_name: str | None
    photo_b64: str | None
    lat: float | None
    lng: float | None
    approx: bool
    reported_at: str | None  # device time, so an offline replay keeps the real moment
    created_at: str
    operation_id: str | None = None
    damage_report_id: str | None = None

    def public(self) -> dict[str, Any]:
        """The record without the photo bytes."""
        data = asdict(self)
        data["has_photo"] = bool(data.pop("photo_b64"))
        return data


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _record_id(operation_id: str | None) -> str:
    """A replayed operation maps to the same record, so two replays cannot make two reports."""
    if operation_id:
        return "op-" + hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:12]
    return uuid4().hex[:12]


class DriverExceptionStore:
    """Durable exception store; a replayed operation_id returns the stored report."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._records = RecordStore(TABLE, db_path)

    def find_operation(self, operation_id: str | None) -> DriverException | None:
        if not operation_id:
            return None
        raw = self._records.get(_record_id(operation_id))
        return DriverException(**raw) if raw is not None else None

    def create(self, **fields: Any) -> DriverException:
        if fields.get("kind") not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}")
        rec = DriverException(
            exception_id=_record_id(fields.get("operation_id")), created_at=_utc_now(), **fields
        )
        self._records.write(rec.exception_id, asdict(rec))
        return rec

    def attach_damage_report(self, exception_id: str, report_id: str) -> DriverException:
        raw = self._records.get(exception_id)
        if raw is None:
            raise ValueError(f"exception {exception_id} not found")
        raw["damage_report_id"] = report_id
        self._records.write(exception_id, raw)
        return DriverException(**raw)

    def list(self, truck_code: str | None = None) -> list[DriverException]:
        items = [DriverException(**raw) for raw in self._records.all()]
        items.reverse()
        if truck_code is None:
            return items
        return [r for r in items if r.truck_code == truck_code]


EXCEPTION_STORE = DriverExceptionStore()
