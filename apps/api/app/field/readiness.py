"""Morning readiness board: per truck, can it roll today (wave 12 lane B).

Aggregates facts that already live in separate stores (pre-trip, duty, the plan
instruction ack, SPJ, damage, service) into one row per truck. Read-only: it
writes nothing and invents nothing. A fact that cannot be known for the asked
day is ``null``, never a guess.

Duty comes from ``safety.observed_activity``, called once for all trucks. When
the server holds no app events at all, duty is shown from the labelled
simulated scenario and never raises a blocker (blocking acts on observed events
only, as in ``safety.duty_check``).
"""

from __future__ import annotations

from datetime import date as Date
from datetime import datetime
from typing import Any

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.core.env import local_today
from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN
from app.field import safety
from app.field.damage_reports import DAMAGE_STORE
from app.field.pretrip import PRETRIP_STORE
from app.field.service_history import SERVICE_STORE
from app.field.spj import SPJ_STORE, Spj

SCOPES = ("plan", "fleet")
SERVICE_DUE_DAYS = 7

# Field status written by the driver confirm endpoint -> board vocabulary.
_INSTRUCTION_STATUS = {
    "PENDING": "pending",
    "READY": "acknowledged",
    "SIAP": "acknowledged",
    "DONE": "acknowledged",
    "ISSUE": "issue",
    "REASSIGNED": "reassigned",
}
_INSTRUCTION_BLOCKER = {
    "pending": "instruction_pending",
    "issue": "instruction_issue",
    "reassigned": "instruction_reassigned",
}


def _approved_plans(day: str) -> list[dict[str, Any]]:
    plans = _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=100)
    return [p for p in plans if p.get("plan_date") == day]


def _instruction(truck_code: str, plan_ids: set[str]) -> dict[str, Any]:
    """The truck's newest live instruction of the day's plans; a moved one only if nothing else is left."""
    found = []
    for item in _OPERATIONS_PLAN_STORE.instructions_for(truck_code):
        if item["plan_id"] not in plan_ids:
            continue
        row = history_store.get_dispatch(item["dispatch_id"])
        if row is None:
            continue
        status = _INSTRUCTION_STATUS.get(str(row["field_status"]).upper(), "pending")
        found.append((status, item["dispatch_id"], row["confirmed_at"] or row["created_at"]))
    live = [f for f in found if f[0] != "reassigned"]
    pick = (live or found or [None])[-1]
    if pick is None:
        return {"dispatch_id": None, "status": "none", "updated_at": None}
    return {"dispatch_id": pick[1], "status": pick[0], "updated_at": pick[2]}


