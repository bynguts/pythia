"""Gate-slot assignment for approved plan dispatches.

A planned truck's first TPST Bantargebang gate arrival is its shift start plus one
mean collection round, snapped to the 15-minute stagger slot. A slot holds what the
weighbridges clear in it (lanes x slot / weigh cycle). The rest of the gate's traffic
is the background: the observed daily arrivals (median ritasi, spread over the hours
of the metric's simulated current-practice day) minus the plan trips slotted for that
date, never below zero, so a plan's trucks are never counted twice. The background
arrives unstaggered, and the queue it builds carries into later slots (fluid backlog).

Placement, per truck in truck-code order:
- If the background alone fills every slot of the first hour from the natural slot,
  the gate is saturated: the truck keeps the roomiest of those slots (no long hold)
  and `capacity_model.saturated` says so.
- Otherwise it takes the first slot with room within the metric's stagger window
  (`stagger_slot_count()` slots, the same spread the staggered headline assumes), so
  a plan that carries most of the day's trips spreads the way the headline does.
- Either way a slot never holds more plan trucks than the weighbridges clear in it
  (`CAPACITY_PER_SLOT`): a full slot is skipped and the truck spills to the next slot
  of its shift with a place. A truck whose whole shift is full gets no slot, and
  `plan_gate_capacity` lists it as overflow.

Each Bantargebang slot carries `capacity_model.expected_wait_min`: the fluid model's
wait in that slot with the background and every slotted plan truck of the day.

A later slot is a later departure, not a wait at the gate: each slot carries
`depart_at`, the slot start minus `COLLECTION_ROUND_MEAN_H` (the metric's mean
depot -> collection round -> gate leg), and `shift_from_unscheduled_minutes`, how far
the stagger moved it from the unscheduled shift-start departure. Only the board's
live recommendations carry `hold_minutes`, and those stay within an hour.

Coherence with `queue_minutes_per_truck`: with no plan, the fluid model's mean wait
over the background day is ~57.7 min against the simulation's 57.1 baseline (the tests
hold it within 2 minutes). A plan carrying all observed trips fills both day shifts'
slots to capacity and overflows ~27 trips; its mean is ~2.9 min against the 5.6
staggered figure: the fluid model has no random travel or weigh times and never
overfills a slot, so it reads low when slots run at capacity (held within 3 minutes).

`occupied` only holds plans approved before this plan was proposed, so two plans
proposed for the same date before either is approved can share slots. The board
(`slot_board`, served by GET /api/gate/slots) is recomputed from the approved
plans, and its hold recommendations are what resolve such a clash.

Every constant comes from `queue_simulation`: these are modelled slots, not a
facility booking system. RDF trucks get a slot but use no weighbridge capacity.
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
    stagger_slot_count,
)

SLOTS_PER_DAY = 24 * 60 // STAGGER_SLOT_MINUTES
SLOTS_PER_HOUR = 60 // STAGGER_SLOT_MINUTES
# Trucks the weighbridges clear in one slot (4 lanes x 15 min / 2-min cycle = 30).
CAPACITY_PER_SLOT = WEIGHBRIDGE_LANES * STAGGER_SLOT_MINUTES / WEIGH_CYCLE_MINUTES
# Trucks the weighbridges clear per minute: drains the modelled backlog.
SERVICE_PER_MINUTE = WEIGHBRIDGE_LANES / WEIGH_CYCLE_MINUTES
# assumption: a hold longer than an hour stops being a departure nudge and becomes
# a different shift plan, so recommendations (and placements pushed by the background
# queue) look at most this many slots ahead.
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
    """Gate arrivals per clock hour of the metric's simulated current-practice day.

    Its total is the observed median daily ritasi at Bantargebang.
    """
    profile = hourly_queue_profile()
    if not profile:
        return [0.0] * 24
    by_hour = [0.0] * 24
    for row in profile:
        by_hour[int(row["hour"])] = float(row["arrivals"])
    return by_hour


def background_loads(planned_arrivals: int = 0) -> list[float]:
    """Background arrivals per slot of a day: the day's arrivals minus `planned_arrivals`.

    The remainder keeps the unstaggered hourly shape, spread evenly within each
    hour. The model has no weekday or seasonal shape, so every date reads the same.
    """
    by_hour = _background_by_hour()
    total = sum(by_hour)
    share = max(0.0, total - planned_arrivals) / total if total > 0 else 0.0
    return [by_hour[i // SLOTS_PER_HOUR] * share / SLOTS_PER_HOUR for i in range(SLOTS_PER_DAY)]


def coverage(planned_arrivals: int) -> dict[str, Any]:
    """How much of the day's gate traffic the approved plans carry (and so can stagger)."""
    total = sum(_background_by_hour())
    return {
        "planned_gate_arrivals": planned_arrivals,
        "daily_arrivals": round(total),
        "share": round(min(1.0, planned_arrivals / total), 3) if total > 0 else None,
        "daily_arrivals_basis": (
            "observed median daily ritasi at TPST Bantargebang (weighing data), spread over "
            "the hours of the simulated current-practice day"
        ),
    }


