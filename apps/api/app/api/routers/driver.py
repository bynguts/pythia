"""Driver PWA: pre-trip checks, damage reports, service records, compliance, weighbridge OCR."""

from __future__ import annotations

import logging
import time
from dataclasses import asdict as _asdict
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import require_any_permission, require_permission
from app.api.schemas import DamageReportBody, OcrBody, PretripBody, ServiceRecordBody
from app.api.state import _compliance_cache, _compliance_lock, _refresh_fleet_caches, history_store
from app.field.compliance import WINDOW_DAYS as COMPLIANCE_WINDOW_DAYS
from app.field.compliance import compute_fleet_scores
from app.field.damage_reports import DAMAGE_STORE
from app.field.pretrip import PRETRIP_STORE
from app.field.service_history import SERVICE_STORE, due_date_for

router = APIRouter()
logger = logging.getLogger(__name__)


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
def pretrip_today(truck_code: str) -> dict[str, Any]:
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
def list_damage_reports(status: str | None = None) -> dict[str, Any]:
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
            service_date=date.today().isoformat(),
            component=rep.component,
            description=f"Resolve laporan: {rep.note}",
            source="damage_resolve",
            next_due_date=due_date_for(rep.component, date.today()),
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
def list_service_records(truck_code: str | None = None) -> dict[str, Any]:
    records = SERVICE_STORE.list(truck_code)
    return {"records": [_asdict(r) for r in records], "count": len(records)}


@router.get("/api/service-records/due-soon")
def service_records_due_soon(days: int = 30) -> dict[str, Any]:
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


@router.get("/api/compliance/drivers")
def compliance_drivers() -> dict[str, Any]:
    return _compliance_payload()


@router.get("/api/compliance/drivers/{driver_name}")
def compliance_driver_detail(driver_name: str) -> dict[str, Any]:
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
