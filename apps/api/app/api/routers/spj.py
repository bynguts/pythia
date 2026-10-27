"""SPJ (Surat Perintah Jalan) work orders: lifecycle, evidence and receipts."""

from __future__ import annotations

import base64
import binascii
import io
import logging
import re
from dataclasses import asdict as _asdict
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.api.deps import (
    ensure_truck_access,
    require_any_principal,
    require_permission,
)
from app.api.routers.safety import enforce_duty_limit
from app.api.schemas import (
    MAX_RECEIPT_WEIGHT_KG,
    SpjCompleteBody,
    SpjCompleteOverrideBody,
    SpjCreateBody,
    SpjReceiptBody,
    SpjStopBody,
)
from app.api.state import _refresh_fleet_caches, history_store
from app.core.auth import has_permission
from app.core.storage import StorageError
from app.field import timbangan_ocr
from app.field.receipt_checks import checks_for
from app.field.spj import (
    SPJ_STORE,
    arrival_geotag,
    destination_provenance,
    evidence_photo_slots,
    receipt_ocr_record,
    spj_summary_payload,
)
from app.field.spj import active_path_for as spj_active_path
from app.fleet.facilities import DESTINATIONS

router = APIRouter()
logger = logging.getLogger(__name__)

# Gap 7: SPJ records name drivers and TPS officers and hold their photos, so
# every read needs a session. Drivers read through their field token; a
# personal driver account (PYTHIA_USERS_FILE with a truck_code) sees only its truck.
READ_PERMISSIONS = ("dashboard:read", "dispatch:create", "dispatch:confirm", "history:read")
# Evidence photos show faces: operators, auditors and the driver who took them.
EVIDENCE_PERMISSIONS = ("dispatch:confirm", "dispatch:create", "history:read")
# Reviewing a receipt weight: dispatchers, supervisors and administrators. The
# driver who submitted the receipt (dispatch:confirm only) cannot sign it off.
RECEIPT_REVIEW_PERMISSION = "dispatch:create"

# H10: what each receipt weight means. The weighbridge weighs the loaded truck.
RECEIPT_WEIGHT_LABELS = {
    "gross_weight_kg": "Gross: loaded truck on the weighbridge (includes the truck's tare)",
    "tare_weight_kg": "Tare: the empty truck",
    "net_weight_kg": "Net: gross minus tare, the waste actually delivered",
}

_SAFE_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")
_THUMB_SIZE = (320, 320)
# The driver app downsizes photos before upload; an image above this is never
# decoded for a thumbnail (the stored original is served instead).
_MAX_IMAGE_PIXELS = 40_000_000


class SpjReceiptTareBody(SpjReceiptBody):
    """Receipt body plus the optional tare, so the server can store the net weight."""

    tare_weight_kg: float | None = Field(
        default=None,
        gt=0,
        le=MAX_RECEIPT_WEIGHT_KG,
        allow_inf_nan=False,
        description="Empty-truck weight in kg; with it the receipt stores net = gross - tare.",
    )


class SpjReceiptReviewBody(BaseModel):
    """confirm: record the OCR gross. correct: record the weights typed here."""

    action: Literal["confirm", "correct"]
    gross_weight_kg: float | None = Field(default=None, gt=0, le=MAX_RECEIPT_WEIGHT_KG, allow_inf_nan=False)
    tare_weight_kg: float | None = Field(default=None, gt=0, le=MAX_RECEIPT_WEIGHT_KG, allow_inf_nan=False)


def _receipt_payload(receipt, spj=None) -> dict[str, Any] | None:
    """Receipt projection: metadata plus a retrieval reference, never the bytes.

    The image is multi-megabyte and lives in its own table; clients fetch it
    from the receipt-photo endpoint only when they display it. With ``spj`` it
    also carries ``checks``: rule checks of the receipt against its work order,
    the truck capacity and the sealed audit trail (app.field.receipt_checks).
    """
    if receipt is None:
        return None
    gross = receipt.get("gross_weight_kg")
    return {
        "photo_name": receipt.get("photo_name"),
        # Legacy name for the gross weight; kept so existing clients keep working.
        "total_weight_kg": receipt.get("total_weight_kg"),
        "gross_weight_kg": gross if gross is not None else receipt.get("total_weight_kg"),
        "tare_weight_kg": receipt.get("tare_weight_kg"),
        "net_weight_kg": receipt.get("net_weight_kg"),
        "weight_labels": RECEIPT_WEIGHT_LABELS,
        "weight_source": receipt.get("weight_source"),
        "submitted_by": receipt.get("submitted_by"),
        "recorded_at": receipt.get("recorded_at"),
        "has_photo": bool(receipt.get("has_photo")),
        # MODEL OUTPUT suggestion (status pending | unavailable | unreviewed |
        # confirmed | corrected); the weights above are only what was recorded.
        "ocr": receipt.get("ocr"),
        "checks": checks_for(SPJ_STORE, spj) if spj is not None else None,
    }


