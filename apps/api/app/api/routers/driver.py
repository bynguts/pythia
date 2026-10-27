"""Driver PWA: pre-trip checks, damage reports, service records, compliance, weighbridge OCR."""

from __future__ import annotations

import logging
import time
from dataclasses import asdict as _asdict
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import (
    ensure_truck_access,
    require_any_permission,
    require_any_principal,
    require_permission,
)
from app.api.schemas import DamageReportBody, OcrBody, PretripBody, ServiceRecordBody
from app.api.state import _compliance_cache, _compliance_lock, _refresh_fleet_caches, history_store
from app.core.env import local_today
from app.core.storage import StorageError
from app.field.compliance import WINDOW_DAYS as COMPLIANCE_WINDOW_DAYS
from app.field.compliance import compute_fleet_scores
from app.field.damage_reports import DAMAGE_STORE
from app.field.driver_exceptions import EXCEPTION_STORE, KINDS, VEHICLE_KINDS, DriverException
from app.field.pretrip import PRETRIP_STORE
from app.field.service_history import SERVICE_STORE, due_date_for
from app.field.spj import SPJ_STORE

router = APIRouter()
logger = logging.getLogger(__name__)

# Gap 7: these reads name drivers, technicians and people in photos.
OPERATOR_READ = ("dashboard:read", "dispatch:create", "history:read")
# Every role holds one of these, so any signed-in session passes.
ANY_SESSION = ("dispatch:confirm", "dispatch:create", "dashboard:read", "history:read")


@router.get("/api/driver/session")
def driver_session(principal: dict = Depends(require_any_principal(*ANY_SESSION))) -> dict[str, Any]:
    """Who this token belongs to (gap 6).

    ``truck_code`` is set for a personal driver account from PYTHIA_USERS_FILE: the
    driver app then uses that truck instead of letting the driver pick one.
    ``shared_account`` is true for the shared demo role logins.
    """
    return {
        "username": principal["username"],
        "role": principal["role"],
        "truck_code": principal.get("truck_code"),
        "display_name": principal.get("display_name"),
        "shared_account": bool(principal.get("shared_account")),
    }


@router.post("/api/pretrip", status_code=201)
def submit_pretrip(
    body: PretripBody, _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create"))
) -> dict[str, Any]:
    try:
        rec = PRETRIP_STORE.submit(body.truck_code, body.driver_name, body.items, body.note)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _asdict(rec)


@router.get("/api/pretrip/today/{truck_code}")
def pretrip_today(
    truck_code: str,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create", "dashboard:read")),
) -> dict[str, Any]:
    """Today's (Asia/Jakarta working day) pre-trip record for one truck."""
    ensure_truck_access(principal, truck_code)
    rec = PRETRIP_STORE.today(truck_code)
    return {"record": _asdict(rec) if rec else None, "done": rec is not None}