def _background_demand(planned_arrivals: int) -> list[float]:
    """Background trucks at the weighbridge per slot: its arrivals plus the queue it carries in."""
    arrivals = background_loads(planned_arrivals)
    return [a + q for a, q in zip(arrivals, queue_carried_in(arrivals), strict=True)]


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


def _natural_slot(plan_date: date, start_index: int) -> tuple[datetime, datetime]:
    """(shift start, first gate arrival snapped to its slot); the night shift lands the next day."""
    shift_start = datetime.combine(plan_date, datetime.min.time()) + timedelta(
        minutes=start_index * STAGGER_SLOT_MINUTES
    )
    arrival = shift_start + timedelta(hours=COLLECTION_ROUND_MEAN_H)
    natural = arrival.replace(
        minute=arrival.minute - arrival.minute % STAGGER_SLOT_MINUTES, second=0, microsecond=0
    )
    return shift_start, natural


def assign_gate_slots(dispatches: list[dict], plan_date: date, occupied: list[dict] = ()) -> dict[str, dict]:
    """Map truck_code -> gate slot for a plan's dispatches; see the module docstring.

    `dispatches` are plan dispatches (`fields.stops` with `shift`, `window` and
    `facility`; the first trip sets the slot). `occupied` are the `gate_slot`s
    of plans already approved for the same date. Deterministic: trucks are
    placed in truck-code order. A truck whose shift has no clock window gets no
    slot. When no slot in the search has room, the truck keeps the one with the
    most room left and `capacity_model.over_capacity` says so; a slot that already
    holds `CAPACITY_PER_SLOT` plan trucks is never chosen.
    """
    taken = _occupied_counts(occupied)
    trucks = []
    for dispatch in sorted(dispatches, key=lambda d: str(d.get("truck_code", ""))):
        stop = _first_stop(dispatch)
        start_index = slot_index_of((stop or {}).get("window", ""))
        if dispatch.get("truck_code") and stop is not None and start_index is not None:
            trucks.append(
                (dispatch["truck_code"], stop.get("facility"), *_natural_slot(plan_date, start_index))
            )

    # Plan trips per slot date, this plan's and the approved ones': the background is the rest.
    planned_per_day: dict[str, int] = defaultdict(int)
    for (day, _slot), count in taken.items():
        planned_per_day[day] += count
    for _truck, facility, _start, natural in trucks:
        if is_bantargebang(facility):
            planned_per_day[natural.date().isoformat()] += 1
    demand: dict[str, list[float]] = {}

    def background_at(moment: datetime) -> float:
        day = moment.date().isoformat()
        if day not in demand:
            demand[day] = _background_demand(planned_per_day[day])
        return demand[day][_index(moment)]

    stagger_slots = stagger_slot_count()
    out: dict[str, dict] = {}
    for truck_code, facility, shift_start, natural in trucks:
        chosen = natural
        capacity_model = None
        if is_bantargebang(facility):
            shift_end = shift_start + timedelta(hours=SHIFT_HOURS)
            steps = [
                moment
                for step in range(max(stagger_slots, MAX_HOLD_SLOTS))
                if (moment := natural + timedelta(minutes=step * STAGGER_SLOT_MINUTES)) < shift_end
            ] or [natural]
            first_hour = steps[:MAX_HOLD_SLOTS]
            saturated = all(CAPACITY_PER_SLOT - background_at(m) < 1 for m in first_hour)
            search = first_hour if saturated else steps[:stagger_slots]
            places = [m for m in search if taken[_key(m)] < CAPACITY_PER_SLOT] or [
                m for m in steps if taken[_key(m)] < CAPACITY_PER_SLOT
            ][:1]
            if not places:
                continue  # overflow: every slot of the shift already holds a full slot of plan trucks
            best: tuple[float, datetime] | None = None
            for candidate in places:
                room = CAPACITY_PER_SLOT - background_at(candidate) - taken[_key(candidate)]
                if best is None or room > best[0]:
                    best = (room, candidate)
                if room >= 1:
                    break
            room, chosen = best
            capacity_model = {
                "capacity_per_slot": CAPACITY_PER_SLOT,
                "background_load": round(background_at(chosen), 2),
                "occupied": taken[_key(chosen)],
                "over_capacity": room < 1,
                "saturated": saturated,
                "basis": WEIGHBRIDGE_ASSUMPTION,
            }
            taken[_key(chosen)] += 1
        index = _index(chosen)
        start, end = slot_clock(index)
        out[truck_code] = {
            "facility": facility,
            "slot_index": index,
            "start": start,
            "end": end,
            "date": chosen.date().isoformat(),
            "depart_at": _depart_at(chosen),
            "depart_date": (chosen - timedelta(hours=COLLECTION_ROUND_MEAN_H)).date().isoformat(),
            "shift_from_unscheduled_minutes": int((chosen - natural).total_seconds() // 60),
            "capacity_model": capacity_model,
            "classification": "MODEL_OUTPUT",
        }

    waits: dict[str, list[float]] = {}
    for slot in out.values():
        if slot["capacity_model"] is None:
            continue
        day = slot["date"]
        if day not in waits:
            background = background_loads(planned_per_day[day])
            waits[day] = expected_waits([background[i] + taken[(day, i)] for i in range(SLOTS_PER_DAY)])
        slot["capacity_model"]["expected_wait_min"] = waits[day][slot["slot_index"]]
    return out


def plan_gate_capacity(dispatches: list[dict]) -> dict[str, Any]:
    """What a plan's Bantargebang gate slots say about the weighbridge capacity.

    Read from each dispatch's `fields.gate_slot`: the most plan trucks in one slot,
    the slots the background alone saturates or that run over capacity, and the
    overflow (trucks whose shift had no slot with a place left, so they have none).
    `coverage` is the share of the day's gate arrivals the plan carries: the rest
    arrive unstaggered, which is why a small plan cannot reach the city-wide
    staggered figure of the queue metric.
    """
    per_slot: dict[tuple[str, int], int] = defaultdict(int)
    saturated: set[tuple[str, str]] = set()
    over: set[tuple[str, str]] = set()
    overflow = []
    for dispatch in dispatches:
        slot = (dispatch.get("fields") or {}).get("gate_slot")
        stop = _first_stop(dispatch)
        if not slot:
            if (
                stop
                and is_bantargebang(stop.get("facility"))
                and slot_index_of(stop.get("window")) is not None
            ):
                overflow.append(dispatch.get("truck_code"))
            continue
        model = slot.get("capacity_model")
        if not is_bantargebang(slot.get("facility")) or not model:
            continue
        per_slot[(slot["date"], int(slot["slot_index"]))] += 1
        if model.get("saturated"):
            saturated.add((slot["date"], slot["start"]))
        if model.get("over_capacity"):
            over.add((slot["date"], slot["start"]))
    return {
        "capacity_per_slot": CAPACITY_PER_SLOT,
        "max_trucks_per_slot": max(per_slot.values(), default=0),
        "saturated": bool(saturated),
        "saturated_slots": [start for _, start in sorted(saturated)],
        "over_capacity_slots": [start for _, start in sorted(over)],
        "overflow_trucks": sorted(overflow),
        "coverage": coverage(sum(per_slot.values())),
        "basis": WEIGHBRIDGE_ASSUMPTION,
        "classification": "MODEL_OUTPUT",
    }


def _depart_at(slot_start: datetime) -> str:
    """Depot departure for a gate slot: its start minus one mean collection round.

    "HH:MM", prefixed with the date when it falls on another day than the slot.
    """
    leave = slot_start - timedelta(hours=COLLECTION_ROUND_MEAN_H)
    clock = f"{leave.hour:02d}:{leave.minute:02d}"
    return clock if leave.date() == slot_start.date() else f"{leave.date().isoformat()} {clock}"


def _key(moment: datetime) -> tuple[str, int]:
    return moment.date().isoformat(), _index(moment)


def _index(moment: datetime) -> int:
    return (moment.hour * 60 + moment.minute) // STAGGER_SLOT_MINUTES


def slot_board(slot_date: date, planned: list[dict[str, Any]]) -> dict[str, Any]:
    """The weighbridge slots of `slot_date` and the holds that lower a planned truck's wait.

    `planned` items are `{truck_code, gate_slot}` from approved plans, already
    filtered to slots dated `slot_date`. A truck in a slot whose arrivals plus the
    queue carried into it exceed the weighbridge capacity is held into the nearest
    later slot (at most MAX_HOLD_SLOTS ahead) that has room and a lower modelled
    wait; holds are decided greedily in slot then truck-code order, each seeing the
    earlier ones. When no slot within that hour qualifies, nothing is recommended
    for the truck and its slot is listed in `saturated_slots`: a longer hold would
    be a different shift plan, not a nudge.
    """
    day = slot_date.isoformat()
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
    background = background_loads(sum(planned_counts))
    loads = [background[i] + planned_counts[i] for i in range(SLOTS_PER_DAY)]
    waits = expected_waits(loads)
    base_waits, base_queue = list(waits), queue_carried_in(loads)

    def demand(slot_loads: list[float]) -> list[float]:
        return [a + q for a, q in zip(slot_loads, queue_carried_in(slot_loads), strict=True)]

    recommendations = []
    saturated_slots: list[str] = []
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
            else:
                if slot_clock(index)[0] not in saturated_slots:
                    saturated_slots.append(slot_clock(index)[0])

    planned_indexes = sorted(by_slot)
    impact = _impact(by_slot, recommendations, base_waits, waits, planned_indexes)
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
    base_loads = [background[i] + planned_counts[i] for i in range(SLOTS_PER_DAY)]
    arrivals = sum(base_loads)
    planned_total = sum(planned_counts)
    return {
        "date": day,
        "slot_minutes": STAGGER_SLOT_MINUTES,
        "capacity_per_slot": CAPACITY_PER_SLOT,
        "coverage": coverage(planned_total),
        # As planned, before any recommended hold.
        "modelled_wait": {
            "mean_per_truck_min": (
                round(sum(w * n for w, n in zip(base_waits, base_loads, strict=True)) / arrivals, 1)
                if arrivals > 0
                else None
            ),
            "mean_per_planned_truck_min": (
                round(sum(w * n for w, n in zip(base_waits, planned_counts, strict=True)) / planned_total, 1)
                if planned_total
                else None
            ),
            "classification": "SIMULATED",
        },
        "slots": slots,
        "other_facilities": others,
        "recommendations": recommendations,
        "impact": impact,
        "saturated": bool(saturated_slots),
        "saturated_slots": saturated_slots,
        "wait_method": WAIT_METHOD,
        "capacity_basis": WEIGHBRIDGE_ASSUMPTION,
        "classification": "SIMULATED",
        "source": SOURCE,
    }


def _impact(
    by_slot: dict[int, list[str]],
    recommendations: list[dict[str, Any]],
    base_waits: list[float],
    final_waits: list[float],
    planned_indexes: list[int],
) -> dict[str, Any] | None:
    """The board's worst modelled waits as planned and with every recommended hold applied.

    ``peak_wait`` is the worst slot of the board window; ``longest_wait`` the worst
    wait any planned truck meets in its own slot. None when no truck is planned.
    """
    if not planned_indexes:
        return None
    window = range(planned_indexes[0], min(SLOTS_PER_DAY, planned_indexes[-1] + MAX_HOLD_SLOTS + 1))
    moved = {(r["truck_code"], int(r["id"].rsplit("-", 1)[1])): r["to_slot_index"] for r in recommendations}
    trucks = [(truck, index) for index, codes in by_slot.items() for truck in codes]
    return {
        "peak_wait_before": max(base_waits[i] for i in window),
        "peak_wait_after": max(final_waits[i] for i in window),
        "longest_wait_before": max(base_waits[i] for _, i in trucks),
        "longest_wait_after": max(final_waits[moved.get((t, i), i)] for t, i in trucks),
        "holds_applied": len(recommendations),
        "classification": "SIMULATED",
    }