def _spj_payload(spj) -> dict[str, Any]:
    """Detail projection: metadata and media references, never image bytes.

    Evidence photos carry a ``photo_ref`` served by /api/spj/{id}/evidence/{n};
    the receipt image by /api/spj/{id}/receipt/photo. Each stop gains ``geotag``
    (GPS vs "Approximate, not GPS", accuracy, distance to the stop).
    """
    payload = _asdict(spj)
    payload["receipt"] = _receipt_payload(payload.get("receipt"), spj)
    for stop_payload, stop in zip(payload["stops"], spj.stops, strict=True):
        for _slot, record in evidence_photo_slots(stop_payload.get("evidence") or {}):
            record.pop("photo_b64", None)  # belt and braces: the store keeps none
        stop_payload["geotag"] = arrival_geotag(stop)
    return payload


def _readable_spj(spj_id: str, principal: dict):
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} not found")
    ensure_truck_access(principal, spj.truck_code)
    return spj


def _stop_photos(stop) -> list[dict[str, Any]]:
    return [
        {"n": record["photo_ref"], "slot": slot, "photo_name": record.get("photo_name")}
        for slot, record in evidence_photo_slots(stop.evidence or {})
        if isinstance(record.get("photo_ref"), int)
    ]


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
def list_spj(
    status: str | None = None,
    truck_code: str | None = None,
    limit: int | None = Query(default=None, ge=1, le=500),
    principal: dict = Depends(require_any_principal(*READ_PERMISSIONS)),
) -> dict[str, Any]:
    """SPJ summaries, newest first, without evidence or route geometry.

    ``truck_code`` and ``limit`` (newest N after filtering) keep a driver's poll
    small: ``/api/spj?status=selesai&truck_code=T-088&limit=5``. A truck-bound
    driver account is always filtered to its own truck.
    """
    bound = principal.get("truck_code") if principal["role"] == "driver" else None
    if bound:
        ensure_truck_access(principal, truck_code or bound)
        truck_code = bound
    items = SPJ_STORE.list(status=status, truck_code=truck_code, limit=limit)
    return {"spj": [spj_summary_payload(s) for s in items], "count": len(items)}


@router.get("/api/spj/active-path/{truck_code}")
def spj_active_path_endpoint(
    truck_code: str, principal: dict = Depends(require_any_principal(*READ_PERMISSIONS))
) -> dict[str, Any]:
    ensure_truck_access(principal, truck_code)
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
def get_spj(
    spj_id: str, principal: dict = Depends(require_any_principal(*READ_PERMISSIONS))
) -> dict[str, Any]:
    return _spj_payload(_readable_spj(spj_id, principal))


