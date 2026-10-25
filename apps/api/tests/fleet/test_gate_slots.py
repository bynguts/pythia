"""Gate-slot assignment and hold recommendations at the Bantargebang weighbridge (wave 12 gap 3)."""

from datetime import date

import pytest

from app.fleet import gate_slots
from app.fleet.gate_slots import (
    CAPACITY_PER_SLOT,
    assign_gate_slots,
    background_loads,
    expected_waits,
    slot_board,
)
from app.fleet.queue_simulation import (
    COLLECTION_ROUND_MEAN_H,
    STAGGER_SLOT_MINUTES,
    WEIGH_CYCLE_MINUTES,
    WEIGHBRIDGE_LANES,
    bantargebang_daily_arrivals,
    queue_minutes_per_truck,
    stagger_slot_count,
)

# The fluid slot model has no random travel or weigh times, so against the seeded
# simulation of the headline metric it may differ by this much (minutes per truck).
COHERENCE_TOLERANCE_MIN = 2.0

DAY = date(2031, 3, 4)
PAGI = ("pagi", "06:00-14:00")
SIANG = ("siang", "14:00-22:00")
MALAM = ("malam", "22:00-06:00")
BANTARGEBANG = "TPST Bantargebang"
RDF = "RDF Rorotan"


def _dispatch(truck_code, shift=PAGI, facility=BANTARGEBANG):
    return {
        "truck_code": truck_code,
        "fields": {"stops": [{"order": 1, "shift": shift[0], "window": shift[1], "facility": facility}]},
    }


@pytest.fixture()
def background(monkeypatch):
    """Simulated background arrivals per clock hour, set by each test (default: an empty gate)."""
    hours = [0.0] * 24
    monkeypatch.setattr(gate_slots, "_background_by_hour", lambda: list(hours))
    return hours


def test_capacity_per_slot_comes_from_the_weighbridge_constants():
    assert CAPACITY_PER_SLOT == WEIGHBRIDGE_LANES * STAGGER_SLOT_MINUTES / WEIGH_CYCLE_MINUTES


def test_first_gate_arrival_is_shift_start_plus_one_collection_round(background):
    slot = assign_gate_slots([_dispatch("T-031")], DAY)["T-031"]
    start_hour = 6 + COLLECTION_ROUND_MEAN_H
    assert slot["start"] == f"{int(start_hour):02d}:{int(start_hour % 1 * 60):02d}"
    assert slot["end"] == f"{int(start_hour):02d}:{int(start_hour % 1 * 60) + STAGGER_SLOT_MINUTES:02d}"
    assert slot["date"] == DAY.isoformat()
    assert slot["facility"] == BANTARGEBANG
    assert slot["hold_minutes"] == 0
    assert slot["classification"] == "MODEL_OUTPUT"
    assert slot["capacity_model"]["capacity_per_slot"] == CAPACITY_PER_SLOT
    assert slot["capacity_model"]["over_capacity"] is False
    assert slot["capacity_model"]["saturated"] is False


def test_night_shift_slot_is_dated_the_next_day(background):
    slots = assign_gate_slots([_dispatch("T-040", shift=MALAM)], DAY)
    assert slots["T-040"]["date"] == "2031-03-05"
    assert slots["T-040"]["start"] == "01:00"


def test_night_shift_capacity_is_checked_against_the_next_days_slots(background):
    first = assign_gate_slots([_dispatch("T-040", shift=MALAM)], DAY)
    background[1] = (CAPACITY_PER_SLOT - 1) * 4  # one free place per 01:xx slot
    # A slot held on the plan date at 01:00 does not take the next day's 01:00.
    other_day = {**first["T-040"], "date": DAY.isoformat()}
    assert assign_gate_slots([_dispatch("T-041", shift=MALAM)], DAY, [other_day])["T-041"]["start"] == "01:00"
    assert (
        assign_gate_slots([_dispatch("T-041", shift=MALAM)], DAY, [first["T-040"]])["T-041"]["start"]
        == "01:15"
    )


def test_full_slot_moves_the_truck_to_the_next_slot_with_room(background):
    # 116 arrivals in the 09 hour, 2 of them this plan's: 28.5 background trucks per slot.
    background[9] = (CAPACITY_PER_SLOT - 1) * 4
    slots = assign_gate_slots([_dispatch("T-002"), _dispatch("T-001")], DAY)
    assert slots["T-001"]["start"] == "09:00"  # truck-code order decides who goes first
    assert slots["T-002"]["start"] == "09:15"
    assert slots["T-002"]["hold_minutes"] == STAGGER_SLOT_MINUTES


def test_queue_carried_from_a_busy_slot_counts_against_the_next(background):
    background[8] = (CAPACITY_PER_SLOT + 5) * 4  # 140 arrivals in the 08 hour
    assert background_loads()[35] == CAPACITY_PER_SLOT + 5
    # One plan trip leaves 139 background arrivals: 34.75 a slot, so 19 trucks still queue at 09:00.
    slot = assign_gate_slots([_dispatch("T-001")], DAY)["T-001"]
    assert slot["start"] == "09:00"
    assert slot["capacity_model"]["background_load"] == 19.0


