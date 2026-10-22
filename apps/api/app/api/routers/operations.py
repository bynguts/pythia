"""Operations plans (forecast -> dispatch bridge), stagger simulator, TPA queue, event permits."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import require_permission
from app.api.routers.forecast import predictions_kecamatan
from app.api.schemas import EventPermitRequest
from app.api.state import _OPERATIONS_PLAN_STORE, _tpa_cache, dispatch_center, history_store
from app.core.units import (
    TRUCK_CAPACITY_TONS,
    event_tons_for_attendance,
    resource_basis,
    resource_requirements,
)
from app.field.permits import PERMIT_STORE
from app.fleet.data import TRUCKS, events_permits_payload, tpa_queue_status_payload
from app.fleet.operations_optimizer import Demand, Vehicle, build_operational_plan
from app.forecast.engine import simulate_staggered_dispatch
from app.forecast.real_data import load_kecamatan_map

router = APIRouter()


def _reload_operations_plans() -> None:
    """Re-read plan state from durable storage (restart / other worker)."""
    _OPERATIONS_PLAN_STORE.reload_cache()


@router.post("/api/operations/plan")
def create_operations_plan(
    rainfall_mm: float = 0.0,
    event_attendance: int = 0,
    is_weekend: bool = False,
    top_n: int = 5,
    event_lat: float | None = Query(
        None, ge=-90, le=90, description="Event latitude; localizes attendance demand"
    ),
    event_lng: float | None = Query(
        None, ge=-180, le=180, description="Event longitude; localizes attendance demand"
    ),
    _role: str = Depends(require_permission("operations:plan")),
) -> dict[str, Any]:
    """Build a dispatch plan from forecast hotspots + real fleet via CP-SAT.

    The event location is part of the scenario: when `event_lat`/`event_lng`
    are supplied with a non-zero attendance, the same coordinate the map uses
    localizes the demand, so two different event sites no longer produce an
    identical plan.
    """
    preds = predictions_kecamatan(
        rainfall_mm=rainfall_mm,
        event_attendance=event_attendance,
        is_weekend=is_weekend,
        event_lat=event_lat,
        event_lng=event_lng,
    )
    hotspots = preds["top_hotspots"][:top_n]
    demands = [
        Demand(
            area=h["slug"],
            tons=float(h["predicted_tons"]),
            lat=float(h.get("lat") or 0.0),
            lng=float(h.get("lng") or 0.0),
            priority=rank,
        )
        for rank, h in enumerate(reversed(hotspots), start=1)
    ]
    vehicles = [
        Vehicle(
            truck_code=t["truck_code"],
            capacity_tons=TRUCK_CAPACITY_TONS,
            available=not t["is_damaged"],
            permit_compliant=not t["deviation"]["violated"],
        )
        for t in TRUCKS
    ]
    plan = build_operational_plan(demands, vehicles)
    # The stored scenario is the full normalized input, not just the subset the
    # optimizer happened to use, so an approved plan can be reproduced exactly.
    scenario = {
        "rainfall_mm": rainfall_mm,
        "event_attendance": event_attendance,
        "is_weekend": is_weekend,
        "event_lat": event_lat,
        "event_lng": event_lng,
        "top_n": top_n,
        "targeted_kecamatan": preds["scenario"]["targeted_kecamatan"],
        "top_kecamatan": [h["slug"] for h in hotspots],
        "total_predicted_tons": preds["total_predicted_tons"],
        "kecamatan_count": preds["kecamatan_count"],
    }
    payload = {
        "plan_id": plan.plan_id,
        "status": "proposed",
        "assignments": [
            {
                "truck_code": a.truck_code,
                "area": a.area,
                "assigned_tons": a.assigned_tons,
                "evidence": a.evidence,
            }
            for a in plan.assignments
        ],
        "unmet_reasons": plan.unmet_reasons,
        "total_demand_tons": plan.total_demand_tons,
        "total_assigned_tons": plan.total_assigned_tons,
        "scenario": scenario,
    }
    payload = _OPERATIONS_PLAN_STORE.save_proposed(plan.plan_id, payload)
    history_store.record_event("operations_plan_created", {"plan_id": plan.plan_id, "scenario": scenario})
    return payload


@router.post("/api/operations/{plan_id}/approve")
def approve_operations_plan(
    plan_id: str, _role: str = Depends(require_permission("operations:approve"))
) -> dict[str, Any]:
    """Approve a plan and push each assignment through the dispatch contract.

    Approval is at-most-once (#17): the status transition and dispatch
    ids commit in one transaction; a retried or concurrent approval
    returns the already-committed result without creating new dispatches.
    """

    def _create_dispatch(assignment):
        return history_store.save_dispatch(
            truck_code=assignment["truck_code"],
            instruction=(
                f"Collect {assignment['assigned_tons']:.0f}t at {assignment['area']} (plan {plan_id})"
            ),
            manager_id="operations_optimizer",
        )

    try:
        plan, created_now = _OPERATIONS_PLAN_STORE.approve(
            plan_id, approved_by=_role, create_dispatch=_create_dispatch
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found.") from None
    if created_now:
        # Mirror the durable dispatch rows into the in-memory dispatch
        # center only AFTER the approval transaction committed.
        dispatch_ids = plan.get("dispatch_ids") or []
        for dispatch in history_store.list_dispatches():
            if dispatch["id"] in dispatch_ids:
                dispatch_center._dispatches.append(dispatch)
        history_store.record_event(
            "operations_plan_approved", {"plan_id": plan_id, "dispatches": len(dispatch_ids)}
        )
    return plan


@router.post("/api/simulator/stagger")
def post_stagger_simulation(
    active_trucks: int | None = Query(None, ge=1, le=5000),
    _role: str = Depends(require_permission("operations:plan")),
) -> dict[str, Any]:
    return simulate_staggered_dispatch(active_trucks)


@router.get("/api/tpa/queue-status")
def get_tpa_queue_status(scenario: str = Query("live", pattern="^(live|peak)$")) -> dict[str, Any]:
    cached = _tpa_cache.get(scenario)
    now = time.time()
    if cached is None or now - cached["ts"] > 5.0:
        cached = {"payload": tpa_queue_status_payload(scenario=scenario), "ts": now}
        _tpa_cache[scenario] = cached
    return cached["payload"]


@router.get("/api/events/permits")
def get_events_permits() -> list[dict[str, Any]]:
    return events_permits_payload() + PERMIT_STORE.list()


@router.post("/api/events/permits", status_code=201)
def submit_event_permit(
    payload: EventPermitRequest, _role: str = Depends(require_permission("operations:plan"))
) -> dict[str, Any]:
    """Case 2 crowd-permit intake: a permit submitted to the authority becomes a
    live scenario — the system estimates waste generation, resource needs, and
    the affected kecamatan, and the permit joins the map's event layer."""
    from app.forecast.engine import _haversine_meters

    tons = event_tons_for_attendance(payload.expected_attendance)
    resources = resource_requirements(tons)
    impact = {
        "predicted_waste_tons": tons,
        "trucks_required": resources["trucks_required"],
        "crews_required": resources["crews_required"],
        "workers_required": resources["workers_required"],
        "man_hours_required": resources["man_hours_required"],
        "bins_required": resources["bins_required"],
        "units": resources["units"],
        "resource_basis": resource_basis(),
    }

    affected = []
    for k in load_kecamatan_map():
        klat, klng = k.get("lat"), k.get("lng")
        if klat is None or klng is None:
            continue
        dist = _haversine_meters((payload.lat, payload.lng), (klat, klng))
        if dist <= 3500.0:
            affected.append({"kecamatan": k["kecamatan"], "slug": k["slug"], "distance_m": round(dist)})
    if not affected:
        nearest = min(
            (k for k in load_kecamatan_map() if k.get("lat") is not None and k.get("lng") is not None),
            key=lambda k: _haversine_meters((payload.lat, payload.lng), (k["lat"], k["lng"])),
            default=None,
        )
        if nearest:
            affected.append(
                {
                    "kecamatan": nearest["kecamatan"],
                    "slug": nearest["slug"],
                    "distance_m": round(
                        _haversine_meters((payload.lat, payload.lng), (nearest["lat"], nearest["lng"]))
                    ),
                }
            )
    affected.sort(key=lambda a: a["distance_m"])

    permit = {
        "id": PERMIT_STORE.next_id(),
        "name": payload.name,
        "permit_number": f"SUBMITTED-{payload.event_date.isoformat()}",
        "location_name": payload.location_name,
        "lat": payload.lat,
        "lng": payload.lng,
        "event_date": payload.event_date.isoformat(),
        "organizer": payload.organizer,
        "expected_attendance": payload.expected_attendance,
        "status": "SUBMITTED",
        "data_class": "USER_SUBMITTED",
        "data_note": "Scenario permit entered via dashboard; not an official DLH/police permit record.",
        **impact,
        "affected_kecamatan": affected,
    }
    PERMIT_STORE.add(permit)
    history_store.record_event(
        "event_permit_submitted",
        {
            "id": permit["id"],
            "name": permit["name"],
            "expected_attendance": permit["expected_attendance"],
            "affected_kecamatan": [a["slug"] for a in affected],
        },
    )
    return {"permit": permit, "impact": impact, "affected_kecamatan": affected}
