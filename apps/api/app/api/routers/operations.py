"""Operations plans (forecast -> dispatch bridge), stagger simulator, TPA queue, event permits."""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.deps import require_any_permission, require_any_principal, require_permission
from app.api.routers.forecast import predictions_kecamatan
from app.api.schemas import EventPermitRequest, PlanReassignRequest
from app.api.state import _OPERATIONS_PLAN_STORE, _tpa_cache, dispatch_center, history_store
from app.core.env import today
from app.core.units import (
    TRUCK_CAPACITY_TONS,
    event_tons_for_attendance,
    resource_basis,
    resource_requirements,
)
from app.field import safety
from app.field.permits import PERMIT_STORE
from app.field.spj import SPJ_STORE
from app.fleet.data import TRUCKS, events_permits_payload, tpa_queue_status_payload
from app.fleet.gate_slots import assign_gate_slots, plan_gate_capacity
from app.fleet.operations_optimizer import Demand, Vehicle, build_operational_plan
from app.fleet.operations_rules import PlanningRules, resolve_rules
from app.fleet.queue_simulation import QUEUE_QUANTITIES, QUEUE_STAGE
from app.forecast.engine import simulate_staggered_dispatch
from app.forecast.real_data import load_kecamatan_map, load_real_tps_coordinates

logger = logging.getLogger(__name__)
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
    # The modelled weighbridge slot of each truck's first gate arrival; trucks of
    # plans already approved for the same day (and the night before, whose night
    # shift reaches the gate on this date) hold their slots.
    days = {plan_date.isoformat(), (plan_date - timedelta(days=1)).isoformat()}
    occupied = [
        d["fields"]["gate_slot"]
        for plan in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=100)
        if plan.get("plan_date") in days
        for d in plan.get("dispatches") or []
        if (d.get("fields") or {}).get("gate_slot")
    ]
    slots = assign_gate_slots(out, plan_date, occupied)
    for dispatch in out:
        slot = slots.get(dispatch["truck_code"]) or None
        dispatch["fields"]["gate_slot"] = slot
        if slot:
            facility = facility_names.get(slot["facility"], slot["facility"])
            day = (
                ""
                if slot["date"] == plan_date.isoformat()
                else f" ({_id_date(date.fromisoformat(slot['date']))})"
            )
            depart = f"Berangkat {slot['depart_at']} · " if slot.get("depart_at") else ""
            dispatch["text"] += (
                f"\n{depart}Slot gerbang {facility} {slot['start']}–{slot['end']}{day} (keluaran model)"
            )
    return out


# Plan facility -> SPJ destination. "RDF Rorotan" is the display name of the RDF
# Plant Jakarta (fleet/facilities.py). An unknown facility is never defaulted.
_SPJ_DESTINATIONS = {
    "TPST Bantargebang": "TPST Bantargebang",
    "RDF Rorotan": "RDF Plant Jakarta",
    "RDF Plant Jakarta": "RDF Plant Jakarta",
}
PLAN_STOP_LOCATION_TYPE = "Titik Rencana (centroid kecamatan)"
TPS_STOP_LOCATION_TYPE = "TPS (koordinat SILIKA DLH 2023)"
# TPS pickups per district a truck serves: trucks sharing a district take the next
# TPS points nearest its centre, so two trucks are not sent to the same TPS.
TPS_STOPS_PER_AREA = 3


def _plan_spj_note_prefix(plan_id: str) -> str:
    return f"Rencana {plan_id} (MODEL)"


