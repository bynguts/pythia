"""Operations plans (forecast -> dispatch bridge), stagger simulator, TPA queue, event permits."""

from __future__ import annotations

import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import require_any_permission, require_permission
from app.api.routers.forecast import predictions_kecamatan
from app.api.schemas import EventPermitRequest
from app.api.state import _OPERATIONS_PLAN_STORE, _tpa_cache, dispatch_center, history_store
from app.core.env import today
from app.core.units import (
    TRUCK_CAPACITY_TONS,
    event_tons_for_attendance,
    resource_basis,
    resource_requirements,
)
from app.field.permits import PERMIT_STORE
from app.fleet.data import TRUCKS, events_permits_payload, tpa_queue_status_payload
from app.fleet.operations_optimizer import Demand, Vehicle, build_operational_plan
from app.fleet.operations_rules import PlanningRules, resolve_rules
from app.fleet.queue_simulation import QUEUE_QUANTITIES, QUEUE_STAGE
from app.forecast.engine import simulate_staggered_dispatch
from app.forecast.real_data import load_kecamatan_map

router = APIRouter()


def _reload_operations_plans() -> None:
    """Re-read plan state from durable storage (restart / other worker)."""
    _OPERATIONS_PLAN_STORE.reload_cache()


_ID_MONTHS = ("Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des")


def _id_date(value: date) -> str:
    return f"{value.day} {_ID_MONTHS[value.month - 1]} {value.year}"


def _kecamatan_label(name: str) -> str:
    return " ".join(part.capitalize() for part in str(name).split())


def _dispatch_instructions(
    plan_id: str,
    plan_date: date,
    assignments: list[dict[str, Any]],
    demands: dict[str, Demand],
    rules: PlanningRules,
) -> list[dict[str, Any]]:
    """One dispatch per truck: Indonesian text from a fixed template, plus the
    same content as structured fields (truck, stops, slot, reason) so the driver
    PWA can render it in either language.
    """
    windows = {s["id"]: s.get("window", "") for s in rules.shifts}
    facility_names = {f.name: f.display_name for f in rules.facilities}
    by_truck: dict[str, list[dict[str, Any]]] = {}
    for a in assignments:
        by_truck.setdefault(a["truck_code"], []).append(a)
    out = []
    for truck_code in sorted(by_truck):
        trips = sorted(by_truck[truck_code], key=lambda a: a["trip_index"])
        stops = [
            {
                "order": a["trip_index"],
                "area": a["area"],
                "kecamatan": demands[a["area"]].label,
                "shift": a["shift"],
                "window": windows.get(a["shift"], ""),
                "facility": a["facility"],
                "facility_display": facility_names.get(a["facility"], a["facility"]),
                "tons": a["assigned_tons"],
            }
            for a in trips
        ]
        areas = list(dict.fromkeys(a["area"] for a in trips))
        reason_areas = [
            {"area": area, "kecamatan": demands[area].label, "forecast_tons": round(demands[area].tons, 1)}
            for area in areas
        ]
        lines = [f"Rencana {plan_id} · {_id_date(plan_date)} · Truk {truck_code}"]
        for stop in stops:
            window = f" ({stop['window']})" if stop["window"] else ""
            lines.append(
                f"{stop['order']}. Shift {stop['shift']}{window}: angkut ±{stop['tons']:.0f} t "
                f"dari Kec. {stop['kecamatan']}, bongkar di {stop['facility_display']}"
            )
        forecast = ", ".join(f"Kec. {r['kecamatan']} {r['forecast_tons']:.0f} t/hari" for r in reason_areas)
        lines.append(f"Alasan: prakiraan timbulan {forecast} (keluaran model).")
        out.append(
            {
                "truck_code": truck_code,
                "text": "\n".join(lines),
                "fields": {
                    "template": "plan_dispatch_v1",
                    "locale": "id",
                    "truck_code": truck_code,
                    "plan_id": plan_id,
                    "plan_date": plan_date.isoformat(),
                    "stops": stops,
                    "slot": {"shift": stops[0]["shift"], "window": stops[0]["window"]},
                    "reason": {
                        "code": "forecast_demand",
                        "areas": reason_areas,
                        "classification": "MODEL_OUTPUT",
                    },
                },
            }
        )
    return out