@router.post("/api/spj", status_code=201)
def create_spj(
    body: SpjCreateBody, principal: dict = Depends(require_any_principal("dispatch:create"))
) -> dict[str, Any]:
    enforce_duty_limit(body.truck_code, "create")  # R6 driver duty-hour guard
    if body.stops is None:
        return _spj_or_409(
            SPJ_STORE.create,
            body.driver_name,
            body.truck_code,
            body.destination,
            body.weigh_on_site,
            body.priority,
            body.note,
            created_by=principal["username"],
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
        created_by=principal["username"],
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
        body.demo,
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
def activate_spj(
    spj_id: str, principal: dict = Depends(require_any_principal("dispatch:create"))
) -> dict[str, Any]:
    draft = SPJ_STORE.get(spj_id)
    if draft is not None:
        enforce_duty_limit(draft.truck_code, "activate")  # R6 driver duty-hour guard
    result = _spj_or_409(SPJ_STORE.activate, spj_id, principal["username"])
    _refresh_fleet_caches()
    return result


class SpjStopSkipBody(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


@router.post("/api/spj/{spj_id}/stops/{index}/skip")
def skip_spj_stop(
    spj_id: str,
    index: int,
    body: SpjStopSkipBody,
    principal: dict = Depends(require_any_principal("dispatch:create")),
) -> dict[str, Any]:
    """Dispatch skips a stop it will not collect (wave 13), e.g. a TPS reported empty.

    The stop becomes ``skipped``: not collected and never counted as completed.
    409 when the stop is already completed or the SPJ is not active.
    """
    result = _spj_or_409(SPJ_STORE.skip_stop, spj_id, index, body.reason, principal["username"])
    history_store.record_event(
        "spj_stop_skipped",
        {
            "spj_id": spj_id,
            "stop_index": index,
            "actor": principal["username"],
            "reason": body.reason.strip(),
        },
    )
    return result


@router.post("/api/spj/{spj_id}/stops/{index}/complete")
def complete_spj_stop(
    spj_id: str,
    index: int,
    body: SpjCompleteBody | None = None,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """Close one stop. Requires field evidence, or an explicit supervisor override.

    Gap 4: the override closes a stop without evidence and skips the route order,
    so it needs ``spj:override`` (supervisor, administrator), exactly like the
    SPJ-level override; a driver or dispatcher gets 403.
    """
    if (
        body is not None
        and body.override is not None
        and not has_permission(principal["role"], "spj:override")
    ):
        raise HTTPException(
            status_code=403, detail=f"Role '{principal['role']}' lacks spj:override permission."
        )
    spj = SPJ_STORE.get(spj_id)
    if spj is not None:
        ensure_truck_access(principal, spj.truck_code)
    override = _override_payload(body, principal["username"])
    result = _spj_or_409(
        SPJ_STORE.complete_stop,
        spj_id,
        index,
        (body.evidence if body else None),
        override,
        principal["username"],
    )
    _refresh_fleet_caches()
    return result


@router.post("/api/spj/{spj_id}/complete")
def complete_spj(
    spj_id: str,
    body: SpjCompleteOverrideBody | None = None,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """Close an SPJ. Normal completion needs full field evidence; an
    override requires the spj:override permission and a reason, and is
    written to the SPJ audit trail."""
    body = body or SpjCompleteOverrideBody()
    role = principal["role"]
    override = None
    if body.override:
        # Re-gate the request: only supervisor/administrator may override.
        if not has_permission(role, "spj:override"):
            raise HTTPException(status_code=403, detail=f"Role '{role}' lacks spj:override permission.")
        reason = body.reason.strip()
        if len(reason) < 10:
            raise HTTPException(
                status_code=409, detail="override requires a reason of at least 10 characters"
            )
        override = {"actor": principal["username"], "reason": reason}
    result = _spj_or_409(SPJ_STORE.complete, spj_id, override, principal["username"])
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
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create", "history:read")),
) -> dict[str, Any]:
    """Audit trail for one SPJ: lifecycle actions and supervisor overrides.

    `plan_events` (wave 13) adds, for an SPJ drafted from a plan, the plan's
    proposal and approval and its dispatch to the truck (sent, confirmed), from
    the plan and dispatch stores; it is empty for any other SPJ.
    """
    spj = _readable_spj(spj_id, principal)
    return {"spj_id": spj_id, "audit": SPJ_STORE.audit_log(spj_id), "plan_events": _plan_events(spj)}


@router.get("/api/spj/{spj_id}/integrity")
def spj_integrity(
    spj_id: str,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create", "history:read")),
) -> dict[str, Any]:
    """Re-verify the SPJ's sealed audit trail and its receipt on every read.

    ``chain_ok`` is false when any audit row was edited, removed from the middle
    or written without its seal; ``receipt_photo_ok`` / ``receipt_weights_ok`` are
    false when the stored receipt no longer matches what was sealed (null without
    a receipt, or for one recorded before sealing). ``problems`` names each failure.
    """
    _readable_spj(spj_id, principal)
    return SPJ_STORE.verify(spj_id)


def _plan_events(spj) -> list[dict[str, Any]]:
    from app.api.state import _OPERATIONS_PLAN_STORE

    link = next(
        (
            row
            for plan_id in [spj.note[len("Rencana ") :].split(" ", 1)[0]]
            if spj.note.startswith("Rencana ")
            for row in _OPERATIONS_PLAN_STORE.spj_links(plan_id)
            if row["spj_id"] == spj.spj_id
        ),
        None,
    )
    if link is None:
        return []
    plan = _OPERATIONS_PLAN_STORE.get(link["plan_id"]) or {}
    events = [
        {"action": "plan_proposed", "actor": plan.get("proposed_by"), "created_at": plan.get("created_at")},
        {"action": "plan_approved", "actor": plan.get("approved_by"), "created_at": plan.get("approved_at")},
    ]
    dispatch = history_store.get_dispatch(link["dispatch_id"]) if link.get("dispatch_id") else None
    if dispatch:
        events.append(
            {"action": "dispatch_sent", "actor": "operations_optimizer", "created_at": dispatch["created_at"]}
        )
        if dispatch.get("confirmed_at"):
            events.append(
                {
                    "action": "dispatch_confirmed",
                    "actor": spj.truck_code,
                    "created_at": dispatch["confirmed_at"],
                    "status": dispatch["field_status"],
                }
            )
    return [{**e, "plan_id": link["plan_id"]} for e in events if e["created_at"]]


@router.post("/api/spj/{spj_id}/cancel")
def cancel_spj(
    spj_id: str, principal: dict = Depends(require_any_principal("dispatch:create"))
) -> dict[str, Any]:
    result = _spj_or_409(SPJ_STORE.cancel, spj_id, principal["username"])
    _refresh_fleet_caches()
    return result


@router.get("/api/spj/{spj_id}/evidence-summary")
def spj_evidence_summary(
    spj_id: str, principal: dict = Depends(require_any_principal(*READ_PERMISSIONS))
) -> dict[str, Any]:
    """Per-stop evidence for review: counts, kg, officer, photo references and the geotag.

    ``geotag.status`` is ``approx`` (label "Approximate, not GPS") when the phone had
    no position fix and the stop's own coordinates were stored; ``flagged`` marks an
    approximate geotag or a GPS fix more than 150 m from the stop.
    """
    spj = _readable_spj(spj_id, principal)
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
                "weighing_required": spj.weigh_on_site,
                "photos": _stop_photos(stop),
                "geotag": arrival_geotag(stop),
            }
        )
    return {
        "spj_id": spj_id,
        "weigh_on_site": spj.weigh_on_site,
        "stops": stops,
        "receipt": _receipt_payload(spj.receipt, spj) if spj.receipt else None,
        "complete": all(s["has_arrival"] for s in stops) and len(stops) > 0,
    }


def _run_receipt_ocr(spj_id: str) -> None:
    """Read the receipt photo after the POST has answered, and file the result.

    The OCR is a remote vision call (up to 15 s), so it never runs inside the
    request. Every failure is a normal outcome: ``status`` "unavailable" with a reason.
    """
    try:
        photo = SPJ_STORE.receipt_photo(spj_id)
        if not photo:
            ocr = receipt_ocr_record("unavailable", "no receipt photo is stored")
        else:
            image = photo if photo.startswith("data:") else f"data:image/jpeg;base64,{photo}"
            result = timbangan_ocr.read_weight_from_photo(image)
            if result.get("document") == "not_a_ticket":
                ocr = receipt_ocr_record("unavailable", "the photo is not a weighbridge ticket", result)
            elif result.get("gross_kg") is not None or result.get("weight_kg") is not None:
                ocr = receipt_ocr_record("unreviewed", result=result)
            elif result.get("confidence") == "failed":
                ocr = receipt_ocr_record(
                    "unavailable", result.get("raw_text") or "OCR request failed", result
                )
            else:
                ocr = receipt_ocr_record("unavailable", "no legible weight on the ticket photo", result)
        SPJ_STORE.set_receipt_ocr(spj_id, ocr)
    except Exception:  # noqa: BLE001 - the receipt is recorded; only the suggestion is lost
        logger.exception("receipt OCR failed for SPJ %s", spj_id)
        try:
            SPJ_STORE.set_receipt_ocr(spj_id, receipt_ocr_record("unavailable", "OCR failed on the server"))
        except Exception:  # noqa: BLE001
            logger.exception("could not file the receipt OCR outcome for SPJ %s", spj_id)


@router.post("/api/spj/{spj_id}/receipt", status_code=201)
def submit_spj_receipt(
    spj_id: str,
    body: SpjReceiptTareBody,
    background_tasks: BackgroundTasks,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """Record the weighbridge receipt once (#52 + PR #90 #56).

    Replaying the same operation_id is a no-op retry (still 201 — the
    stored receipt is returned unchanged); a different submission for an
    SPJ that already has a receipt is a conflict, so a double tap or a
    second browser cannot silently replace handover evidence.

    ``total_weight_kg`` is the GROSS weight the weighbridge shows; send
    ``tare_weight_kg`` too and the receipt stores ``net_weight_kg`` (H10).

    The weighbridge-ticket OCR then reads the photo in the background. Its
    reading lands in ``receipt.ocr`` (MODEL OUTPUT, ``status`` "pending" until it
    finishes, "unavailable" without an OCR engine) and never becomes a recorded
    weight until a reviewer confirms it (POST .../receipt/review).
    """
    spj = _readable_spj(spj_id, principal)
    actor = principal["username"]
    already_recorded = spj.receipt is not None
    ocr_ready = timbangan_ocr.is_configured()
    ocr = (
        receipt_ocr_record("pending")
        if ocr_ready
        else receipt_ocr_record("unavailable", "no ticket OCR engine is configured on this server")
    )
    recorded = _spj_or_409(
        SPJ_STORE.record_receipt,
        spj_id,
        body.photo_name,
        body.photo_b64,
        body.total_weight_kg,
        body.weight_source,
        actor,
        body.operation_id,
        body.tare_weight_kg,
        ocr,
    )
    if not already_recorded:  # a replayed operation_id is not a second event
        if ocr_ready:
            background_tasks.add_task(_run_receipt_ocr, spj_id)
        history_store.record_event(
            "spj_receipt_submitted",
            {
                "spj_id": spj_id,
                "spj_number": spj.spj_number,
                "photo_name": body.photo_name,
                "total_weight_kg": body.total_weight_kg,
                "tare_weight_kg": body.tare_weight_kg,
                "weight_source": body.weight_source,
                "submitted_by": actor,
            },
        )
    # The stored weights (gross, tare, net and their labels) come back so the
    # driver's done screen shows what the server recorded, never a phone-side sum.
    return {"status": "recorded", "spj_id": spj_id, "receipt": recorded["receipt"]}


@router.get("/api/spj/{spj_id}/receipt/photo")
def spj_receipt_photo(
    spj_id: str,
    principal: dict = Depends(require_any_principal(*EVIDENCE_PERMISSIONS)),
) -> dict[str, Any]:
    """Retrieval path for the stored receipt image (kept out of detail reads)."""
    _readable_spj(spj_id, principal)
    photo = SPJ_STORE.receipt_photo(spj_id)
    if not photo:
        raise HTTPException(status_code=404, detail="no receipt photo recorded")
    return {"spj_id": spj_id, "photo_b64": photo}


@router.post("/api/spj/{spj_id}/receipt/review")
def review_spj_receipt(
    spj_id: str,
    body: SpjReceiptReviewBody,
    principal: dict = Depends(require_any_principal(RECEIPT_REVIEW_PERMISSION)),
) -> dict[str, Any]:
    """Sign off a receipt's weights once: ``confirm`` the OCR reading or ``correct`` it.

    The OCR suggestion stays on the receipt for audit; the previous weights and
    the reviewer are written to the SPJ audit trail and the history log.
    """
    spj = _readable_spj(spj_id, principal)
    if spj.receipt is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} has no receipt to review")
    actor = principal["username"]
    reviewed = _spj_or_409(
        SPJ_STORE.review_receipt,
        spj_id,
        body.action,
        actor,
        body.gross_weight_kg,
        body.tare_weight_kg,
    )
    receipt = reviewed["receipt"]
    history_store.record_event(
        "spj_receipt_reviewed",
        {
            "spj_id": spj_id,
            "spj_number": spj.spj_number,
            "action": body.action,
            "reviewed_by": actor,
            "gross_weight_kg": receipt["gross_weight_kg"],
            "tare_weight_kg": receipt["tare_weight_kg"],
            "net_weight_kg": receipt["net_weight_kg"],
            "ocr_gross_kg": (receipt["ocr"] or {}).get("gross_kg"),
        },
    )
    return {"status": receipt["ocr"]["status"], "spj_id": spj_id, "receipt": receipt}


@router.get("/api/spj/{spj_id}/receipt/thumb")
def spj_receipt_thumbnail(
    spj_id: str, principal: dict = Depends(require_any_principal(*EVIDENCE_PERMISSIONS))
) -> Response:
    """The receipt photo as a 320 px JPEG for the review row; the original when it cannot be resized."""
    _readable_spj(spj_id, principal)
    photo = SPJ_STORE.receipt_photo(spj_id)
    if not photo:
        raise HTTPException(status_code=404, detail="no receipt photo recorded")
    raw, media_type = _decode_image(photo)
    small = _thumbnail(raw)
    variant = "original"
    if small is not None:
        raw, media_type, variant = small, "image/jpeg", "thumbnail"
    return Response(
        content=raw,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "X-Pythia-Image-Variant": variant,
        },
    )