def _tps_stops(
    plan: dict[str, Any], truck_code: str, areas: list[str], labels: dict[str, str], destination: str
) -> list[dict[str, Any]]:
    """Real SILIKA TPS pickup points for the districts this truck serves.

    Districts keep the plan's trip order. Within a district each truck takes its
    own share of the TPS points nearest the district centre, visited nearest
    first from the previous stop (the first district starts at the TPS farthest
    from the destination). A district without a SILIKA TPS keeps its labelled
    centroid planning point.
    """
    from app.fleet.facilities import route_ground_truth
    from app.forecast.engine import _haversine_meters

    by_area: dict[str, list[dict[str, Any]]] = {}
    for tps in load_real_tps_coordinates():
        by_area.setdefault(tps["kecamatan"].lower().replace(" ", "_"), []).append(tps)
    centroids = {k["slug"]: k for k in load_kecamatan_map()}
    sharing: dict[str, list[str]] = {}
    for d in plan.get("dispatches") or []:
        for area in dict.fromkeys(s["area"] for s in (d.get("fields") or {}).get("stops") or []):
            sharing.setdefault(area, []).append(d["truck_code"])
    dest = route_ground_truth(destination)
    stops: list[dict[str, Any]] = []
    for area in areas:
        label = labels[area]
        centroid = centroids.get(area) or {}
        if centroid.get("lat") is None or centroid.get("lng") is None:
            raise ValueError(f"no centroid for kecamatan {area}")
        centre = (centroid["lat"], centroid["lng"])
        pool = sorted(by_area.get(area, []), key=lambda t: _haversine_meters(centre, (t["lat"], t["lng"])))
        if not pool:
            stops.append(
                {
                    "name": f"Rencana · Kec. {label}",
                    "kecamatan": label,
                    "address": f"Titik tengah Kec. {label} (perencanaan, bukan alamat TPS)",
                    "lat": centroid["lat"],
                    "lng": centroid["lng"],
                    "location_type": PLAN_STOP_LOCATION_TYPE,
                }
            )
            continue
        trucks = sorted(sharing.get(area) or [truck_code])
        start = trucks.index(truck_code) * TPS_STOPS_PER_AREA if truck_code in trucks else 0
        count = min(TPS_STOPS_PER_AREA, len(pool))
        share = [pool[(start + i) % len(pool)] for i in range(count)]
        if stops:
            here = (stops[-1]["lat"], stops[-1]["lng"])
        elif dest is not None:
            here = max(((t["lat"], t["lng"]) for t in share), key=lambda p: _haversine_meters(p, dest))
        else:
            here = centre
        while share:
            nearest = min(share, key=lambda t: _haversine_meters(here, (t["lat"], t["lng"])))
            share.remove(nearest)
            here = (nearest["lat"], nearest["lng"])
            kelurahan = f"Kel. {_kecamatan_label(nearest['kelurahan'])}, " if nearest["kelurahan"] else ""
            stops.append(
                {
                    "name": nearest["name"],
                    "kecamatan": label,
                    "address": f"{kelurahan}Kec. {label} (koordinat TPS SILIKA DLH 2023)",
                    "lat": nearest["lat"],
                    "lng": nearest["lng"],
                    "location_type": TPS_STOP_LOCATION_TYPE,
                }
            )
    return stops


def _plan_spj(
    plan: dict[str, Any], dispatch: dict[str, Any], approved_by: str
) -> tuple[str | None, str | None]:
    """Adopt or create the draft SPJ of one plan truck; returns (spj_id, skipped).

    Draft creation skips `enforce_duty_limit` on purpose: a draft is not work,
    and `POST /api/spj/{id}/activate` re-checks duty before the truck leaves.
    Drafts stay `draft` until a human activates them. The stops are real SILIKA
    TPS points in the districts the plan gives this truck (see `_tps_stops`).
    """
    fields = dispatch["fields"]
    truck_code = dispatch["truck_code"]
    trips = sorted(fields["stops"], key=lambda s: s["order"])
    facility = trips[0]["facility"]
    destination = _SPJ_DESTINATIONS.get(facility)
    if destination is None:
        return None, f"unknown_facility:{facility}"
    prefix = _plan_spj_note_prefix(plan["plan_id"])
    for spj in SPJ_STORE.list(truck_code=truck_code):
        if spj.status == "draft" and spj.note.startswith(prefix):
            return spj.spj_id, None  # orphan of an earlier, interrupted attempt
    areas = list(dict.fromkeys(t["area"] for t in trips))
    labels = {area: next(t["kecamatan"] for t in trips if t["area"] == area) for area in areas}
    stops = _tps_stops(plan, truck_code, areas, labels, destination)
    facilities = ", ".join(dict.fromkeys(t.get("facility_display") or t["facility"] for t in trips))
    note = f"{prefix} · fasilitas: {facilities}"
    slot = fields.get("gate_slot")
    if slot:
        note += f" · slot gerbang {slot['start']}–{slot['end']}"
    driver_name = next((t["driver_name"] for t in TRUCKS if t["truck_code"] == truck_code), "")
    spj = SPJ_STORE.create_with_stops(
        driver_name=driver_name,
        truck_code=truck_code,
        destination=destination,
        weigh_on_site=False,
        priority="normal",
        note=note,
        stops=stops,
        created_by=approved_by,
        date=plan["plan_date"],
    )
    return spj.spj_id, None