def _gate_slots(plans: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """truck_code -> its modelled gate slot in the day's approved plans (the first plan wins)."""
    slots: dict[str, dict[str, Any]] = {}
    for plan in plans:
        for dispatch in plan.get("dispatches") or []:
            slot = (dispatch.get("fields") or {}).get("gate_slot")
            if slot and dispatch.get("truck_code") not in slots:
                slots[dispatch["truck_code"]] = slot
    return slots


def _slot_view(slot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not slot:
        return None
    return {
        "facility": slot.get("facility"),
        "date": slot.get("date"),
        "start": slot.get("start"),
        "end": slot.get("end"),
        "depart_at": slot.get("depart_at"),
        "depart_date": slot.get("depart_date"),
        "classification": slot.get("classification", "MODEL_OUTPUT"),
    }


def _first_departure(slots: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """The earliest modelled depot departure of the day's plans; None without a planned slot."""
    found = []
    for code, slot in slots.items():
        depart = slot.get("depart_at")
        if not depart:
            continue
        clock = depart.split(" ")[-1]  # "HH:MM", or "YYYY-MM-DD HH:MM" across midnight
        found.append(((slot.get("depart_date") or slot.get("date") or "", clock), code, slot, clock))
    if not found:
        return None
    _, code, slot, clock = min(found)
    return {
        "depart_at": clock,
        "date": slot.get("depart_date") or slot.get("date"),
        "truck_code": code,
        "classification": "MODEL_OUTPUT",
    }


def _spj_view(spjs: list[Spj], day: str, plan_ids: set[str]) -> dict[str, Any]:
    """The plan's draft when it exists, else the day's newest SPJ; an active SPJ outside the plan is flagged."""
    prefixes = tuple(f"Rencana {pid}" for pid in plan_ids)
    mine = [s for s in spjs if prefixes and s.note.startswith(prefixes) and s.status != "batal"]
    dated = [s for s in spjs if s.date == day and s.status != "batal"]
    primary = (mine or dated or [None])[0]  # SPJ_STORE.list is newest first
    other = next((s for s in spjs if s.status == "aktif" and s not in mine), None)
    return {
        "spj_id": primary.spj_id if primary else None,
        "spj_number": primary.spj_number if primary else None,
        "status": primary.status if primary else "none",
        "other_active_spj_id": other.spj_id if other else None,
    }


def readiness_payload(
    day: Date | str | None = None, scope: str = "plan", now: datetime | None = None
) -> dict[str, Any]:
    """The readiness board for ``day`` (default: today, WIB); ``scope`` is ``plan`` or ``fleet``."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}")
    now = now or safety._now()
    day = Date.fromisoformat(day) if isinstance(day, str) else (day or local_today())
    day_iso = day.isoformat()
    is_today = safety.local_day_window(now)[0].date() == day

    plans = _approved_plans(day_iso)
    plan_ids = {p["plan_id"] for p in plans}
    spjs_by_truck: dict[str, list[Spj]] = {}
    for spj in SPJ_STORE.list():
        spjs_by_truck.setdefault(spj.truck_code, []).append(spj)

    codes = {
        item["truck_code"] for p in plans for item in (p.get("dispatches") or p.get("assignments") or [])
    }
    codes |= {code for code, spjs in spjs_by_truck.items() if any(s.date == day_iso for s in spjs)}
    scope_used = scope
    if scope == "fleet" or not codes:
        scope_used = "fleet"
        codes |= set(safety.simulated_fleet_codes())

    observed = safety.observed_activity(now) if is_today else {}
    duty_source = "observed" if observed else "simulated"
    simulated = safety.simulated_activity(now, sorted(codes)) if is_today and not observed else {}
    overrides = safety.overrides_today(now) if is_today else {}

    pretrips: dict[str, dict[str, Any]] = {}
    for raw in PRETRIP_STORE._records.all():  # one pass for the whole fleet
        if raw.get("date") == day_iso:
            pretrips[raw["truck_code"]] = raw  # oldest first, so the latest wins
    damage: dict[str, list[Any]] = {}
    for report in DAMAGE_STORE.list(status="baru"):
        damage.setdefault(report.truck_code, []).append(report)
    service_due = {d["truck_code"] for d in SERVICE_STORE.due_soon(days=SERVICE_DUE_DAYS, today=day_iso)}

    from app.fleet.data import get_dynamic_trucks

    fleet = {t["truck_code"]: t for t in get_dynamic_trucks()}
    drivers = {code: t.get("driver_name") for code, t in fleet.items()}
    slots = _gate_slots(plans)

    trucks = []
    counts = {"ready": 0, "not_ready": 0, "blocked": 0}
    for code in sorted(codes):
        spjs = spjs_by_truck.get(code, [])
        pretrip_raw = pretrips.get(code)
        blockers: list[str] = []
        if pretrip_raw is None:
            blockers.append("pretrip_missing")

        if not is_today:
            duty = {"minutes": None, "state": None, "override": None, "source": "not_applicable"}
        else:
            payload = safety.truck_payload(
                code,
                (observed or simulated).get(code),
                overrides.get(code),
                safety.OBSERVED if observed else safety.SIMULATED,
                now,
            )
            duty = {
                "minutes": payload["duty_minutes"],
                "state": payload["duty_state"],
                "override": payload["override"],
                "source": duty_source,
            }
            if observed and duty["state"] == "blocked" and duty["override"] is None:
                blockers.append("duty_blocked")

        instruction = _instruction(code, plan_ids)
        if instruction["status"] in _INSTRUCTION_BLOCKER:
            blockers.append(_INSTRUCTION_BLOCKER[instruction["status"]])

        spj = _spj_view(spjs, day_iso, plan_ids)
        if spj["status"] == "none":
            blockers.append("spj_missing")
        if spj["other_active_spj_id"]:
            blockers.append("spj_active_other")

        open_reports = damage.get(code, [])
        if open_reports:
            blockers.append("damage_open")
        heavy = any(r.severity == "berat" for r in open_reports)

        hard = "duty_blocked" in blockers or heavy
        counts["blocked" if hard else "not_ready" if blockers else "ready"] += 1
        driver = (
            drivers.get(code)
            or (pretrip_raw or {}).get("driver_name")
            or (spjs[0].driver_name if spjs else None)
        )
        trucks.append(
            {
                "truck_code": code,
                "driver_name": driver,
                "zone": (fleet.get(code) or {}).get("assigned_zone"),
                "zone_classification": "SIMULATED" if code in fleet else None,
                "gate_slot": _slot_view(slots.get(code)),
                "pretrip": {
                    "done": pretrip_raw is not None,
                    "at": pretrip_raw["created_at"] if pretrip_raw else None,
                    "failed_items": [k for k, ok in (pretrip_raw or {}).get("items", {}).items() if not ok],
                },
                "duty": duty,
                "instruction": instruction,
                "spj": spj,
                "damage": {"open": len(open_reports), "heavy": heavy},
                "service": {"due_soon": code in service_due},
                "ready": not blockers,
                "blockers": blockers,
            }
        )
    return {
        "date": day_iso,
        "generated_at": now.isoformat(),
        "scope_used": scope_used,
        "first_departure": _first_departure(slots),
        "backup_candidates": _backup_candidates(
            fleet, codes, pretrips, damage, spjs_by_truck, observed if is_today else None, overrides, now
        ),
        "thresholds": {"duty_warn_min": DUTY_WARN_MIN, "duty_block_min": DUTY_BLOCK_MIN},
        "trucks": trucks,
        "counts": counts,
    }


def _backup_candidates(
    fleet: dict[str, dict[str, Any]],
    scope: set[str],
    pretrips: dict[str, dict[str, Any]],
    damage: dict[str, list[Any]],
    spjs_by_truck: dict[str, list[Spj]],
    observed: dict[str, dict[str, Any]] | None,
    overrides: dict[str, dict[str, Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    """Fleet trucks outside the board that could take over a plan truck's work.

    Each one passed today's pre-trip with every item OK, has no open damage
    report, is not out of service in the fleet, holds no active SPJ and is not
    duty-blocked by observed events. Earliest pre-trip first. Empty when the
    board already covers the whole fleet or no such truck exists.
    """
    out = []
    for code, truck in fleet.items():
        raw = pretrips.get(code)
        if code in scope or raw is None or not all((raw.get("items") or {}).values()):
            continue
        if damage.get(code) or truck.get("is_damaged"):
            continue
        if any(s.status == "aktif" for s in spjs_by_truck.get(code, [])):
            continue
        if observed is not None:
            activity = observed.get(code)
            duty = safety.truck_payload(code, activity, overrides.get(code), safety.OBSERVED, now)
            if activity and duty["duty_state"] == "blocked" and duty["override"] is None:
                continue
        out.append(
            {
                "truck_code": code,
                "driver_name": truck.get("driver_name"),
                "pretrip_at": raw.get("created_at"),
                "zone": truck.get("assigned_zone"),
                "classification": "FIELD",
                "basis": "pre-trip passed today, no open damage, no active SPJ, not duty-blocked",
            }
        )
    out.sort(key=lambda c: (c["pretrip_at"] or "", c["truck_code"]))
    return out