def test_plan_trips_are_not_counted_twice_in_the_background(background):
    # The day's 120 arrivals are exactly this plan's trucks: no background is left, so they
    # fill 09:00-09:45 at capacity instead of queueing behind a copy of themselves.
    background[9] = CAPACITY_PER_SLOT * 4
    assert background_loads(planned_arrivals=120) == [0.0] * len(background_loads())
    assert background_loads(planned_arrivals=500) == [0.0] * len(background_loads())
    slots = assign_gate_slots([_dispatch(f"T-{i:03d}") for i in range(120)], DAY)
    assert {s["start"] for s in slots.values()} == {"09:00", "09:15", "09:30", "09:45"}
    assert not any(
        s["capacity_model"]["over_capacity"] or s["capacity_model"]["saturated"] for s in slots.values()
    )

    board = slot_board(DAY, [{"truck_code": t, "gate_slot": s} for t, s in slots.items()])
    assert board["coverage"]["planned_gate_arrivals"] == 120
    assert board["coverage"]["daily_arrivals"] == 120
    assert board["coverage"]["share"] == 1.0
    assert board["modelled_wait"]["mean_per_truck_min"] == 0.0
    assert board["recommendations"] == []


def test_a_saturated_gate_gets_no_long_hold(background):
    for hour in (8, 9, 10):
        background[hour] = 400.0  # 100 background trucks a slot against 30 cleared
    slot = assign_gate_slots([_dispatch("T-001")], DAY)["T-001"]
    assert slot["capacity_model"]["saturated"] is True
    assert slot["capacity_model"]["over_capacity"] is True
    assert slot["start"] == "09:00" and slot["hold_minutes"] == 0

    board = slot_board(DAY, [{"truck_code": "T-001", "gate_slot": slot}])
    assert board["recommendations"] == []
    assert board["saturated"] is True
    assert board["saturated_slots"] == ["09:00"]
    assert board["modelled_wait"]["mean_per_planned_truck_min"] > 60


def test_a_plan_spreads_its_own_trucks_over_the_stagger_window(background):
    window = stagger_slot_count()
    trucks = int(CAPACITY_PER_SLOT) * window + 1
    slots = assign_gate_slots([_dispatch(f"T-{i:04d}") for i in range(trucks)], DAY)
    holds = sorted(s["hold_minutes"] for s in slots.values())
    assert holds[-1] == (window - 1) * STAGGER_SLOT_MINUTES
    # One truck more than the window holds: it keeps the roomiest (first) slot, flagged.
    over = [s for s in slots.values() if s["capacity_model"]["over_capacity"]]
    assert len(over) == 1 and over[0]["start"] == "09:00" and over[0]["capacity_model"]["saturated"] is False


def _whole_day_plan(trips):
    """`trips` one-trip trucks split over the two day shifts, as the headline metric does."""
    return [_dispatch(f"T-{i:04d}", shift=PAGI if i % 2 == 0 else SIANG) for i in range(trips)]


def test_without_a_plan_the_board_matches_the_baseline_metric():
    board = slot_board(DAY, [])
    baseline = queue_minutes_per_truck()["baseline_mean"]
    assert abs(board["modelled_wait"]["mean_per_truck_min"] - baseline) <= COHERENCE_TOLERANCE_MIN


def test_a_plan_carrying_all_observed_trips_matches_the_staggered_metric():
    trips = bantargebang_daily_arrivals()[0]
    slots = assign_gate_slots(_whole_day_plan(trips), DAY)
    planned = [{"truck_code": t, "gate_slot": s} for t, s in slots.items() if s["date"] == DAY.isoformat()]
    board = slot_board(DAY, planned)
    assert board["coverage"]["share"] == 1.0
    staggered = queue_minutes_per_truck()["staggered_mean"]
    assert abs(board["modelled_wait"]["mean_per_truck_min"] - staggered) <= COHERENCE_TOLERANCE_MIN


def test_rdf_trucks_get_a_slot_without_using_weighbridge_capacity(background):
    background[9] = (CAPACITY_PER_SLOT - 1) * 4
    slots = assign_gate_slots([_dispatch("T-001", facility=RDF), _dispatch("T-002")], DAY)
    assert slots["T-001"]["capacity_model"] is None
    assert slots["T-001"]["start"] == "09:00"
    assert slots["T-002"]["start"] == "09:00"  # the RDF truck did not take the one free place

    board = slot_board(DAY, [{"truck_code": t, "gate_slot": s} for t, s in slots.items()])
    by_start = {s["start"]: s for s in board["slots"]}
    assert by_start["09:00"]["planned_trucks"] == ["T-002"]
    assert [o["truck_code"] for o in board["other_facilities"]] == ["T-001"]


def test_a_plan_proposed_after_another_was_approved_avoids_its_slots(background):
    background[9] = (CAPACITY_PER_SLOT - 2) * 4  # two free places per 09:xx slot
    first = assign_gate_slots([_dispatch("T-001"), _dispatch("T-002")], DAY)
    # The first plan is approved before the second is proposed, so its slots are `occupied`.
    second = assign_gate_slots([_dispatch("T-003")], DAY, list(first.values()))
    assert {s["start"] for s in first.values()} == {"09:00"}
    assert second["T-003"]["start"] == "09:15"
    assert second["T-003"]["capacity_model"]["occupied"] == 0