def _decode_image(stored: str) -> tuple[bytes, str]:
    """Stored evidence (a data URL or bare base64) -> (bytes, a safe image media type)."""
    header, sep, data = stored.partition(",")
    if not sep:
        header, data = "", stored
    match = re.match(r"data:([\w/+.-]+)", header.strip())
    declared = match.group(1).lower() if match else ""
    try:
        raw = base64.b64decode(data.strip() + "=" * (-len(data.strip()) % 4))
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="stored evidence is not decodable base64") from None
    if declared in _SAFE_IMAGE_TYPES:
        return raw, declared
    # Never echo an arbitrary declared type (text/html would render on the API origin).
    if raw.startswith(b"\xff\xd8"):
        return raw, "image/jpeg"
    if raw.startswith(b"\x89PNG"):
        return raw, "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return raw, "image/webp"
    return raw, "application/octet-stream"


def _thumbnail(raw: bytes) -> bytes | None:
    """A JPEG thumbnail (long side 320 px) when Pillow is installed, else None."""
    try:
        from PIL import Image  # optional: not in requirements.txt
    except ImportError:
        return None
    # Decompression bombs: Pillow refuses past 2x this; the size check below refuses past 1x.
    Image.MAX_IMAGE_PIXELS = _MAX_IMAGE_PIXELS
    try:
        with Image.open(io.BytesIO(raw)) as image:
            # open() reads only the header; refuse before load() allocates the pixels.
            width, height = image.size
            if width * height > _MAX_IMAGE_PIXELS:
                return None
            image.thumbnail(_THUMB_SIZE)
            out = io.BytesIO()
            image.convert("RGB").save(out, format="JPEG", quality=70)
            return out.getvalue()
    except Exception:  # noqa: BLE001 - an undecodable image falls back to the original
        return None


