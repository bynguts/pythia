"""SPJ (Surat Perintah Jalan) work orders: lifecycle, evidence and receipts."""

from __future__ import annotations

import logging
from dataclasses import asdict as _asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import require_any_permission, require_permission
from app.api.schemas import (
    SpjCompleteBody,
    SpjCompleteOverrideBody,
    SpjCreateBody,
    SpjReceiptBody,
    SpjStopBody,
)
from app.api.state import _refresh_fleet_caches, history_store
from app.core.auth import has_permission
from app.core.storage import StorageError
from app.field.spj import SPJ_STORE, destination_provenance, spj_summary_payload
from app.field.spj import active_path_for as spj_active_path
from app.fleet.facilities import DESTINATIONS

router = APIRouter()
logger = logging.getLogger(__name__)


def _receipt_payload(receipt) -> dict[str, Any] | None:
    """Receipt projection: metadata plus a retrieval reference, never the bytes.

    The image is multi-megabyte and lives in its own table; clients fetch it
    from the receipt-photo endpoint only when they display it.
    """
    if receipt is None:
        return None
    return {
        "photo_name": receipt.get("photo_name"),
        "total_weight_kg": receipt.get("total_weight_kg"),
        "weight_source": receipt.get("weight_source"),
        "submitted_by": receipt.get("submitted_by"),
        "recorded_at": receipt.get("recorded_at"),
        "has_photo": bool(receipt.get("has_photo")),
    }


def _spj_payload(spj) -> dict[str, Any]:
    """Detail projection: receipt metadata plus a media reference, no bytes.

    The receipt image is multi-megabyte; clients fetch it from the
    receipt-photo endpoint only when they display it.
    """
    payload = _asdict(spj)
    payload["receipt"] = _receipt_payload(payload.get("receipt"))
    return payload


def _spj_or_409(fn, *args, **kwargs):
    try:
        return _spj_payload(fn(*args, **kwargs))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except StorageError as exc:
        # A mutation that never reached the durable store must not look like
        # success — the caller has to know the write did not commit.
        logger.error("SPJ persistence failure: %s", exc)
        raise HTTPException(
            status_code=503, detail="SPJ storage is unavailable; the change was not saved."
        ) from exc


@router.get("/api/spj")
def list_spj(status: str | None = None) -> dict[str, Any]:
    items = SPJ_STORE.list(status=status)
    return {"spj": [spj_summary_payload(s) for s in items], "count": len(items)}


@router.get("/api/spj/active-path/{truck_code}")
def spj_active_path_endpoint(truck_code: str) -> dict[str, Any]:
    spj = SPJ_STORE.active_for_truck(truck_code)
    path = spj_active_path(truck_code)
    return {
        "truck_code": truck_code,
        "has_active_spj": spj is not None,
        "has_reference_path": path is not None,
        "destination": spj.destination if spj is not None else None,
        "destination_provenance": (destination_provenance(spj.destination) if spj is not None else None),
        "path": [{"lat": lat, "lng": lng} for lat, lng in (path or [])],
    }


@router.get("/api/spj/destinations")
def spj_destinations() -> dict[str, Any]:
    """Every disposal destination with its coordinate provenance.

    `usable_for_routing` is false when no sourced coordinate exists, so a client
    can see that an active SPJ to that destination has no verified reference
    path instead of assuming the last polyline vertex is the facility.
    """
    return {"destinations": [destination_provenance(d) for d in DESTINATIONS]}


@router.get("/api/spj/{spj_id}")
def get_spj(spj_id: str) -> dict[str, Any]:
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} not found")
    return _spj_payload(spj)


@router.post("/api/spj", status_code=201)
def create_spj(
    body: SpjCreateBody, _role: str = Depends(require_permission("dispatch:create"))
) -> dict[str, Any]:
    if body.stops is None:
        return _spj_or_409(
            SPJ_STORE.create,
            body.driver_name,
            body.truck_code,
            body.destination,
            body.weigh_on_site,
            body.priority,
            body.note,
        )
    # #60: atomic composed create — SPJ + all stops in one transaction.
    return _spj_or_409(
        SPJ_STORE.create_with_stops,
        body.driver_name,
        body.truck_code,
        body.destination,
        body.weigh_on_site,
        body.priority,
        body.note,
        [s.model_dump() for s in body.stops],
    )


@router.post("/api/spj/{spj_id}/stops")
def add_spj_stop(
    spj_id: str, body: SpjStopBody, _role: str = Depends(require_permission("dispatch:create"))
) -> dict[str, Any]:
    return _spj_or_409(
        SPJ_STORE.add_stop,
        spj_id,
        body.name,
        body.kecamatan,
        body.address,
        body.lat,
        body.lng,
        body.location_type,
    )


def _override_payload(body: SpjCompleteBody | None, actor: str, required: bool = False) -> dict | None:
    """Normalize the optional override block; None when the caller sent none."""
    override = getattr(body, "override", None)
    if override is None:
        if required:
            raise HTTPException(
                status_code=409,
                detail="completing an order without field evidence requires a "
                "supervisor override with a reason",
            )
        return None
    return {"reason": override.reason, "documents": override.documents, "actor": actor}