@router.get("/api/operations/rules")
def get_operations_rules(plan_date: date | None = None) -> dict[str, Any]:
    """The quota, gate and facility rules in force on `plan_date`, with sources."""
    return resolve_rules(plan_date or today()).payload()


@router.post("/api/operations/plan")
def create_operations_plan(
    rainfall_mm: float = 0.0,
    event_attendance: int = 0,
    top_n: int = Query(5, ge=1, le=42),
    plan_date: date | None = Query(None, description="Day the plan is for; defaults to today"),
    event_lat: float | None = Query(
        None, ge=-90, le=90, description="Event latitude; localizes attendance demand"
    ),
    event_lng: float | None = Query(
        None, ge=-180, le=180, description="Event longitude; localizes attendance demand"
    ),
    _role: str = Depends(require_permission("operations:plan")),
) -> dict[str, Any]:
    """Build a day plan (truck trips per shift) for the top forecast districts via CP-SAT.

    The weekday or weekend follows from `plan_date`, never from a fixed flag.
    The kecamatan rit quotas, the Bantargebang gate caps and the facility rules
    in force on that date are hard constraints; demand they cannot serve is
    returned as `unassigned_tons` with the limit that binds, not hidden.

    The event location is part of the scenario: when `event_lat`/`event_lng`
    are supplied with a non-zero attendance, the same coordinate the map uses
    localizes the demand, so two different event sites no longer produce an
    identical plan.
    """
    plan_date = plan_date or today()
    is_weekend = plan_date.weekday() >= 5
    preds = predictions_kecamatan(
        rainfall_mm=rainfall_mm,
        event_attendance=event_attendance,
        is_weekend=is_weekend,
        target_date=plan_date,
        event_lat=event_lat,
        event_lng=event_lng,
    )
    hotspots = (preds.get("kecamatan") or preds["top_hotspots"])[:top_n]
    demands = [
        Demand(
            area=h["slug"],
            tons=float(h["predicted_tons"]),
            lat=float(h.get("lat") or 0.0),
            lng=float(h.get("lng") or 0.0),
            priority=rank,
            label=_kecamatan_label(h.get("kecamatan") or h["slug"]),
            city=h.get("city"),
        )
        for rank, h in enumerate(reversed(hotspots), start=1)
    ]
    vehicles = [
        Vehicle(
            truck_code=t["truck_code"],
            capacity_tons=TRUCK_CAPACITY_TONS,
            available=not t["is_damaged"],
            permit_compliant=not t["deviation"]["violated"],
            vehicle_type=t.get("vehicle_type", ""),
            # The simulated fleet has no leachate flag: a compactor is assumed
            # sealed (labelled as an assumption in the rules file).
            leachate_free="compactor" in str(t.get("vehicle_type", "")).lower(),
        )
        for t in TRUCKS
    ]
    city_tons = float(preds.get("total_predicted_tons") or 0.0)
    plan_tons = sum(d.tons for d in demands)
    rules = resolve_rules(plan_date, capacity_share=(plan_tons / city_tons) if city_tons > 0 else 1.0)
    plan = build_operational_plan(demands, vehicles, rules=rules)
    # The stored scenario is the full normalized input, not just the subset the
    # optimizer happened to use, so an approved plan can be reproduced exactly.
    scenario = {
        "rainfall_mm": rainfall_mm,
        "event_attendance": event_attendance,
        "is_weekend": is_weekend,
        "plan_date": plan_date.isoformat(),
        "event_lat": event_lat,
        "event_lng": event_lng,
        "top_n": top_n,
        "targeted_kecamatan": preds["scenario"]["targeted_kecamatan"],
        "top_kecamatan": [h["slug"] for h in hotspots],
        "total_predicted_tons": preds["total_predicted_tons"],
        "kecamatan_count": preds["kecamatan_count"],
    }
    assignments = [
        {
            "truck_code": a.truck_code,
            "area": a.area,
            "assigned_tons": a.assigned_tons,
            "shift": a.shift,
            "facility": a.facility,
            "trip_index": a.trip_index,
            "evidence": a.evidence,
        }
        for a in plan.assignments
    ]
    by_area = {d.area: d for d in demands}
    payload = {
        "plan_id": plan.plan_id,
        "status": "proposed",
        "kind": "day_plan",
        "plan_date": plan_date.isoformat(),
        "is_weekend": is_weekend,
        "scope": {
            "kind": "day_plan",
            "plan_date": plan_date.isoformat(),
            "districts": len(demands),
            "district_total": preds["kecamatan_count"],
            "fleet_classification": "SIMULATED",
            "demand_classification": "MODEL_OUTPUT",
        },
        "assignments": assignments,
        "dispatches": _dispatch_instructions(plan.plan_id, plan_date, assignments, by_area, rules),
        "unmet_reasons": plan.unmet_reasons,
        "total_demand_tons": plan.total_demand_tons,
        "total_assigned_tons": plan.total_assigned_tons,
        "unassigned_tons": plan.unassigned_tons,
        "feasible": plan.feasible,
        "shortfall_label": None if plan.feasible else f"infeasible: {plan.unassigned_tons:.0f} t unassigned",
        "quota_usage": plan.quota_usage,
        "facility_usage": plan.facility_usage,
        "rules": rules.payload(),
        "scenario": scenario,
        # The role that built it, so an approver in another browser sees who proposed it.
        "proposed_by": _role,
    }
    payload = _OPERATIONS_PLAN_STORE.save_proposed(plan.plan_id, payload)
    history_store.record_event("operations_plan_created", {"plan_id": plan.plan_id, "scenario": scenario})
    return payload


