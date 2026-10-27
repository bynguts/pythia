"""The driver's trip at a glance: next stop, gate slot and the gate queue ahead.

Every figure says where it comes from, and a figure without a source is
``None`` with a ``reason``:

- Drive times are OSRM road durations from the **phone's own position** (the
  ``lat``/``lng`` the app sends), or a labelled straight-line estimate when the
  routing service is down. The simulated fleet position is never used here.
- The gate slot is the approved plan's modelled slot (``MODEL_OUTPUT``), or the
  slot of an accepted hold recommendation.
- The queue ahead is the gate-slot board (``SIMULATED`` background arrivals +
  approved plan trucks); it exists only when a plan is approved for today.
- Expected tonnage per stop is the plan's trip tonnage for that kecamatan
  (``MODEL_OUTPUT``), only for an SPJ drafted from a plan.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from app.api.state import _OPERATIONS_PLAN_STORE
from app.core.env import getenv, local_now
from app.field.spj import SPJ_STORE, Spj
from app.fleet import osrm
from app.fleet.facilities import route_ground_truth

QUEUE_AHEAD_MINUTES = 120
_PLAN_NOTE = "Rencana "


def _drive(origin: tuple[float, float] | None, target: tuple[float, float] | None) -> dict[str, Any]:
    if origin is None:
        return {"eta_minutes": None, "distance_km": None, "reason": "no_device_position"}
    if target is None:
        return {"eta_minutes": None, "distance_km": None, "reason": "no_coordinates"}
    route = osrm.road_route([origin, target])
    return {
        "eta_minutes": int(route["duration_min"]),
        "distance_km": route["distance_km"],
        "eta_source": route["eta_source"],
        "eta_label": route["eta_label"],
        "reason": None,
    }


def _plan_id_of(spj: Spj) -> str | None:
    """The plan an SPJ was drafted from (its note starts "Rencana <plan_id> (MODEL)")."""
    if not spj.note.startswith(_PLAN_NOTE):
        return None
    return spj.note[len(_PLAN_NOTE) :].split(" ", 1)[0] or None


def _stop_tons(spj: Spj, truck_code: str) -> dict[str, float] | None:
    """kecamatan label -> the plan's trip tons for it, for a plan-drafted SPJ; else None."""
    plan_id = _plan_id_of(spj)
    if plan_id is None:
        return None
    for item in _OPERATIONS_PLAN_STORE.instructions_for(truck_code):
        if item["plan_id"] != plan_id:
            continue
        tons: dict[str, float] = {}
        for trip in (item.get("fields") or {}).get("stops") or []:
            tons[trip["kecamatan"]] = round(tons.get(trip["kecamatan"], 0.0) + float(trip["tons"]), 1)
        return tons
    return None


def _stops(spj: Spj, truck_code: str) -> list[dict[str, Any]]:
    tons = _stop_tons(spj, truck_code)
    out = []
    for index, stop in enumerate(spj.stops):
        expected = (tons or {}).get(stop.kecamatan)
        reason = None
        if tons is None:
            reason = "spj_not_from_plan"
        elif expected is None:
            reason = "kecamatan_not_in_plan"
        out.append(
            {
                "index": index,
                "name": stop.name,
                "kecamatan": stop.kecamatan,
                "status": stop.status,
                "expected_tons": expected,
                "expected_tons_classification": "MODEL_OUTPUT" if expected is not None else None,
                "expected_tons_reason": reason,
            }
        )
    return out


def _gate_slot(truck_code: str, day: str) -> dict[str, Any] | None:
    from app.api.routers.gate_slots import ACCEPTS

    slot = None
    for item in _OPERATIONS_PLAN_STORE.instructions_for(truck_code):  # oldest first, latest wins
        candidate = (item.get("fields") or {}).get("gate_slot")
        if candidate and candidate.get("date") == day:
            slot = {
                "facility": candidate.get("facility"),
                "start": candidate.get("start"),
                "end": candidate.get("end"),
                "depart_at": candidate.get("depart_at"),
                "source": "plan",
                "classification": "MODEL_OUTPUT",
            }
    for accept in ACCEPTS.all():
        new = accept.get("new_slot") or {}
        if accept.get("truck_code") == truck_code and new.get("date") == day:
            slot = {
                "facility": new.get("facility"),
                "start": new.get("start"),
                "end": new.get("end"),
                "depart_at": None,
                "source": "accepted_hold",
                "classification": new.get("classification", "SIMULATED"),
            }
    return slot


def _queue_ahead(day: str, now: datetime) -> dict[str, Any]:
    from app.api.routers.gate_slots import gate_slots_payload

    board = gate_slots_payload(date.fromisoformat(day))
    start = now.strftime("%H:%M")
    end = (now + timedelta(minutes=QUEUE_AHEAD_MINUTES)).strftime("%H:%M")
    if end < start:  # past midnight: keep to today's board
        end = "24:00"
    slots = [
        {
            "start": s["start"],
            "end": s["end"],
            "expected_wait_min": s["expected_wait_min"],
            "load": round(s["background_load"] + len(s["planned_trucks"]), 1),
        }
        for s in board["slots"]
        if s["end"] > start and s["start"] < end
    ]
    return {
        "slots": slots,
        "window_minutes": QUEUE_AHEAD_MINUTES,
        "classification": board["classification"],
        "reason": None if slots else (board.get("reason") or "no_slot_in_window"),
    }


def trip_payload(truck_code: str, lat: float | None, lng: float | None) -> dict[str, Any]:
    now = local_now()
    day = now.date().isoformat()
    origin = (lat, lng) if lat is not None and lng is not None else None
    spj = SPJ_STORE.active_for_truck(truck_code)
    tpa_target = route_ground_truth(spj.destination) if spj else route_ground_truth("TPST Bantargebang")

    next_stop = None
    stops: list[dict[str, Any]] = []
    reason = "no_active_spj"
    if spj is not None:
        stops = _stops(spj, truck_code)
        pending = next((s for s in spj.stops if s.status not in ("completed", "skipped")), None)
        reason = None if pending else "all_stops_done"
        if pending is not None:
            index = spj.stops.index(pending)
            target = (
                (pending.lat, pending.lng) if pending.lat is not None and pending.lng is not None else None
            )
            next_stop = {"index": index, "name": pending.name, **_drive(origin, target)}
    return {
        "truck_code": truck_code,
        "date": day,
        "generated_at": now.isoformat(),
        "spj_id": spj.spj_id if spj else None,
        "spj_number": spj.spj_number if spj else None,
        "next_stop": next_stop,
        "next_stop_reason": reason,
        "stops": stops,
        "to_tpa": {
            "destination": spj.destination if spj else "TPST Bantargebang",
            **_drive(origin, tpa_target),
        },
        "gate_slot": _gate_slot(truck_code, day),
        "queue_ahead": _queue_ahead(day, now),
        "position_source": "device" if origin else None,
        "dispatch_contact": _dispatch_contact(),
    }


def _dispatch_contact() -> dict[str, Any]:
    """The dispatch office phone from PYTHIA_DISPATCH_PHONE (an office line, not a person); null when unset."""
    phone = (getenv("DISPATCH_PHONE") or "").strip()
    digits = "".join(ch for ch in phone if ch.isdigit())
    return {
        "phone": digits or None,
        "tel": f"tel:+{digits}" if digits else None,
        "whatsapp": f"https://wa.me/{digits}" if digits else None,
        "reason": None if digits else "not_configured",
    }