def test_plans_proposed_before_either_is_approved_share_a_slot_and_the_board_holds_one(background):
    background[9] = (CAPACITY_PER_SLOT - 1) * 4  # one free place per 09:xx slot
    first = assign_gate_slots([_dispatch("T-001")], DAY)
    second = assign_gate_slots([_dispatch("T-002")], DAY)  # nothing approved yet: no `occupied`
    assert first["T-001"]["start"] == second["T-002"]["start"] == "09:00"

    planned = [{"truck_code": t, "gate_slot": s} for t, s in {**first, **second}.items()]
    recs = slot_board(DAY, planned)["recommendations"]
    assert [(r["truck_code"], r["from_slot"], r["to_slot"]) for r in recs] == [("T-001", "09:00", "09:15")]


def test_rdf_slots_in_occupied_do_not_take_bantargebang_places(background):
    background[9] = (CAPACITY_PER_SLOT - 1) * 4
    rdf = assign_gate_slots([_dispatch("T-001", facility=RDF)], DAY)
    assert assign_gate_slots([_dispatch("T-002")], DAY, list(rdf.values()))["T-002"]["start"] == "09:00"


def test_assignment_is_deterministic_whatever_the_input_order(background):
    background[9] = (CAPACITY_PER_SLOT - 3) * 4
    dispatches = [_dispatch(f"T-{i:03d}", shift=PAGI if i % 2 else SIANG) for i in range(12)]
    assert assign_gate_slots(dispatches, DAY) == assign_gate_slots(list(reversed(dispatches)), DAY)


def test_a_shift_without_a_clock_window_gets_no_slot(background):
    assert assign_gate_slots([_dispatch("T-001", shift=("harian", ""))], DAY) == {}


def test_expected_wait_is_the_backlog_over_the_clearing_rate():
    over = CAPACITY_PER_SLOT + 10
    assert expected_waits([over, 0.0, 0.0]) == [
        round(10 / (WEIGHBRIDGE_LANES / WEIGH_CYCLE_MINUTES), 1),
        0.0,
        0.0,
    ]


def _planned(count, start="09:00", prefix="T"):
    index = gate_slots.slot_index_of(start)
    return [
        {"truck_code": f"{prefix}-{i:03d}", "gate_slot": {"facility": BANTARGEBANG, "slot_index": index}}
        for i in range(count)
    ]


def test_overloaded_slot_produces_holds_into_the_nearest_slot_with_lower_wait(background):
    board = slot_board(DAY, _planned(int(CAPACITY_PER_SLOT) + 5))
    recs = board["recommendations"]
    assert len(recs) == 5
    for rec in recs:
        assert rec["action"] == "hold"
        assert rec["from_slot"] == "09:00"
        assert rec["to_slot"] == "09:15"
        assert rec["hold_minutes"] == STAGGER_SLOT_MINUTES
        assert rec["expected_wait_reduction_min"] > 0
        assert rec["id"] == f"rec-{DAY.isoformat()}-{rec['truck_code']}-36"
        assert rec["accepted"] is False and rec["dispatch_id"] is None
    nine = next(s for s in board["slots"] if s["start"] == "09:00")
    assert nine["expected_wait_min"] > 0
    assert board["classification"] == "SIMULATED"


def test_hold_skips_a_later_slot_that_is_already_full(background):
    planned = _planned(int(CAPACITY_PER_SLOT) + 1) + _planned(
        int(CAPACITY_PER_SLOT), start="09:15", prefix="U"
    )
    recs = slot_board(DAY, planned)["recommendations"]
    assert [r["to_slot"] for r in recs] == ["09:30"]
    assert recs[0]["hold_minutes"] == 2 * STAGGER_SLOT_MINUTES


def test_underloaded_day_produces_no_recommendation(background):
    board = slot_board(DAY, _planned(10))
    assert board["recommendations"] == []
    assert all(s["expected_wait_min"] == 0.0 for s in board["slots"])


def test_board_reports_background_load_and_the_derived_capacity(background):
    background[9] = 40.0  # 2 of the 40 are the plan's: 38 background arrivals, 9.5 a slot
    board = slot_board(DAY, _planned(2))
    assert board["coverage"]["share"] == 0.05
    assert board["capacity_per_slot"] == CAPACITY_PER_SLOT
    assert board["slot_minutes"] == STAGGER_SLOT_MINUTES
    first = board["slots"][0]
    assert first == {
        "index": 36,
        "date": DAY.isoformat(),
        "start": "09:00",
        "end": "09:15",
        "background_load": 9.5,
        "queue_carried_in": 0.0,
        "planned_trucks": ["T-000", "T-001"],
        "expected_wait_min": 0.0,
    }


def test_empty_board_has_no_slots(background):
    board = slot_board(DAY, [])
    assert board["slots"] == [] and board["recommendations"] == []
