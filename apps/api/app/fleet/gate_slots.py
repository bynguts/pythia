"""Gate-slot assignment for approved plan dispatches (wave 12 lane C).

A planned truck's first TPST Bantargebang gate arrival is its shift start plus one
mean collection round, snapped to the 15-minute stagger slot. Each slot holds what
the weighbridges clear in it (lanes x slot / weigh cycle) minus the simulated
background load of the metric's baseline day (its arrivals in the slot plus the
queue they carry into it) and the trucks of plans already approved for that date;
a truck with no room moves to the next slot that has some.
Every constant comes from `queue_simulation`: these are modelled slots, not a
facility booking system. RDF trucks get a slot but use no weighbridge capacity.

`occupied` only holds plans approved before this plan was proposed, so two plans
proposed for the same date before either is approved can share slots. The board
(`slot_board`, served by GET /api/gate/slots) is recomputed from the approved
plans, and its hold recommendations are what resolve such a clash.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from app.core.units import SHIFT_HOURS
from app.fleet.queue_simulation import (
    COLLECTION_ROUND_MEAN_H,
    STAGGER_SLOT_MINUTES,
    WEIGH_CYCLE_MINUTES,
    WEIGHBRIDGE_ASSUMPTION,
    WEIGHBRIDGE_LANES,
    hourly_queue_profile,
)

SLOTS_PER_DAY = 24 * 60 // STAGGER_SLOT_MINUTES
SLOTS_PER_HOUR = 60 // STAGGER_SLOT_MINUTES
# Trucks the weighbridges clear in one slot (4 lanes x 15 min / 2-min cycle = 30).
CAPACITY_PER_SLOT = WEIGHBRIDGE_LANES * STAGGER_SLOT_MINUTES / WEIGH_CYCLE_MINUTES
# Trucks the weighbridges clear per minute: drains the modelled backlog.
SERVICE_PER_MINUTE = WEIGHBRIDGE_LANES / WEIGH_CYCLE_MINUTES
# assumption: a hold longer than an hour stops being a departure nudge and becomes
# a different shift plan, so recommendations look at most this many slots ahead.
MAX_HOLD_SLOTS = 4
WAIT_METHOD = (
    "fluid backlog per 15-min slot: arrivals above the weighbridge capacity carry over "
    "to the next slot; expected wait = backlog at slot end / trucks cleared per minute"
)
SOURCE = "approved plan gate slots + simulated background arrivals (queue_simulation)"

_WINDOW_START = re.compile(r"^\s*(\d{1,2}):(\d{2})")


def is_bantargebang(facility: str | None) -> bool:
    return "bantargebang" in str(facility or "").lower()


def _background_by_hour() -> list[float]:
    """Simulated background gate arrivals per clock hour (the metric's baseline day)."""
    profile = hourly_queue_profile()
    if not profile:
        return [0.0] * 24
    by_hour = [0.0] * 24
    for row in profile:
        by_hour[int(row["hour"])] = float(row["arrivals"])
    return by_hour


def background_loads() -> list[float]:
    """Simulated background arrivals per slot of a day, spread evenly over each hour.

    The model has no weekday or seasonal shape, so every date reads the same profile.
    """
    by_hour = _background_by_hour()
    return [by_hour[i // SLOTS_PER_HOUR] / SLOTS_PER_HOUR for i in range(SLOTS_PER_DAY)]


def queue_carried_in(loads: list[float]) -> list[float]:
    """Trucks still queued as each slot starts (the backlog carried over from earlier slots)."""
    backlog = 0.0
    carried = []
    for load in loads:
        carried.append(backlog)
        backlog = max(0.0, backlog + load - CAPACITY_PER_SLOT)
    return carried


def slot_clock(index: int) -> tuple[str, str]:
    start = index * STAGGER_SLOT_MINUTES
    end = (start + STAGGER_SLOT_MINUTES) % (24 * 60)
    return f"{start // 60:02d}:{start % 60:02d}", f"{end // 60:02d}:{end % 60:02d}"


def slot_index_of(clock: str) -> int | None:
    match = _WINDOW_START.match(str(clock or ""))
    if not match:
        return None
    return (int(match.group(1)) * 60 + int(match.group(2))) // STAGGER_SLOT_MINUTES


def expected_waits(loads: list[float]) -> list[float]:
    """Modelled weighbridge wait (minutes) per slot from its arrivals; see WAIT_METHOD."""
    backlog = 0.0
    waits = []
    for load in loads:
        backlog = max(0.0, backlog + load - CAPACITY_PER_SLOT)
        waits.append(round(backlog / SERVICE_PER_MINUTE, 1))
    return waits


def _first_stop(dispatch: dict[str, Any]) -> dict[str, Any] | None:
    fields = dispatch.get("fields") or dispatch
    stops = fields.get("stops") or []
    return min(stops, key=lambda s: s.get("order", 0)) if stops else None


def _occupied_counts(occupied) -> dict[tuple[str, int], int]:
    """Bantargebang trucks already holding each (date, slot index)."""
    counts: dict[tuple[str, int], int] = defaultdict(int)
    for item in occupied or ():
        slot = (item.get("fields") or {}).get("gate_slot") if "fields" in (item or {}) else item
        if not slot or not is_bantargebang(slot.get("facility")):
            continue
        index = slot.get("slot_index")
        if index is None:
            index = slot_index_of(slot.get("start"))
        if index is not None and slot.get("date"):
            counts[(str(slot["date"]), int(index))] += 1
    return counts


def assign_gate_slots(dispatches: list[dict], plan_date: date, occupied: list[dict] = ()) -> dict[str, dict]:
    """Map truck_code -> gate slot for a plan's dispatches.

    `dispatches` are plan dispatches (`fields.stops` with `shift`, `window` and
    `facility`; the first trip sets the slot). `occupied` are the `gate_slot`s
    of plans already approved for the same date. Deterministic: trucks are
    placed in truck-code order. A truck whose shift has no clock window gets no
    slot. When no slot in the shift has room, the truck keeps the one with the
    most room left (it may be over capacity) and `capacity_model.over_capacity`
    says so.
    """
    taken = _occupied_counts(occupied)
    background: list[float] | None = None
    shift_slots = int(SHIFT_HOURS * SLOTS_PER_HOUR)
    out: dict[str, dict] = {}
    for dispatch in sorted(dispatches, key=lambda d: str(d.get("truck_code", ""))):
        truck_code = dispatch.get("truck_code")
        stop = _first_stop(dispatch)
        start_index = slot_index_of((stop or {}).get("window", ""))
        if not truck_code or stop is None or start_index is None:
            continue
        facility = stop.get("facility")
        shift_start = datetime.combine(plan_date, datetime.min.time()) + timedelta(
            minutes=start_index * STAGGER_SLOT_MINUTES
        )
        arrival = shift_start + timedelta(hours=COLLECTION_ROUND_MEAN_H)
        # Snapped down to the slot the arrival falls in; the night shift lands the next day.
        natural = arrival.replace(
            minute=arrival.minute - arrival.minute % STAGGER_SLOT_MINUTES, second=0, microsecond=0
        )
        chosen = natural
        capacity_model = None
        if is_bantargebang(facility):
            if background is None:
                arrivals = background_loads()
                background = [a + q for a, q in zip(arrivals, queue_carried_in(arrivals), strict=True)]
            shift_end = shift_start + timedelta(hours=SHIFT_HOURS)
            best: tuple[float, datetime] | None = None
            for step in range(shift_slots):
                candidate = natural + timedelta(minutes=step * STAGGER_SLOT_MINUTES)
                if candidate >= shift_end:
                    break
                key = (candidate.date().isoformat(), _index(candidate))
                room = CAPACITY_PER_SLOT - background[key[1]] - taken[key]
                if best is None or room > best[0]:
                    best = (room, candidate)
                if room >= 1:
                    break
            room, chosen = best
            key = (chosen.date().isoformat(), _index(chosen))
            capacity_model = {
                "capacity_per_slot": CAPACITY_PER_SLOT,
                "background_load": round(background[key[1]], 2),
                "occupied": taken[key],
                "over_capacity": room < 1,
                "basis": WEIGHBRIDGE_ASSUMPTION,
            }
            taken[key] += 1
        index = _index(chosen)
        start, end = slot_clock(index)
        out[truck_code] = {
            "facility": facility,
            "slot_index": index,
            "start": start,
            "end": end,
            "date": chosen.date().isoformat(),
            "hold_minutes": int((chosen - natural).total_seconds() // 60),
            "capacity_model": capacity_model,
            "classification": "MODEL_OUTPUT",
        }
    return out


def _index(moment: datetime) -> int:
    return (moment.hour * 60 + moment.minute) // STAGGER_SLOT_MINUTES


def slot_board(slot_date: date, planned: list[dict[str, Any]]) -> dict[str, Any]:
    """The weighbridge slots of `slot_date` and the holds that lower a planned truck's wait.

    `planned` items are `{truck_code, gate_slot}` from approved plans, already
    filtered to slots dated `slot_date`. A truck in a slot whose arrivals plus the
    queue carried into it exceed the weighbridge capacity is held into the nearest later slot (at most
    MAX_HOLD_SLOTS ahead) that has room and a lower modelled wait; holds are
    decided greedily in slot then truck-code order, each seeing the earlier ones.
    """
    day = slot_date.isoformat()
    background = background_loads()
    by_slot: dict[int, list[str]] = defaultdict(list)
    others = []
    for item in planned:
        slot = item["gate_slot"]
        if is_bantargebang(slot.get("facility")):
            by_slot[int(slot["slot_index"])].append(item["truck_code"])
        else:
            others.append({"truck_code": item["truck_code"], **slot})
    for trucks in by_slot.values():
        trucks.sort()

    planned_counts = [len(by_slot.get(i, ())) for i in range(SLOTS_PER_DAY)]
    loads = [background[i] + planned_counts[i] for i in range(SLOTS_PER_DAY)]
    waits = expected_waits(loads)
    base_waits, base_queue = list(waits), queue_carried_in(loads)

    def demand(slot_loads: list[float]) -> list[float]:
        return [a + q for a, q in zip(slot_loads, queue_carried_in(slot_loads), strict=True)]

    recommendations = []
    for index in sorted(by_slot):
        need = demand(loads)
        if need[index] <= CAPACITY_PER_SLOT:
            continue
        excess = math.ceil(need[index] - CAPACITY_PER_SLOT)
        # A truck listed twice in one slot (two approved plans) gets one recommendation.
        for truck_code in list(dict.fromkeys(by_slot[index]))[:excess]:
            for target in range(index + 1, min(SLOTS_PER_DAY, index + MAX_HOLD_SLOTS + 1)):
                trial = list(loads)
                trial[index] -= 1
                trial[target] += 1
                if demand(trial)[target] > CAPACITY_PER_SLOT:
                    continue
                trial_waits = expected_waits(trial)
                if trial_waits[target] >= waits[index]:
                    continue
                from_start, _ = slot_clock(index)
                to_start, to_end = slot_clock(target)
                recommendations.append(
                    {
                        "id": f"rec-{day}-{truck_code}-{index}",
                        "truck_code": truck_code,
                        "action": "hold",
                        "hold_minutes": (target - index) * STAGGER_SLOT_MINUTES,
                        "date": day,
                        "facility": "TPST Bantargebang",
                        "from_slot": from_start,
                        "to_slot": to_start,
                        "to_slot_end": to_end,
                        "to_slot_index": target,
                        "expected_wait_reduction_min": round(waits[index] - trial_waits[target], 1),
                        "reason_code": "slot_over_capacity",
                        "reason": (
                            f"slot {from_start}: {need[index]:.1f} modelled trucks at the weighbridge "
                            f"(arrivals + queue) > {CAPACITY_PER_SLOT:g} it clears"
                        ),
                        "accepted": False,
                        "dispatch_id": None,
                    }
                )
                loads, waits = trial, trial_waits
                break

    planned_indexes = sorted(by_slot)
    slots = []
    if planned_indexes:
        last = min(SLOTS_PER_DAY - 1, planned_indexes[-1] + MAX_HOLD_SLOTS)
        for index in range(planned_indexes[0], last + 1):
            start, end = slot_clock(index)
            slots.append(
                {
                    "index": index,
                    "date": day,
                    "start": start,
                    "end": end,
                    "background_load": round(background[index], 2),
                    "queue_carried_in": round(base_queue[index], 2),
                    "planned_trucks": by_slot.get(index, []),
                    "expected_wait_min": base_waits[index],
                }
            )
    return {
        "date": day,
        "slot_minutes": STAGGER_SLOT_MINUTES,
        "capacity_per_slot": CAPACITY_PER_SLOT,
        "slots": slots,
        "other_facilities": others,
        "recommendations": recommendations,
        "wait_method": WAIT_METHOD,
        "capacity_basis": WEIGHBRIDGE_ASSUMPTION,
        "classification": "SIMULATED",
        "source": SOURCE,
    }