@router.post("/api/spj/{spj_id}/activate")
def activate_spj(spj_id: str, _role: str = Depends(require_permission("dispatch:create"))) -> dict[str, Any]:
    result = _spj_or_409(SPJ_STORE.activate, spj_id)
    _refresh_fleet_caches()
    return result


@router.post("/api/spj/{spj_id}/stops/{index}/complete")
def complete_spj_stop(
    spj_id: str,
    index: int,
    body: SpjCompleteBody | None = None,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """Close one stop. Requires field evidence, or an explicit supervisor override."""
    override = _override_payload(body, _role)
    result = _spj_or_409(
        SPJ_STORE.complete_stop, spj_id, index, (body.evidence if body else None), override, _role
    )
    _refresh_fleet_caches()
    return result


@router.post("/api/spj/{spj_id}/complete")
def complete_spj(
    spj_id: str,
    body: SpjCompleteOverrideBody | None = None,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """Close an SPJ. Normal completion needs full field evidence; an
    override requires the spj:override permission and a reason, and is
    written to the SPJ audit trail."""
    body = body or SpjCompleteOverrideBody()
    override = None
    if body.override:
        # Re-gate the request: only supervisor/administrator may override.
        if not has_permission(_role, "spj:override"):
            raise HTTPException(status_code=403, detail=f"Role '{_role}' lacks spj:override permission.")
        reason = body.reason.strip()
        if len(reason) < 10:
            raise HTTPException(
                status_code=409, detail="override requires a reason of at least 10 characters"
            )
        override = {"actor": _role, "reason": reason}
    result = _spj_or_409(SPJ_STORE.complete, spj_id, override)
    _refresh_fleet_caches()
    if override is not None:
        history_store.record_event(
            "spj_completed_by_override",
            {
                "spj_id": spj_id,
                "actor": override["actor"],
                "reason": override["reason"],
            },
        )
    return result


@router.get("/api/spj/{spj_id}/audit")
def spj_audit(
    spj_id: str,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create", "history:read")),
) -> dict[str, Any]:
    """Audit trail for one SPJ: lifecycle actions and supervisor overrides."""
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} not found")
    return {"spj_id": spj_id, "audit": SPJ_STORE.audit_log(spj_id)}


@router.post("/api/spj/{spj_id}/cancel")
def cancel_spj(spj_id: str, _role: str = Depends(require_permission("dispatch:create"))) -> dict[str, Any]:
    result = _spj_or_409(SPJ_STORE.cancel, spj_id)
    _refresh_fleet_caches()
    return result


@router.get("/api/spj/{spj_id}/evidence-summary")
def spj_evidence_summary(spj_id: str) -> dict[str, Any]:
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} not found")
    stops = []
    for i, stop in enumerate(spj.stops):
        ev = stop.evidence or {}
        weighing = ev.get("weighing") or []
        total = round(sum(float(w.get("weight_kg") or 0) for w in weighing), 1)
        fractions: dict[str, float] = {}
        for w in weighing:
            key = w.get("fraction") or "Lainnya"
            fractions[key] = round(fractions.get(key, 0.0) + float(w.get("weight_kg") or 0), 1)
        stops.append(
            {
                "index": i,
                "name": stop.name,
                "status": stop.status,
                "has_arrival": bool((ev.get("arrival") or {}).get("photo_name")),
                "weighing_count": len(weighing),
                "total_weight_kg": total,
                "fractions": fractions,
                "officer_name": (ev.get("officer") or {}).get("name"),
                "override": stop.override,
            }
        )
    return {
        "spj_id": spj_id,
        "stops": stops,
        "receipt": _receipt_payload(spj.receipt) if spj.receipt else None,
        "complete": all(s["has_arrival"] for s in stops) and len(stops) > 0,
    }


@router.post("/api/spj/{spj_id}/receipt", status_code=201)
def submit_spj_receipt(
    spj_id: str,
    body: SpjReceiptBody,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """Record the weighbridge receipt once (#52 + PR #90 #56).

    Replaying the same operation_id is a no-op retry (still 201 — the
    stored receipt is returned unchanged); a different submission for an
    SPJ that already has a receipt is a conflict, so a double tap or a
    second browser cannot silently replace handover evidence.
    """
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} not found")
    already_recorded = spj.receipt is not None
    _spj_or_409(
        SPJ_STORE.record_receipt,
        spj_id,
        body.photo_name,
        body.photo_b64,
        body.total_weight_kg,
        body.weight_source,
        _role,
        body.operation_id,
    )
    if not already_recorded:  # a replayed operation_id is not a second event
        history_store.record_event(
            "spj_receipt_submitted",
            {
                "spj_id": spj_id,
                "spj_number": spj.spj_number,
                "photo_name": body.photo_name,
                "total_weight_kg": body.total_weight_kg,
                "weight_source": body.weight_source,
                "submitted_by": _role,
            },
        )
    return {"status": "recorded", "spj_id": spj_id}


@router.get("/api/spj/{spj_id}/receipt/photo")
def spj_receipt_photo(
    spj_id: str,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create", "history:read")),
) -> dict[str, Any]:
    """Retrieval path for the stored receipt image (kept out of detail reads)."""
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} not found")
    photo = SPJ_STORE.receipt_photo(spj_id)
    if not photo:
        raise HTTPException(status_code=404, detail="no receipt photo recorded")
    return {"spj_id": spj_id, "photo_b64": photo}
