"""Scentinel sensor-placement evidence import (#23)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import require_any_permission
from app.api.schemas import ScentinelImportBody
from app.api.state import SCENTINEL_STORE
from app.integrations.scentinel import ScentinelImportError, evidence_to_payload, import_scentinel_evidence

router = APIRouter()


@router.post("/api/scentinel/evidence", status_code=201)
def scentinel_import(
    body: ScentinelImportBody,
    _role: str = Depends(require_any_permission("dispatch:create", "dispatch:confirm")),
) -> dict[str, Any]:
    """Import one immutable Scentinel run manifest + sensor CSV as external
    screening evidence. The solver itself is never executed here."""
    try:
        ev = import_scentinel_evidence(body.manifest, body.sensor_csv, body.truck_code)
    except ScentinelImportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    payload = evidence_to_payload(ev)
    SCENTINEL_STORE.write(ev.run_id, payload)
    return payload


@router.get("/api/scentinel/evidence")
def scentinel_list() -> dict[str, Any]:
    return {"items": SCENTINEL_STORE.all()}