@router.get("/api/operations/plans")
def list_operations_plans(
    status: str | None = Query(None, pattern="^(proposed|approved)$"),
    limit: int = Query(20, ge=1, le=100),
    _role: str = Depends(require_any_permission("operations:plan", "operations:approve")),
) -> list[dict[str, Any]]:
    """Stored plans, newest first (same shape as approve returns).

    `status=proposed` is the approver's inbox: a dispatcher proposes a plan in one
    browser, a supervisor opens Rencana in another and approves it by id.
    """
    return _OPERATIONS_PLAN_STORE.list_plans(status=status, limit=limit)


@router.get("/api/operations/instructions/{truck_code}")
def get_operations_instructions(
    truck_code: str,
    pending_only: bool = True,
    _role: str = Depends(require_any_permission("dispatch:confirm", "dispatch:create")),
) -> list[dict[str, Any]]:
    """Structured plan instructions for one truck (truck, stops, slot, reason).

    The matching dispatch row (`/api/dispatch/{truck_code}`) carries the same
    instruction as Indonesian text; `dispatch_id` links the two.
    """
    instructions = _OPERATIONS_PLAN_STORE.instructions_for(truck_code)
    if not pending_only:
        return instructions
    pending = {d["id"] for d in history_store.pending_dispatches(truck_code)}
    return [i for i in instructions if i["dispatch_id"] in pending]


@router.post("/api/operations/{plan_id}/approve")
def approve_operations_plan(
    plan_id: str, _role: str = Depends(require_permission("operations:approve"))
) -> dict[str, Any]:
    """Approve a plan and push each truck's trips through the dispatch contract.

    Approval is at-most-once (#17): the status transition and dispatch
    ids commit in one transaction; a retried or concurrent approval
    returns the already-committed result without creating new dispatches.
    """

    def _create_dispatch(item):
        # Plans stored before the day plan carry bare assignments: same
        # Indonesian template, one trip, no shift.
        area = _kecamatan_label(str(item.get("area", "")).replace("_", " "))
        text = item.get("text") or (
            f"Rencana {plan_id} · Truk {item['truck_code']}\n"
            f"1. Angkut ±{item['assigned_tons']:.0f} t dari Kec. {area}"
        )
        return history_store.save_dispatch(
            truck_code=item["truck_code"],
            instruction=text,
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
        # The wait here is the modelled peak hour's, not the day mean of /tpa/queue-metric.
        payload = {
            **tpa_queue_status_payload(scenario=scenario),
            "quantity": "peak_hour_mean_per_truck",
            "quantity_label": QUEUE_QUANTITIES["peak_hour_mean_per_truck"],
            "stage": QUEUE_STAGE,
        }
        cached = {"payload": payload, "ts": now}
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