@router.post("/api/damage-reports", status_code=201)
def create_damage_report(
    body: DamageReportBody,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    try:
        rep = DAMAGE_STORE.create(
            body.truck_code,
            body.driver_name,
            body.component,
            body.severity,
            body.note,
            body.photo_name,
            body.photo_b64,
            body.source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    history_store.record_event(
        "damage_reported",
        {
            "report_id": rep.report_id,
            "truck_code": rep.truck_code,
            "component": rep.component,
            "severity": rep.severity,
            "source": rep.source,
        },
    )
    _refresh_fleet_caches()
    return _asdict(rep)


@router.get("/api/damage-reports")
def list_damage_reports(
    status: str | None = None, _role: str = Depends(require_any_permission(*OPERATOR_READ))
) -> dict[str, Any]:
    reports = DAMAGE_STORE.list(status=status)
    return {"reports": [_asdict(r) for r in reports], "count": len(reports)}


@router.post("/api/damage-reports/{report_id}/resolve")
def resolve_damage_report(
    report_id: str, _role: str = Depends(require_permission("dispatch:create"))
) -> dict[str, Any]:
    try:
        rep = DAMAGE_STORE.resolve(report_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:  # hook must never break resolve
        SERVICE_STORE.create(
            rep.truck_code,
            service_date=local_today().isoformat(),
            component=rep.component,
            description=f"Resolve laporan: {rep.note}",
            source="damage_resolve",
            next_due_date=due_date_for(rep.component, local_today()),
        )
    except Exception:  # noqa: BLE001
        logger.exception("service-record hook failed for report %s", report_id)
    _refresh_fleet_caches()
    return _asdict(rep)


@router.post("/api/service-records", status_code=201)
def create_service_record(
    body: ServiceRecordBody, _role: str = Depends(require_permission("dispatch:create"))
) -> dict[str, Any]:
    rec = SERVICE_STORE.create(
        body.truck_code,
        body.service_date,
        body.component,
        body.description,
        cost_idr=body.cost_idr,
        odometer_km=body.odometer_km,
        technician=body.technician,
        next_due_date=body.next_due_date,
    )
    return _asdict(rec)


@router.get("/api/service-records")
def list_service_records(
    truck_code: str | None = None, _role: str = Depends(require_any_permission(*OPERATOR_READ))
) -> dict[str, Any]:
    records = SERVICE_STORE.list(truck_code)
    return {"records": [_asdict(r) for r in records], "count": len(records)}


@router.get("/api/service-records/due-soon")
def service_records_due_soon(
    days: int = 30, _role: str = Depends(require_any_permission(*OPERATOR_READ))
) -> dict[str, Any]:
    due = SERVICE_STORE.due_soon(days=days)
    return {"due": due, "count": len(due)}


def _compliance_payload() -> dict[str, Any]:
    cached = _compliance_cache
    now = time.time()
    if cached["payload"] is None or now - cached["ts"] > 60.0:
        with _compliance_lock:
            now = time.time()
            if cached["payload"] is None or now - cached["ts"] > 60.0:
                drivers = compute_fleet_scores()
                cached["payload"] = {
                    "drivers": drivers,
                    "count": len(drivers),
                    "window_days": COMPLIANCE_WINDOW_DAYS,
                }
                cached["ts"] = time.time()
    return cached["payload"]


# Gap 7: a score about a named person is for supervisors and auditors only.
@router.get("/api/compliance/drivers")
def compliance_drivers(_role: str = Depends(require_permission("history:read"))) -> dict[str, Any]:
    return _compliance_payload()


@router.get("/api/compliance/drivers/{driver_name}")
def compliance_driver_detail(
    driver_name: str, _role: str = Depends(require_permission("history:read"))
) -> dict[str, Any]:
    for entry in _compliance_payload()["drivers"]:
        if entry["driver_name"] == driver_name:
            return entry
    raise HTTPException(status_code=404, detail=f"driver {driver_name} not found in fleet")


@router.post("/api/ocr/timbangan")
def ocr_timbangan(
    body: OcrBody, _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create"))
) -> dict[str, Any]:
    from app.field.timbangan_ocr import read_weight_from_photo

    return read_weight_from_photo(body.photo_b64)


class DriverExceptionBody(BaseModel):
    kind: str = Field(pattern="^(" + "|".join(KINDS) + ")$")
    truck_code: str = Field(min_length=1, max_length=32)
    driver_name: str = Field(default="", max_length=120)
    spj_id: str | None = Field(default=None, max_length=64)
    stop_index: int | None = Field(default=None, ge=0, le=500)
    note: str = Field(default="", max_length=500)
    photo_name: str | None = Field(default=None, max_length=200)
    photo_b64: str | None = Field(default=None, max_length=7_000_000)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    approx: bool = False
    reported_at: str | None = Field(default=None, max_length=64)
    operation_id: str | None = Field(default=None, min_length=8, max_length=80)


# The damage report a vehicle exception files, so the existing maintenance
# hold and damage tab see the truck as out of service.
_EXCEPTION_DAMAGE = {
    "truck_breakdown": ("mogok", "Truk mogok/rusak di jalan (laporan cepat sopir)"),
    "accident": ("kecelakaan", "Kecelakaan dilaporkan sopir (laporan cepat)"),
}


def _store_exception(
    body: DriverExceptionBody, truck_code: str, actor: str, operation_id: str | None
) -> DriverException:
    """Store the report; a vehicle exception also files a "berat" damage report."""
    rec = EXCEPTION_STORE.create(
        kind=body.kind,
        truck_code=truck_code,
        driver_name=body.driver_name.strip() or truck_code,
        reported_by=actor,
        spj_id=body.spj_id,
        stop_index=body.stop_index,
        note=body.note.strip(),
        photo_name=body.photo_name,
        photo_b64=body.photo_b64,
        lat=body.lat,
        lng=body.lng,
        approx=body.approx,
        reported_at=body.reported_at,
        operation_id=operation_id,
    )
    if rec.kind in VEHICLE_KINDS:
        component, default_note = _EXCEPTION_DAMAGE[rec.kind]
        rep = DAMAGE_STORE.create(
            truck_code,
            rec.driver_name,
            component,
            "berat",
            rec.note or default_note,
            rec.photo_name,
            rec.photo_b64,
            "driver_exception",
        )
        rec = EXCEPTION_STORE.attach_damage_report(rec.exception_id, rep.report_id)
        _refresh_fleet_caches()
    return rec


@router.post("/api/driver/exceptions", status_code=201)
def create_driver_exception(
    body: DriverExceptionBody,
    x_operation_id: str | None = Header(default=None),
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """One quick exception from the driver app (empty TPS, closed road, breakdown, accident).

    The outbox replays a queued report with the same operation id; a replay
    returns the stored report instead of filing a second one. The report never
    completes or skips an SPJ stop.
    """
    truck_code = body.truck_code.strip()
    ensure_truck_access(principal, truck_code)
    operation_id = body.operation_id or x_operation_id
    prior = EXCEPTION_STORE.find_operation(operation_id)
    if prior is not None:
        return {**prior.public(), "replayed": True}
    if body.spj_id:
        spj = SPJ_STORE.get(body.spj_id)
        if spj is None:
            raise HTTPException(status_code=404, detail=f"Work order {body.spj_id} not found")
        if spj.truck_code != truck_code:
            raise HTTPException(status_code=409, detail="The work order belongs to another truck.")
    try:
        rec = _store_exception(body, truck_code, principal["username"], operation_id)
    except StorageError as exc:
        logger.error("driver exception persistence failure: %s", exc)
        raise HTTPException(
            status_code=503, detail="Exception storage is unavailable; the report was not saved."
        ) from exc
    history_store.record_event(
        "driver_exception",
        {
            "exception_id": rec.exception_id,
            "kind": rec.kind,
            "truck_code": rec.truck_code,
            "spj_id": rec.spj_id,
            "stop_index": rec.stop_index,
            "actor": rec.reported_by,
            "damage_report_id": rec.damage_report_id,
        },
    )
    return {**rec.public(), "replayed": False}


# What a driver sees of an operator's follow-up on their report.
_DRIVER_REPORT_STATUS = {None: "sent", "OPEN": "seen", "DISPATCHED": "seen", "RESOLVED": "handled"}


@router.get("/api/driver/exceptions")
def list_driver_exceptions(
    truck_code: str | None = None,
    principal: dict = Depends(require_any_principal(*OPERATOR_READ, "dispatch:confirm")),
) -> dict[str, Any]:
    """Exception reports, newest first, each with the latest operator follow-up on it.

    A driver session (no operator read permission) must name its truck and reads
    only that truck's reports. ``report_status`` is ``sent`` until an operator
    records a follow-up, then ``seen`` (open or dispatched) or ``handled``.
    """
    from app.core.auth import has_permission
    from app.field.needs_you import exception_alert_id, follow_up_statuses

    if not any(has_permission(principal["role"], p) for p in OPERATOR_READ):
        if not truck_code:
            # The unscoped list stays operator-only.
            raise HTTPException(
                status_code=403, detail="A driver session reads only its own truck's reports."
            )
        ensure_truck_access(principal, truck_code)
    follow_ups = follow_up_statuses(local_today().isoformat())
    reports = []
    for record in EXCEPTION_STORE.list(truck_code=truck_code):
        follow_up = follow_ups.get(exception_alert_id(record.exception_id)) or follow_ups.get(
            record.exception_id
        )
        status = (follow_up or {}).get("status")
        reports.append(
            {
                **record.public(),
                "follow_up_status": status,
                "follow_up_at": (follow_up or {}).get("at"),
                "report_status": _DRIVER_REPORT_STATUS.get(status, "seen"),
            }
        )
    return {"exceptions": reports, "count": len(reports)}
