"""Drivers this week: trips, proof, gate punctuality and duty from field records (wave 13).

Read-only, from records on this server only (SPJ, receipts, gate arrivals,
pre-trips) plus the approved plans' modelled gate slots. A column a driver has
no records for is ``None``, never 0:

- ``trips``: SPJs of the window with a weighbridge receipt (a delivered trip).
- ``proof_complete_pct``: completed stops closed with evidence, of all completed
  stops (a supervisor override counts as no proof).
- ``on_time_pct``: gate arrivals at or before the end of the truck's planned gate
  slot, of the SPJs that have both (only SPJs drafted from an approved plan have a slot).
- ``avg_duty_min``: per day, the first pre-trip or SPJ activation to the last
  receipt of that truck; the mean over days that have both.

The demo seed SPJ is excluded, as everywhere else in the safety reads.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from app.api.state import _OPERATIONS_PLAN_STORE
from app.field import safety
from app.field.pretrip import PRETRIP_STORE
from app.field.spj import SPJ_STORE, Spj

MAX_DAYS = 31
_PLAN_NOTE = "Rencana "


def _wib(value: str | None) -> datetime | None:
    parsed = safety._parse(value)
    return parsed.astimezone(safety.WIB) if parsed else None


def _slot_end(spj: Spj, slots: dict[tuple[str, str], dict[str, Any]]) -> datetime | None:
    """The planned gate-slot end of a plan-drafted SPJ (WIB), or None."""
    if not spj.note.startswith(_PLAN_NOTE):
        return None
    plan_id = spj.note[len(_PLAN_NOTE) :].split(" ", 1)[0]
    slot = slots.get((plan_id, spj.truck_code))
    if not slot or not slot.get("date") or not slot.get("end"):
        return None
    end = datetime.fromisoformat(f"{slot['date']}T{slot['end']}").replace(tzinfo=safety.WIB)
    # A slot ending at 00:00 closes at midnight of the next day.
    return end + timedelta(days=1) if slot["end"] <= slot.get("start", "") else end


def _plan_slots() -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (plan["plan_id"], d["truck_code"]): d["fields"]["gate_slot"]
        for plan in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=500)
        for d in plan.get("dispatches") or []
        if (d.get("fields") or {}).get("gate_slot") and d.get("truck_code")
    }


def _pct(part: int, whole: int) -> float | None:
    return round(part / whole * 100, 1) if whole else None


def drivers_week(days: int, today: date) -> dict[str, Any]:
    days = max(1, min(MAX_DAYS, days))
    first = (today - timedelta(days=days - 1)).isoformat()
    window = (first, today.isoformat())
    spjs = [
        s
        for s in SPJ_STORE.list()
        if window[0] <= s.date <= window[1] and s.status != "batal" and s.created_by != safety.SEED_CREATOR
    ]
    slots = _plan_slots() if spjs else {}
    starts: dict[tuple[str, str], datetime] = {}  # (truck, day) -> first duty event
    for raw in PRETRIP_STORE._records.all():
        at = _wib(raw.get("created_at"))
        if at and raw.get("truck_code") and window[0] <= at.date().isoformat() <= window[1]:
            key = (raw["truck_code"], at.date().isoformat())
            starts[key] = min(starts.get(key, at), at)

    drivers: dict[str, dict[str, Any]] = {}
    ends: dict[tuple[str, str], datetime] = {}
    for spj in spjs:
        row = drivers.setdefault(
            spj.driver_name or spj.truck_code,
            {"trucks": {}, "trips": 0, "stops": 0, "proved": 0, "gated": 0, "on_time": 0, "days": set()},
        )
        row["trucks"][spj.truck_code] = row["trucks"].get(spj.truck_code, 0) + 1
        row["days"].add(spj.date)
        for stop in spj.stops:
            if stop.status == "completed":
                row["stops"] += 1
                row["proved"] += bool(stop.evidence) and not stop.override
        activated = _wib(spj.activated_at)
        if activated:
            key = (spj.truck_code, activated.date().isoformat())
            starts[key] = min(starts.get(key, activated), activated)
        receipt_at = _wib((spj.receipt or {}).get("recorded_at"))
        if spj.receipt:
            row["trips"] += 1
        if receipt_at:
            key = (spj.truck_code, receipt_at.date().isoformat())
            ends[key] = max(ends.get(key, receipt_at), receipt_at)
            row.setdefault("duty_keys", set()).add(key)
        slot_end = _slot_end(spj, slots)
        arrived = safety._gate_arrival(spj) if slot_end else None
        if slot_end and arrived:
            row["gated"] += 1
            row["on_time"] += arrived <= slot_end

    out = []
    for name, row in drivers.items():
        duties = [
            safety._minutes(starts[key], ends[key])
            for key in sorted(row.get("duty_keys", ()))
            if key in starts and starts[key] <= ends[key]
        ]
        out.append(
            {
                "driver_name": name,
                "truck_code": max(row["trucks"], key=lambda code: (row["trucks"][code], code)),
                "trips": row["trips"],
                "proof_complete_pct": _pct(row["proved"], row["stops"]),
                "completed_stops": row["stops"],
                "on_time_pct": _pct(row["on_time"], row["gated"]),
                "on_time_n": row["gated"],
                "avg_duty_min": round(sum(duties) / len(duties)) if duties else None,
                "duty_days": len(duties),
                "sample_days": len(row["days"]),
            }
        )
    out.sort(key=lambda d: (-d["trips"], d["driver_name"]))
    return {
        "window_days": days,
        "from": window[0],
        "to": window[1],
        "drivers": out,
        "classification": "FIELD",
        "notes": {
            "trips": "SPJs with a weighbridge receipt",
            "proof_complete_pct": "completed stops closed with evidence; an override is not proof",
            "on_time_pct": "gate arrival at or before the planned gate-slot end (MODEL slot); plan SPJs only",
            "avg_duty_min": "first pre-trip or activation to the last receipt, per day with both",
        },
    }