def _evidence_response(spj_id: str, n: int, principal: dict, thumb: bool) -> Response:
    _readable_spj(spj_id, principal)
    photo = SPJ_STORE.evidence_photo(spj_id, n)
    if photo is None:
        raise HTTPException(status_code=404, detail=f"SPJ {spj_id} has no evidence photo {n}")
    raw, media_type = _decode_image(photo["photo_b64"])
    variant = "original"
    if thumb:
        small = _thumbnail(raw)
        if small is not None:
            raw, media_type, variant = small, "image/jpeg", "thumbnail"
    return Response(
        content=raw,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "X-Pythia-Evidence-Slot": f"stop-{photo['stop_idx']}/{photo['slot']}",
            "X-Pythia-Image-Variant": variant,
        },
    )


@router.get("/api/spj/{spj_id}/evidence/{n}")
def spj_evidence_photo(
    spj_id: str, n: int, principal: dict = Depends(require_any_principal(*EVIDENCE_PERMISSIONS))
) -> Response:
    """One evidence photo as an image (gap 8). ``n`` is the ``photo_ref`` on the stop evidence."""
    return _evidence_response(spj_id, n, principal, thumb=False)


@router.get("/api/spj/{spj_id}/evidence/{n}/thumb")
def spj_evidence_thumbnail(
    spj_id: str, n: int, principal: dict = Depends(require_any_principal(*EVIDENCE_PERMISSIONS))
) -> Response:
    """A JPEG thumbnail of one evidence photo; the original when it cannot be resized.

    ``X-Pythia-Image-Variant`` says which one was served (``thumbnail`` | ``original``).
    """
    return _evidence_response(spj_id, n, principal, thumb=True)
