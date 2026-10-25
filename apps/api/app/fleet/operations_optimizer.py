"""Integrated operations optimizer: connect Case 2 forecast demand to Case 1 fleet.

Given predicted per-area waste demand, the available fleet and the planning
rules for the plan date (``operations_rules.PlanningRules``), produce a day plan
of truck trips (rit). OR-Tools CP-SAT decides how many trips each area sends in
each shift to each facility; the R7/R8 limits are HARD constraints of that model:

- the per-kecamatan daily rit quota,
- the per-shift and daily gate caps at TPST Bantargebang (the daily cap shrinks
  with the controlled-landfill residue share for the plan date),
- the facility intake limits (RDF Rorotan: tons per day actually in use),
- facility acceptance (RDF Rorotan: leachate-free compactors only),
- per-truck trips per shift and per day.

Demand the limits cannot serve is reported as a labelled shortfall ("N t
unassigned") instead of being hidden or overflowed. An area never receives
more trip capacity than it needs: the assigned capacity stays below demand
plus one truckload, and every trip costs a little in the objective.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from ortools.sat.python import cp_model

from app.fleet.operations_rules import PlanningRules

# Covered tons dominate the objective; the per-trip cost only breaks ties
# (fewer and earlier trips) and never outweighs one ton of covered demand.
_TONS_WEIGHT = 1000


@dataclass
class Vehicle:
    truck_code: str
    capacity_tons: float
    available: bool = True
    permit_compliant: bool = True
    vehicle_type: str = ""
    leachate_free: bool = False


@dataclass
class Demand:
    area: str
    tons: float
    lat: float
    lng: float
    priority: int = 1
    label: str = ""
    city: str | None = None


@dataclass
class Assignment:
    """One trip (rit): a truck hauls one load from an area in a shift."""

    truck_code: str
    area: str
    assigned_tons: float
    evidence: dict[str, Any]
    shift: str = ""
    facility: str = ""
    trip_index: int = 1


@dataclass
class OperationalPlan:
    plan_id: str
    assignments: list[Assignment] = field(default_factory=list)
    unmet_reasons: list[str] = field(default_factory=list)
    total_demand_tons: float = 0.0
    total_assigned_tons: float = 0.0
    quota_usage: list[dict[str, Any]] = field(default_factory=list)
    facility_usage: list[dict[str, Any]] = field(default_factory=list)
    unassigned_tons: float = 0.0

    @property
    def feasible(self) -> bool:
        """True when every ton of demand fits inside the limits."""
        return self.unassigned_tons < 0.5 and not self.unmet_reasons


def build_operational_plan(
    demands: list[Demand],
    vehicles: list[Vehicle],
    require_permit: bool = True,
    rules: PlanningRules | None = None,
) -> OperationalPlan:
    """Assign truck trips to demand areas with CP-SAT under hard quotas and caps."""
    rules = rules or PlanningRules.unconstrained()
    plan = OperationalPlan(
        plan_id=f"PLAN-{uuid4().hex[:8]}",
        total_demand_tons=round(sum(d.tons for d in demands), 2),
    )
    usable = sorted(
        (v for v in vehicles if v.available and (v.permit_compliant or not require_permit)),
        key=lambda v: v.truck_code,
    )
    if not usable:
        plan.unmet_reasons.append("no_permit_compliant_vehicle" if require_permit else "no_available_vehicle")
        plan.unassigned_tons = plan.total_demand_tons
        return plan
    if not demands:
        return plan

    shifts = [s["id"] for s in rules.shifts]
    facilities = rules.facilities
    # Trucks with the same capacity and the same facility acceptance are
    # interchangeable, so the model counts trips per class; trucks are named
    # afterwards (see _name_trucks), which keeps the model small and exact.
    classes: dict[tuple, list[Vehicle]] = defaultdict(list)
    for v in usable:
        signature = (
            int(v.capacity_tons),
            tuple(f.accepts(v.vehicle_type, v.leachate_free) for f in facilities),
        )
        classes[signature].append(v)
    class_keys = sorted(classes)
    max_cap = max(cap for cap, _ in class_keys)

    model = cp_model.CpModel()
    n: dict[tuple[int, int, int, int], Any] = {}
    for di, d in enumerate(demands):
        for si in range(len(shifts)):
            for fi, fac in enumerate(facilities):
                if not fac.serves(d.city):
                    continue
                for ci, key in enumerate(class_keys):
                    if key[1][fi]:
                        upper = len(classes[key]) * rules.max_rit_per_truck_per_shift
                        n[(di, si, fi, ci)] = model.NewIntVar(0, upper, f"n_{di}_{si}_{fi}_{ci}")

    def total(predicate) -> Any:
        return sum(var for idx, var in n.items() if predicate(*idx))

    def at_most(expr: Any, bound: int) -> None:
        # An expression with no variables (nothing can be sent there) is a
        # plain int and needs no constraint.
        if not isinstance(expr, int):
            model.Add(expr <= bound)

    # Per-truck limits, expressed per vehicle class.
    for ci, key in enumerate(class_keys):
        fleet = len(classes[key])
        for si in range(len(shifts)):
            at_most(
                total(lambda d, s, f, c, si=si, ci=ci: s == si and c == ci),
                fleet * rules.max_rit_per_truck_per_shift,
            )
        at_most(total(lambda d, s, f, c, ci=ci: c == ci), fleet * rules.max_rit_per_truck_per_day)

    # Facility caps: per-shift gate cap, daily rit cap, daily intake tons.
    for fi, fac in enumerate(facilities):
        if fac.shift_rit_cap is not None:
            for si in range(len(shifts)):
                at_most(total(lambda d, s, f, c, si=si, fi=fi: s == si and f == fi), fac.shift_rit_cap)
        if fac.daily_rit_cap is not None:
            at_most(total(lambda d, s, f, c, fi=fi: f == fi), fac.daily_rit_cap)
        if fac.daily_tons_cap is not None:
            at_most(
                sum(class_keys[c][0] * var for (d, s, f, c), var in n.items() if f == fi), fac.daily_tons_cap
            )

    covered = []
    trips_per_area = []
    for di, d in enumerate(demands):
        demand_tons = int(round(d.tons))
        trips = total(lambda dd, s, f, c, di=di: dd == di)
        capacity = sum(class_keys[c][0] * var for (dd, s, f, c), var in n.items() if dd == di)
        quota = rules.quota_for(d.area)
        if quota is not None:
            at_most(trips, quota)  # R7: the kecamatan quota is never exceeded
        # Audit open question 2: no superfluous trips. The capacity sent to an
        # area stays below its demand plus one full truckload.
        at_most(capacity, demand_tons + max_cap - 1)
        cov = model.NewIntVar(0, max(demand_tons, 0), f"cov_{di}")
        model.Add(cov <= capacity)
        covered.append(cov)
        trips_per_area.append(trips)

    trip_cost = sum((1 + s) * var for (d, s, f, c), var in n.items())
    model.Maximize(
        sum(_TONS_WEIGHT * demands[di].priority * covered[di] for di in range(len(demands))) - trip_cost
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 5.0
    solver.parameters.num_workers = 1  # deterministic plans for the same inputs
    solver.parameters.random_seed = 0
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        plan.unmet_reasons.append("no_feasible_assignment")
        plan.unassigned_tons = plan.total_demand_tons
        return plan

    counts = {idx: solver.Value(var) for idx, var in n.items() if solver.Value(var) > 0}
    covered_tons = [float(solver.Value(c)) for c in covered]
    plan.assignments = _name_trucks(counts, demands, shifts, facilities, class_keys, classes, covered_tons)
    plan.total_assigned_tons = round(sum(a.assigned_tons for a in plan.assignments), 2)

    facility_trips = defaultdict(int)
    facility_shift_trips = defaultdict(int)
    facility_tons = defaultdict(int)
    for (_di, si, fi, ci), count in counts.items():
        facility_trips[fi] += count
        facility_shift_trips[(fi, si)] += count
        facility_tons[fi] += count * class_keys[ci][0]
    saturated = set()
    for fi, fac in enumerate(facilities):
        shift_used = [facility_shift_trips[(fi, si)] for si in range(len(shifts))]
        full = (
            (fac.daily_rit_cap is not None and facility_trips[fi] >= fac.daily_rit_cap)
            or (fac.shift_rit_cap is not None and all(u >= fac.shift_rit_cap for u in shift_used))
            or (
                fac.daily_tons_cap is not None
                and facility_tons[fi] + min(k[0] for k in class_keys) > fac.daily_tons_cap
            )
        )
        if full:
            saturated.add(fi)
        plan.facility_usage.append(
            {
                "facility": fac.name,
                "display_name": fac.display_name,
                "trips": facility_trips[fi],
                "tons_capacity_sent": facility_tons[fi],
                "trips_by_shift": dict(zip(shifts, shift_used, strict=True)),
                "daily_rit_cap": fac.daily_rit_cap,
                "shift_rit_cap": fac.shift_rit_cap,
                "daily_tons_cap": fac.daily_tons_cap,
                "at_limit": full,
            }
        )

    fleet_full = all(
        sum(count for (d, s, f, c), count in counts.items() if c == ci)
        >= len(classes[key]) * rules.max_rit_per_truck_per_day
        for ci, key in enumerate(class_keys)
    )
    unassigned_total = 0.0
    for di, d in enumerate(demands):
        used = sum(count for (dd, s, f, c), count in counts.items() if dd == di)
        quota = rules.quota_for(d.area)
        unassigned = round(max(0.0, d.tons - covered_tons[di]), 1)
        binding = None
        if unassigned >= 0.5:
            serving = [fi for fi, fac in enumerate(facilities) if fac.serves(d.city)]
            if quota is not None and used >= quota:
                binding = "kecamatan_quota"
            elif not serving:
                binding = "no_accepting_facility"
            elif all(fi in saturated for fi in serving):
                binding = "facility_limit"
            elif fleet_full:
                binding = "fleet_capacity"
            else:
                binding = "facility_limit"
            plan.unmet_reasons.append(f"{binding}:{d.area}")
            unassigned_total += unassigned
        plan.quota_usage.append(
            {
                "area": d.area,
                "label": d.label or d.area,
                "demand_tons": round(d.tons, 1),
                "assigned_tons": round(covered_tons[di], 1),
                "unassigned_tons": unassigned if unassigned >= 0.5 else 0.0,
                "rit_used": used,
                "rit_needed": math.ceil(max(0.0, d.tons) / max_cap) if d.tons > 0 else 0,
                "quota_rit_per_day": quota,
                "quota_source": rules.quota_source_for(d.area),
                "binding_limit": binding,
            }
        )
    plan.unassigned_tons = round(unassigned_total, 1)
    return plan


def _name_trucks(
    counts: dict[tuple[int, int, int, int], int],
    demands: list[Demand],
    shifts: list[str],
    facilities: list,
    class_keys: list[tuple],
    classes: dict[tuple, list[Vehicle]],
    covered_tons: list[float],
) -> list[Assignment]:
    """Give each counted trip a concrete truck.

    Within a class, trips are dealt round-robin over the class's trucks, shift
    by shift. A shift holds at most fleet x per-shift trips, so no truck gets
    more than its per-shift limit, and the day total is at most fleet x per-day
    trips, so no truck exceeds its daily limit either.
    """
    trips: list[tuple[int, int, int, Vehicle]] = []
    for ci, key in enumerate(class_keys):
        fleet = classes[key]
        pointer = 0
        for si in range(len(shifts)):
            for (di, s, fi, c), count in sorted(counts.items()):
                if s != si or c != ci:
                    continue
                for _ in range(count):
                    trips.append((di, si, fi, fleet[pointer % len(fleet)]))
                    pointer += 1

    remaining = list(covered_tons)
    per_truck: dict[str, int] = defaultdict(int)
    out = []
    for di, si, fi, vehicle in sorted(trips, key=lambda t: (t[1], t[0], t[3].truck_code)):
        load = round(min(vehicle.capacity_tons, max(0.0, remaining[di])), 1)
        remaining[di] -= load
        per_truck[vehicle.truck_code] += 1
        d = demands[di]
        out.append(
            Assignment(
                truck_code=vehicle.truck_code,
                area=d.area,
                assigned_tons=load,
                shift=shifts[si],
                facility=facilities[fi].name,
                trip_index=per_truck[vehicle.truck_code],
                evidence={
                    "capacity_tons": vehicle.capacity_tons,
                    "permit_compliant": vehicle.permit_compliant,
                    "vehicle_type": vehicle.vehicle_type,
                    "area_demand_tons": d.tons,
                    "area_priority": d.priority,
                    "facility_accepts_vehicle": True,
                },
            )
        )
    return out