def ensure_plan_spjs(plan: dict[str, Any], approved_by: str) -> None:
    """One draft SPJ per truck of an approved day plan; safe to call on every approve.

    Runs after the approval committed. Failures are recorded per truck in
    `spj_drafts[i].error` and never undo the approval.
    """
    dispatches = [d for d in plan.get("dispatches") or [] if "fields" in d]
    if plan.get("status") != "approved" or not dispatches:
        return
    by_truck = {d["truck_code"]: d for d in dispatches}
    ids = dict(
        zip((d["truck_code"] for d in plan["dispatches"]), plan.get("dispatch_ids") or [], strict=False)
    )
    _OPERATIONS_PLAN_STORE.ensure_spj_links(
        plan["plan_id"],
        [(code, ids.get(code)) for code in by_truck],
        lambda code: _plan_spj(plan, by_truck[code], approved_by),
    )


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
    draft: bool = Query(
        False, description="Store as a draft: it reaches the approver only after POST …/submit"
    ),
    auto_inputs: bool = Query(
        False,
        description="Take rain, events and holiday from the forecast and apply the day's field facts; "
        "the rain/event parameters are then ignored",
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

    With `auto_inputs=true` (the console's Tomorrow page) the operator types no
    scenario: rain, the located event and the holiday come from
    `/api/forecast/tomorrow` for `plan_date`, and the day's field facts take
    unavailable trucks out of the fleet. The scenario records what was applied.
    """
    plan_date = plan_date or today()
    is_weekend = plan_date.weekday() >= 5
    is_holiday = False
    auto = None
    if auto_inputs:
        try:
            auto = _auto_inputs(plan_date)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        rainfall_mm, is_holiday = auto["rainfall_mm"], auto["holiday"] is not None
        event = auto["event_applied"]
        event_attendance = event["attendance"] if event else 0
        event_lat = event["lat"] if event else None
        event_lng = event["lng"] if event else None
    preds = predictions_kecamatan(
        rainfall_mm=rainfall_mm,
        event_attendance=event_attendance,
        is_weekend=is_weekend,
        is_holiday=is_holiday,
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
    held = auto["unavailable_trucks"] if auto else {}
    vehicles = [
        Vehicle(
            truck_code=t["truck_code"],
            capacity_tons=TRUCK_CAPACITY_TONS,
            available=not t["is_damaged"] and t["truck_code"] not in held,
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
    solve_started = time.perf_counter()
    plan = build_operational_plan(demands, vehicles, rules=rules)
    solve_seconds = round(time.perf_counter() - solve_started, 2)
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
        "is_holiday": is_holiday,
        "inputs_auto": auto is not None,
    }
    if auto is not None:
        scenario["auto_inputs"] = {
            "rainfall": auto["rainfall"],
            "event_applied": auto["event_applied"],
            "events_not_applied": auto["events_not_applied"],
            "holiday": auto["holiday"],
            "field_facts_applied": [
                {"fact_id": fact_id, "truck_code": code} for code, fact_id in sorted(held.items())
            ],
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
    dispatches = _dispatch_instructions(plan.plan_id, plan_date, assignments, by_area, rules)
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
        "dispatches": dispatches,
        # Whether the weighbridge slots can take the plan's trucks, and how much of the
        # day's gate traffic the plan carries (the rest arrives unstaggered).
        "gate_capacity": plan_gate_capacity(dispatches),
        "unmet_reasons": plan.unmet_reasons,
        "total_demand_tons": plan.total_demand_tons,
        "total_assigned_tons": plan.total_assigned_tons,
        "unassigned_tons": plan.unassigned_tons,
        "feasible": plan.feasible,
        "solve_seconds": solve_seconds,
        "shortfall_label": None if plan.feasible else f"infeasible: {plan.unassigned_tons:.0f} t unassigned",
        "quota_usage": plan.quota_usage,
        "facility_usage": plan.facility_usage,
        "rules": rules.payload(),
        "scenario": scenario,
        # The role that built it, so an approver in another browser sees who proposed it.
        "proposed_by": _role,
    }
    if draft:
        payload["status"] = "draft"
    payload = _OPERATIONS_PLAN_STORE.save_proposed(plan.plan_id, payload, "draft" if draft else "proposed")
    history_store.record_event("operations_plan_created", {"plan_id": plan.plan_id, "scenario": scenario})
    return payload


def _auto_inputs(plan_date: date) -> dict[str, Any]:
    """The plan inputs nobody types: forecast drivers for `plan_date` plus its field facts.

    The demand model localizes one event per run, so of several located events
    the largest is applied and the rest are listed with the reason. An event
    without a location or attendance is never placed at a default venue.
    """
    from app.field.field_facts import unavailable_trucks
    from app.forecast.baseline import tomorrow_forecast

    forecast = tomorrow_forecast(plan_date.isoformat())
    drivers = forecast.get("drivers") or []
    weather = next((d for d in drivers if d["kind"] == "weather"), None)
    holiday = next((d for d in drivers if d["kind"] == "holiday"), None)
    # The forecast lists events it could not localize; only located permits carry coordinates.
    not_applied = [
        {"name": d["detail"].get("name"), "reason": d["effect_reason"]}
        for d in drivers
        if d["kind"] == "event" and d.get("effect_reason")
    ]
    located = sorted(
        (
            p
            for p in PERMIT_STORE.list()
            if p.get("event_date") == plan_date.isoformat()
            and p.get("lat") is not None
            and p.get("lng") is not None
            and int(p.get("expected_attendance") or 0) > 0
        ),
        key=lambda p: -int(p["expected_attendance"]),
    )
    applied = None
    if located:
        top = located[0]
        applied = {
            "name": top.get("name"),
            "attendance": int(top["expected_attendance"]),
            "lat": top["lat"],
            "lng": top["lng"],
            "data_class": top.get("data_class"),
        }
        not_applied += [{"name": p.get("name"), "reason": "one_event_per_plan"} for p in located[1:]]
    rainfall = float((weather or {}).get("detail", {}).get("rainfall_mm") or 0.0)
    return {
        "rainfall_mm": rainfall,
        "rainfall": {
            "rainfall_mm": rainfall,
            "source": (weather or {}).get("source"),
            "input_classification": (weather or {}).get("input_classification"),
        },
        "event_applied": applied,
        "events_not_applied": not_applied,
        "holiday": (holiday or {}).get("detail", {}).get("name"),
        "unavailable_trucks": unavailable_trucks(plan_date.isoformat()),
    }


@router.get("/api/operations/plans")
def list_operations_plans(
    status: str | None = Query(None, pattern="^(draft|proposed|approved|returned|withdrawn)$"),
    limit: int = Query(20, ge=1, le=100),
    _role: str = Depends(require_any_permission("operations:plan", "operations:approve")),
) -> list[dict[str, Any]]:
    """Stored plans, newest first (same shape as approve returns).

    `status=proposed` is the approver's inbox: a dispatcher proposes a plan in one
    browser, a supervisor opens Rencana in another and approves it by id.
    """
    return _OPERATIONS_PLAN_STORE.list_plans(status=status, limit=limit)


def _spj_drafts(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """One entry per truck of an approved plan: its draft SPJ, or why there is none."""
    slots = {d["truck_code"]: (d.get("fields") or {}).get("gate_slot") for d in plan.get("dispatches") or []}
    drafts = []
    for link in _OPERATIONS_PLAN_STORE.spj_links(plan["plan_id"]):
        spj = SPJ_STORE.get(link["spj_id"]) if link["spj_id"] else None
        entry: dict[str, Any] = {
            "truck_code": link["truck_code"],
            "spj_id": link["spj_id"],
            "spj_number": spj.spj_number if spj else None,
            "status": spj.status if spj else None,
            "gate_slot": slots.get(link["truck_code"]),
        }
        if link["status"] == "skipped":
            entry["skipped"] = link["detail"]
        elif link["spj_id"] is None:
            entry["error"] = link["detail"] or "spj_not_created"
        drafts.append(entry)
    return drafts


@router.get("/api/operations/plans/{plan_id}")
def get_operations_plan(
    plan_id: str,
    _role: str = Depends(require_any_permission("operations:plan", "operations:approve")),
) -> dict[str, Any]:
    """One stored plan by id (same shape as the list items) plus its `spj_drafts`.

    The dispatcher's planning page polls this while a plan waits for approval.
    """
    plan = _OPERATIONS_PLAN_STORE.get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found.")
    return {**plan, "spj_drafts": _spj_drafts(plan)}


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
    Every call then makes sure each truck has its draft SPJ (`spj_drafts`),
    so a retry repairs a draft an earlier attempt failed to create.
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
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    try:
        ensure_plan_spjs(plan, approved_by=plan.get("approved_by") or _role)
    except Exception:  # noqa: BLE001 - the approval is committed; drafts report per truck
        logger.exception("draft SPJs for plan %s failed", plan_id)
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
    return {**plan, "spj_drafts": _spj_drafts(plan)}


class PlanReturnBody(BaseModel):
    note: str = Field(min_length=3, max_length=500)


class PlanSwapBody(BaseModel):
    truck_a: str = Field(min_length=1, max_length=32)
    truck_b: str = Field(min_length=1, max_length=32)


def _edit_plan(
    plan_id: str, allowed: tuple[str, ...], mutate, to_status: str | None = None
) -> dict[str, Any]:
    try:
        return _OPERATIONS_PLAN_STORE.edit(plan_id, allowed, mutate, to_status)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found.") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except sqlite3.Error as exc:
        logger.exception("plan %s edit failed", plan_id)
        raise HTTPException(status_code=503, detail="Plan storage is unavailable; nothing changed.") from exc


@router.post("/api/operations/plans/{plan_id}/return")
def return_operations_plan(
    plan_id: str,
    body: PlanReturnBody,
    principal: dict = Depends(require_any_principal("operations:approve")),
) -> dict[str, Any]:
    """The approver sends a proposed plan back with a note; it leaves the inbox (`status: returned`)."""
    now = datetime.now(UTC).isoformat()

    def mutate(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            **payload,
            "return_note": body.note.strip(),
            "returned_at": now,
            "returned_by": principal["username"],
        }

    plan = _edit_plan(plan_id, ("proposed",), mutate, "returned")
    history_store.record_event("operations_plan_returned", {"plan_id": plan_id, "by": principal["username"]})
    return plan


@router.post("/api/operations/plans/{plan_id}/submit")
def submit_operations_plan(
    plan_id: str, principal: dict = Depends(require_any_principal("operations:plan"))
) -> dict[str, Any]:
    """Send a draft plan to the approver's inbox (`draft` -> `proposed`); 409 from any other status."""
    now = datetime.now(UTC).isoformat()

    def mutate(payload: dict[str, Any]) -> dict[str, Any]:
        return {**payload, "status": "proposed", "submitted_at": now, "submitted_by": principal["username"]}

    plan = _edit_plan(plan_id, ("draft",), mutate, "proposed")
    history_store.record_event("operations_plan_submitted", {"plan_id": plan_id, "by": principal["username"]})
    return plan


@router.post("/api/operations/plans/{plan_id}/withdraw")
def withdraw_operations_plan(
    plan_id: str, principal: dict = Depends(require_any_principal("operations:plan"))
) -> dict[str, Any]:
    """The planner takes back a proposed or returned plan (`status: withdrawn`); it can no longer be approved."""
    now = datetime.now(UTC).isoformat()

    def mutate(payload: dict[str, Any]) -> dict[str, Any]:
        return {**payload, "withdrawn_at": now, "withdrawn_by": principal["username"]}

    plan = _edit_plan(plan_id, ("draft", "proposed", "returned"), mutate, "withdrawn")
    history_store.record_event("operations_plan_withdrawn", {"plan_id": plan_id, "by": principal["username"]})
    return plan


def _swap_code(dispatch: dict[str, Any], old: str, new: str) -> dict[str, Any]:
    header, sep, rest = dispatch["text"].partition("\n")
    fields = {**dispatch["fields"], "truck_code": new} if "fields" in dispatch else None
    out = {**dispatch, "truck_code": new, "text": header.replace(f"Truk {old}", f"Truk {new}") + sep + rest}
    if fields is not None:
        out["fields"] = fields
    return out


@router.post("/api/operations/plans/{plan_id}/swap")
def swap_operations_plan_trucks(
    plan_id: str,
    body: PlanSwapBody,
    principal: dict = Depends(require_any_principal("operations:plan")),
) -> dict[str, Any]:
    """Exchange the work of two trucks in a plan that is not approved yet.

    `truck_b` may be a fleet truck outside the plan: `truck_a`'s work then moves
    to it. The gate slot belongs to the work (its shift and first stop), so it
    moves with it unchanged. Every swap is appended to `edits`.
    """
    a, b = body.truck_a.strip(), body.truck_b.strip()
    if a == b:
        raise HTTPException(status_code=422, detail="truck_a and truck_b must differ.")
    fleet = {t["truck_code"]: t for t in TRUCKS}
    now = datetime.now(UTC).isoformat()

    def mutate(payload: dict[str, Any]) -> dict[str, Any]:
        codes = {x.get("truck_code") for x in payload.get("assignments") or []}
        if a not in codes:
            raise KeyError(f"Truck {a} is not in plan {plan_id}")
        if b not in codes:
            if b not in fleet:
                raise KeyError(f"Truck {b} not found")
            if fleet[b].get("is_damaged"):
                raise ValueError(f"Truck {b} is out of service")
        swap = {a: b, b: a}
        payload["assignments"] = [
            {**x, "truck_code": swap.get(x["truck_code"], x["truck_code"])} for x in payload["assignments"]
        ]
        dispatches = [
            _swap_code(d, d["truck_code"], swap[d["truck_code"]]) if d.get("truck_code") in swap else d
            for d in payload.get("dispatches") or []
        ]
        payload["dispatches"] = sorted(dispatches, key=lambda d: str(d.get("truck_code", "")))
        payload["edits"] = [
            *(payload.get("edits") or []),
            {"at": now, "by": principal["username"], "truck_a": a, "truck_b": b},
        ]
        return payload

    try:
        plan = _OPERATIONS_PLAN_STORE.edit(plan_id, ("draft", "proposed"), mutate)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except sqlite3.Error as exc:
        logger.exception("plan %s swap failed", plan_id)
        raise HTTPException(status_code=503, detail="Plan storage is unavailable; nothing changed.") from exc
    history_store.record_event(
        "operations_plan_swapped",
        {"plan_id": plan_id, "truck_a": a, "truck_b": b, "by": principal["username"]},
    )
    return plan


_REASSIGN_LOCKS: dict[str, threading.Lock] = {}
_REASSIGN_LOCKS_GUARD = threading.Lock()


def _reassign_lock(plan_id: str) -> threading.Lock:
    """One reassign at a time per plan: two moves onto the same truck cannot both pass the check."""
    with _REASSIGN_LOCKS_GUARD:
        return _REASSIGN_LOCKS.setdefault(plan_id, threading.Lock())


@router.post("/api/operations/{plan_id}/reassign")
def reassign_operations_truck(
    plan_id: str,
    payload: PlanReassignRequest,
    _role: str = Depends(require_permission("dispatch:create")),
) -> dict[str, Any]:
    """Move one truck's share of an approved plan to another truck.

    The move spans three databases (SPJ, dispatches, plan), so it is ordered
    and resumable rather than atomic, and idempotent per (plan, from_truck):
    1. the draft SPJ moves (audit-logged `reassign_draft`), the only step that
       can refuse (409), so a refusal changes nothing; an active SPJ never
       moves: the dispatcher cancels it and creates a new one;
    2. a reassign row records the decision and the new dispatch id;
    3. the new dispatch is saved for `to_truck` under that id (idempotent);
    4. one plan-DB transaction moves the instruction, link row and payload;
    5. the old dispatch becomes REASSIGNED last (a later READY on it gets 409).
    A retry after a failure resumes from the row and never creates a second
    dispatch; a retry after success returns the same result.
    """
    from_truck, to_truck = payload.from_truck, payload.to_truck
    trucks = {t["truck_code"]: t for t in TRUCKS}
    if _OPERATIONS_PLAN_STORE.get(plan_id) is None:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found.")
    if to_truck not in trucks:
        raise HTTPException(status_code=404, detail=f"Truck {to_truck} not found.")
    with _reassign_lock(plan_id):
        plan = _OPERATIONS_PLAN_STORE.get(plan_id)
        if plan["status"] != "approved":
            raise HTTPException(status_code=409, detail="Rencana belum disetujui.")
        record = _OPERATIONS_PLAN_STORE.reassign_row(plan_id, from_truck)
        if record is not None and record["to_truck"] != to_truck:
            raise HTTPException(
                status_code=409, detail=f"Truk {from_truck} sudah dialihkan ke Truk {record['to_truck']}."
            )
        try:
            if record is None:
                record = _start_reassign(plan, from_truck, to_truck, trucks, payload.reason, _role)
            new_dispatch = history_store.save_dispatch(
                to_truck,
                record["item"]["text"],
                manager_id="operations_optimizer",
                dispatch_id=record["new_dispatch_id"],
            )
            _OPERATIONS_PLAN_STORE.reassign_truck(plan_id, from_truck)
            history_store.mark_dispatch_reassigned(
                record["old_dispatch_id"], note=f"Dialihkan ke Truk {to_truck}: {record['reason']}"
            )
            if record["status"] != "done":
                dispatch_center._dispatches[:] = [
                    d
                    for d in dispatch_center._dispatches
                    if d.get("id") not in (record["old_dispatch_id"], record["new_dispatch_id"])
                ] + [new_dispatch]
                history_store.record_event(
                    "operations_plan_reassigned",
                    {
                        "plan_id": plan_id,
                        "from_truck": from_truck,
                        "to_truck": to_truck,
                        "reason": record["reason"],
                        "cancelled_dispatch_id": record["old_dispatch_id"],
                        "dispatch_id": record["new_dispatch_id"],
                        "spj_id": record["spj_id"],
                        "by": record["actor"],
                    },
                )
                _OPERATIONS_PLAN_STORE.set_reassign_status(plan_id, from_truck, "done")
        except sqlite3.Error as error:
            logger.exception("reassign %s %s -> %s interrupted", plan_id, from_truck, to_truck)
            raise HTTPException(
                status_code=503, detail="Pengalihan belum selesai; kirim ulang permintaan yang sama."
            ) from error
    return {
        "plan_id": plan_id,
        "from_truck": from_truck,
        "to_truck": to_truck,
        "cancelled_dispatch_id": record["old_dispatch_id"],
        "dispatch_id": record["new_dispatch_id"],
        "spj_id": record["spj_id"],
    }


def _start_reassign(
    plan: dict[str, Any],
    from_truck: str,
    to_truck: str,
    trucks: dict[str, dict[str, Any]],
    reason: str,
    actor: str,
) -> dict[str, Any]:
    """Check a new reassign, move its draft SPJ (step 1) and record it (step 2)."""
    plan_id = plan["plan_id"]
    dispatches = plan.get("dispatches") or []
    index = next((i for i, d in enumerate(dispatches) if d.get("truck_code") == from_truck), None)
    if index is None or "fields" not in dispatches[index]:
        raise HTTPException(status_code=404, detail=f"Truck {from_truck} is not in plan {plan_id}.")
    if any(d.get("truck_code") == to_truck for d in dispatches):
        raise HTTPException(status_code=409, detail=f"Truk {to_truck} sudah ada di rencana ini.")
    if trucks[to_truck].get("is_damaged"):
        raise HTTPException(status_code=409, detail=f"Truk {to_truck} sedang rusak.")
    duty = safety.duty_check(to_truck)
    if duty["blocked"]:
        raise HTTPException(status_code=409, detail=duty["reason"])
    link = next((r for r in _OPERATIONS_PLAN_STORE.spj_links(plan_id) if r["truck_code"] == from_truck), None)
    spj = SPJ_STORE.get(link["spj_id"]) if link and link["spj_id"] else None
    if spj is not None and spj.status != "draft":
        raise HTTPException(status_code=409, detail="SPJ sudah aktif; batalkan dan buat ulang")

    old = dispatches[index]
    header, _, rest = old["text"].partition("\n")
    text = header.replace(f"Truk {from_truck}", f"Truk {to_truck}") + f"\nDialihkan dari Truk {from_truck}."
    if rest:
        text += "\n" + rest
    item = {**old, "truck_code": to_truck, "text": text, "fields": {**old["fields"], "truck_code": to_truck}}
    # An earlier attempt may have moved the SPJ and then failed before recording.
    if spj is not None and spj.truck_code != to_truck:
        try:
            SPJ_STORE.reassign_draft(
                spj.spj_id, to_truck, trucks[to_truck].get("driver_name") or "", actor=actor, reason=reason
            )
        except ValueError:
            raise HTTPException(status_code=409, detail="SPJ sudah aktif; batalkan dan buat ulang") from None
    return _OPERATIONS_PLAN_STORE.claim_reassign(
        plan_id,
        from_truck,
        to_truck=to_truck,
        old_dispatch_id=(plan.get("dispatch_ids") or [])[index],
        new_dispatch_id=str(uuid4()),
        spj_id=spj.spj_id if spj else None,
        item=item,
        reason=reason,
        actor=actor,
    )


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
