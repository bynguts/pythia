"""R7: kecamatan rit quotas, gate caps and facility intake limits are HARD
constraints of the CP-SAT day plan, and demand they cannot serve is reported
as a labelled shortfall instead of an overflow."""

from __future__ import annotations

from collections import Counter

from app.fleet.operations_optimizer import Demand, Vehicle, build_operational_plan
from app.fleet.operations_rules import FacilityLimits, PlanningRules

SHIFTS = [{"id": "pagi", "window": "06:00-14:00"}, {"id": "siang", "window": "14:00-22:00"}]


def _rules(quota=None, facilities=None, by_area=None, max_rit=2):
    return PlanningRules(
        shifts=SHIFTS,
        max_rit_per_truck_per_day=max_rit,
        max_rit_per_truck_per_shift=1,
        default_quota=quota,
        quota_by_area=by_area or {},
        facilities=facilities or [FacilityLimits(name="TPST Bantargebang", display_name="TPST Bantargebang")],
    )


def _fleet(n, vehicle_type="Compactor Besar"):
    return [
        Vehicle(
            truck_code=f"T-{i:03d}",
            capacity_tons=18,
            vehicle_type=vehicle_type,
            leachate_free="Compactor" in vehicle_type,
        )
        for i in range(1, n + 1)
    ]


def test_quota_of_14_never_schedules_a_15th_trip():
    # 400 t needs 23 trips at 18 t; the fleet could run 60, the quota allows 14.
    demand = Demand(area="pasar_rebo", tons=400.0, lat=0, lng=0, label="Pasar Rebo")
    plan = build_operational_plan([demand], _fleet(30), rules=_rules(by_area={"pasar_rebo": 14}))

    assert len(plan.assignments) == 14
    usage = plan.quota_usage[0]
    assert usage["rit_used"] == 14
    assert usage["quota_rit_per_day"] == 14
    assert usage["binding_limit"] == "kecamatan_quota"


def test_infeasible_demand_is_a_labelled_shortfall_not_an_overflow():
    demand = Demand(area="cakung", tons=400.0, lat=0, lng=0)
    plan = build_operational_plan([demand], _fleet(30), rules=_rules(quota=14))

    assert plan.total_assigned_tons == 14 * 18
    assert plan.unassigned_tons == 400 - 14 * 18
    assert not plan.feasible
    assert "kecamatan_quota:cakung" in plan.unmet_reasons
    assert plan.quota_usage[0]["unassigned_tons"] == 400 - 14 * 18


def test_feasible_plan_reports_no_shortfall():
    plan = build_operational_plan(
        [Demand(area="tebet", tons=50.0, lat=0, lng=0)], _fleet(6), rules=_rules(quota=14)
    )
    assert plan.feasible
    assert plan.unassigned_tons == 0
    assert plan.total_assigned_tons == 50.0


def test_per_shift_gate_cap_is_hard():
    gate = FacilityLimits(name="TPST Bantargebang", display_name="TPST Bantargebang", shift_rit_cap=3)
    plan = build_operational_plan(
        [Demand(area="cakung", tons=400.0, lat=0, lng=0)], _fleet(20), rules=_rules(facilities=[gate])
    )
    per_shift = Counter(a.shift for a in plan.assignments)
    assert per_shift and all(count <= 3 for count in per_shift.values())
    assert plan.unmet_reasons == ["facility_limit:cakung"]


def test_daily_gate_cap_and_facility_tons_cap_are_hard():
    gate = FacilityLimits(name="TPST Bantargebang", display_name="TPST Bantargebang", daily_rit_cap=4)
    rdf = FacilityLimits(
        name="RDF Plant Jakarta",
        display_name="RDF Rorotan",
        daily_tons_cap=40,
        compactor_only=True,
        requires_leachate_free=True,
    )
    plan = build_operational_plan(
        [Demand(area="cakung", tons=400.0, lat=0, lng=0)], _fleet(20), rules=_rules(facilities=[gate, rdf])
    )
    by_facility = Counter(a.facility for a in plan.assignments)
    assert by_facility["TPST Bantargebang"] <= 4
    assert by_facility["RDF Plant Jakarta"] * 18 <= 40
    assert plan.unassigned_tons > 0


def test_facility_rejects_vehicles_it_does_not_accept():
    rdf = FacilityLimits(
        name="RDF Plant Jakarta", display_name="RDF Rorotan", compactor_only=True, requires_leachate_free=True
    )
    dump = _fleet(5, vehicle_type="Dump Truck Besar")
    plan = build_operational_plan(
        [Demand(area="cilincing", tons=60.0, lat=0, lng=0)], dump, rules=_rules(facilities=[rdf])
    )
    assert plan.assignments == []
    assert plan.unassigned_tons == 60.0
    assert not rdf.accepts("Dump Truck Besar", leachate_free=False)
    assert rdf.accepts("Compactor Kecil", leachate_free=True)


def test_facility_service_area_limits_which_districts_it_takes():
    rdf = FacilityLimits(
        name="RDF Plant Jakarta", display_name="RDF Rorotan", served_cities=["Jakarta Utara"]
    )
    plan = build_operational_plan(
        [Demand(area="tebet", tons=40.0, lat=0, lng=0, city="Jakarta Selatan")],
        _fleet(5),
        rules=_rules(facilities=[rdf]),
    )
    assert plan.assignments == []
    assert plan.unmet_reasons == ["no_accepting_facility:tebet"]


def test_no_more_trips_than_an_area_needs():
    # Audit open question 2: a 20 t area needs 2 trips; 10 idle trucks must not pile on.
    plan = build_operational_plan(
        [Demand(area="menteng", tons=20.0, lat=0, lng=0)], _fleet(10), rules=_rules(quota=14)
    )
    assert len(plan.assignments) == 2
    capacity = sum(a.evidence["capacity_tons"] for a in plan.assignments)
    assert capacity <= 20 + 18 - 1
    assert plan.total_assigned_tons == 20.0


def test_truck_trip_limits_hold_per_shift_and_per_day():
    plan = build_operational_plan(
        [Demand(area="cakung", tons=400.0, lat=0, lng=0), Demand(area="tebet", tons=300.0, lat=0, lng=0)],
        _fleet(8),
        rules=_rules(max_rit=2),
    )
    per_truck = Counter(a.truck_code for a in plan.assignments)
    per_truck_shift = Counter((a.truck_code, a.shift) for a in plan.assignments)
    assert len(plan.assignments) == 16  # 8 trucks x 2 trips, fleet-bound
    assert max(per_truck.values()) <= 2
    assert max(per_truck_shift.values()) <= 1
    assert all(r.startswith("fleet_capacity:") for r in plan.unmet_reasons)


def test_same_inputs_give_the_same_plan():
    def run():
        plan = build_operational_plan(
            [Demand(area="cakung", tons=200.0, lat=0, lng=0), Demand(area="tebet", tons=90.0, lat=0, lng=0)],
            _fleet(12),
            rules=_rules(quota=14),
        )
        return [(a.truck_code, a.area, a.shift, a.assigned_tons) for a in plan.assignments]

    assert run() == run()
