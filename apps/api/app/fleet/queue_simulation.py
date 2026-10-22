"""Discrete-event simulation of the Bantargebang weighbridge queue.

Replaces the previous fixed 116->48 minute demo numbers with a seeded
multi-server queue (M/M/c style) whose outputs respond to arrival demand,
number of active weighbridges, and service rate. Every result is reproducible
from a seed and reports mean/P95 wait, max queue, throughput, utilization, and
a 95% confidence interval across replications.
"""

from __future__ import annotations

import bisect
import calendar
import csv
import heapq
import random
import re
import statistics
from collections import defaultdict
from functools import lru_cache
from typing import Any

from app.core.paths import REAL_DIR
from app.core.units import SHIFT_HOURS, TRUCK_CAPACITY_TONS, trucks_for_tons

OPERATING_HOURS = 1.0  # peak arrival window (hours) where queueing forms

# ── Weighbridge assumptions: the ONE set every queue surface uses ─────────
# The daily-metric simulation below, the TPA status / "What-if" panel
# (fleet/data.py) and the live AI queue predictor all read these constants.
# Source: modelled assumptions, not facility measurements. No public DLH
# dataset publishes the lane count or the weigh-in cycle at TPST Bantargebang;
# 4 parallel lanes at a 2-minute weigh cycle (30 trucks/h per lane) is a
# planning assumption to be replaced by weighbridge logs in a pilot.
WEIGHBRIDGE_LANES = 4
WEIGH_CYCLE_MINUTES = 2.0
WEIGHBRIDGE_TRUCKS_PER_HOUR = 60.0 / WEIGH_CYCLE_MINUTES  # per lane
WEIGHBRIDGE_ASSUMPTION = (
    f"assumption: {WEIGHBRIDGE_LANES} weighbridge lanes x {WEIGHBRIDGE_TRUCKS_PER_HOUR:g} trucks/h "
    f"({WEIGH_CYCLE_MINUTES:g}-min weigh cycle); not a facility measurement"
)


def _run_single(
    arrival_count: int, weighbridges: int, service_rate_per_hour: float, rng: random.Random
) -> tuple[float, float, int]:
    """One replication. Returns (mean_wait_min, p95_wait_min, max_queue)."""
    mean_interarrival_h = OPERATING_HOURS / arrival_count
    mean_service_h = 1.0 / service_rate_per_hour

    # Generate Poisson arrivals via exponential interarrival times.
    arrivals: list[float] = []
    t = 0.0
    for _ in range(arrival_count):
        t += rng.expovariate(1.0 / mean_interarrival_h)
        arrivals.append(t)

    server_free_at = [0.0] * weighbridges
    waits: list[float] = []
    # Event-driven: each truck takes the earliest-free weighbridge.
    heapq.heapify(server_free_at)
    max_queue = 0
    completion_times: list[float] = []
    for arr in arrivals:
        free_at = heapq.heappop(server_free_at)
        start = max(arr, free_at)
        service = rng.expovariate(1.0 / mean_service_h)
        end = start + service
        waits.append((start - arr) * 60.0)  # minutes
        heapq.heappush(server_free_at, end)
        completion_times.append(end)
        # Queue length = arrivals so far not yet started service.
        waiting_now = sum(1 for c in completion_times if c > arr) - weighbridges
        max_queue = max(max_queue, max(0, waiting_now))

    mean_wait = statistics.fmean(waits) if waits else 0.0
    p95 = sorted(waits)[int(0.95 * (len(waits) - 1))] if waits else 0.0
    return mean_wait, p95, max_queue


def simulate_queue(
    arrival_count: int,
    weighbridges: int,
    service_rate_per_hour: float,
    seed: int | None = None,
    replications: int = 100,
) -> dict[str, Any]:
    """Seeded discrete-event queue simulation with replication intervals.

    Args:
        arrival_count: trucks arriving over the operating window.
        weighbridges: active parallel weighbridges (servers).
        service_rate_per_hour: trucks one weighbridge clears per hour.
        seed: base RNG seed for reproducibility.
        replications: number of seeded runs for confidence intervals.
    """
    if arrival_count < 0:
        raise ValueError("arrival_count must be non-negative")
    if weighbridges <= 0:
        raise ValueError("weighbridges must be positive")
    if service_rate_per_hour <= 0:
        raise ValueError("service_rate_per_hour must be positive")

    if arrival_count == 0:
        return {
            "mean_wait_minutes": 0.0,
            "p95_wait_minutes": 0.0,
            "max_queue": 0,
            "throughput_per_hour": weighbridges * service_rate_per_hour,
            "utilization": 0.0,
            "wait_ci95": [0.0, 0.0],
            "recommended_slots": 0,
            "replications": replications,
        }

    means, p95s, maxqs = [], [], []
    for i in range(replications):
        rng = random.Random((seed if seed is not None else 0) * 100000 + i)
        m, p, q = _run_single(arrival_count, weighbridges, service_rate_per_hour, rng)
        means.append(m)
        p95s.append(p)
        maxqs.append(q)

    mean_wait = statistics.fmean(means)
    stdev = statistics.pstdev(means)
    half = 1.96 * stdev / (len(means) ** 0.5)
    offered_load = (arrival_count / OPERATING_HOURS) / (weighbridges * service_rate_per_hour)

    return {
        "mean_wait_minutes": round(mean_wait, 1),
        "p95_wait_minutes": round(statistics.fmean(p95s), 1),
        "max_queue": round(statistics.fmean(maxqs)),
        "throughput_per_hour": round(weighbridges * service_rate_per_hour, 1),
        "utilization": round(offered_load, 3),
        "wait_ci95": [round(mean_wait - half, 1), round(mean_wait + half, 1)],
        "recommended_slots": max(0, round(arrival_count / max(1, weighbridges)) - weighbridges),
        "replications": replications,
    }


# ── The one metric: TPA queue minutes per truck (gsc P0-5) ────────────────
# One operating day at the Bantargebang weighbridges, simulated twice with the
# same random draws (common random numbers): once with every truck of a shift
# leaving the depot at shift start (unstaggered), once with departures spread
# over 15-minute slots (the recommended stagger). The daily arrival count comes
# from the real weighbridge intake file; every other parameter below is a
# labelled model assumption, not a facility measurement.
QUEUE_METRIC_SEED = 42
QUEUE_METRIC_REPLICATIONS = 100
COLLECTION_ROUND_MEAN_H = 3.0  # assumption: depot -> collection round -> TPA gate
COLLECTION_ROUND_SD_H = 0.75
SHIFTS_PER_DAY = 2
FIRST_SHIFT_START_HOUR = 6  # 06:00 WIB
STAGGER_SLOT_MINUTES = 15
WEIGHING_CSV = REAL_DIR / "bantargebang_hasil_penimbangan.csv"


@lru_cache(maxsize=1)
def bantargebang_daily_arrivals(months: int = 12) -> tuple[int, str] | None:
    """Median truck arrivals (ritasi) per day at Bantargebang over the latest months.

    The median is robust to the few malformed months in the open-data file
    (some carry a 10x digit error). Falls back to Jakarta's SIPSN daily tonnage
    divided by the canonical truck capacity when the weighing file is absent.
    """
    if WEIGHING_CSV.exists():
        per_month: dict[str, int] = defaultdict(int)
        with WEIGHING_CSV.open(encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                period = (row.get("periode_data") or "").strip()
                trips = re.sub(r"\D", "", row.get("ritasi") or "")
                # A malformed month (00, 13, ...) would make monthrange raise: skip it.
                if len(period) == 6 and period.isdigit() and 1 <= int(period[4:]) <= 12 and trips:
                    per_month[period] += int(trips)
        latest = sorted(per_month)[-months:]
        daily = [per_month[p] / calendar.monthrange(int(p[:4]), int(p[4:]))[1] for p in latest]
        if daily:
            return (
                round(statistics.median(daily)),
                f"median daily ritasi, Bantargebang weighing data {latest[0]}-{latest[-1]} (data.go.id)",
            )

    from app.forecast.real_data import load_city_timbulan

    tons = sum(info["daily_tons"] for info in load_city_timbulan().values())
    if tons <= 0:
        return None
    return (
        trucks_for_tons(tons),
        f"SIPSN daily tonnage / {TRUCK_CAPACITY_TONS:g} t per truck (canonical units)",
    )


def stagger_slot_count() -> int:
    """Departure slots per shift: the shift minus one collection round, in stagger steps."""
    return max(1, int((SHIFT_HOURS - COLLECTION_ROUND_MEAN_H) * 60 // STAGGER_SLOT_MINUTES))


def _arrival_hours(trips: int, staggered: bool, rng: random.Random) -> list[float]:
    """Gate arrival times (hours after the first shift start) for one day."""
    slots = stagger_slot_count()
    arrivals: list[float] = []
    for shift in range(SHIFTS_PER_DAY):
        start = shift * SHIFT_HOURS
        count = trips // SHIFTS_PER_DAY + (1 if shift < trips % SHIFTS_PER_DAY else 0)
        for i in range(count):
            depart = start + ((i % slots) * STAGGER_SLOT_MINUTES / 60.0 if staggered else 0.0)
            arrivals.append(depart + max(0.5, rng.gauss(COLLECTION_ROUND_MEAN_H, COLLECTION_ROUND_SD_H)))
    arrivals.sort()
    return arrivals


def _day_trace(arrivals: list[float], lanes: int, rng: random.Random) -> tuple[list[float], list[int]]:
    """FIFO multi-lane weighbridge. Per truck: (wait minutes, trucks queued ahead on arrival)."""
    free_at = [0.0] * lanes
    starts: list[float] = []
    waits: list[float] = []
    queued: list[int] = []
    for arr in arrivals:
        # FIFO start times never decrease, so the trucks still waiting when this
        # one arrives are exactly the earlier ones whose start lies after `arr`.
        queued.append(len(starts) - bisect.bisect_right(starts, arr))
        start = max(arr, heapq.heappop(free_at))
        heapq.heappush(free_at, start + rng.expovariate(WEIGHBRIDGE_TRUCKS_PER_HOUR))
        starts.append(start)
        waits.append((start - arr) * 60.0)
    return waits, queued


def _p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[int(0.95 * (len(ordered) - 1))]


def _day_queue(arrivals: list[float], lanes: int, rng: random.Random) -> tuple[float, float, int]:
    """FIFO multi-lane weighbridge. Returns (mean_wait_min, p95_wait_min, max_queue)."""
    waits, queued = _day_trace(arrivals, lanes, rng)
    return statistics.fmean(waits), _p95(waits), max(queued, default=0)


def _ci95(values: list[float]) -> list[float]:
    mean = statistics.fmean(values)
    half = 1.96 * statistics.stdev(values) / len(values) ** 0.5 if len(values) > 1 else 0.0
    return [round(mean - half, 1), round(mean + half, 1)]


def queue_minutes_per_truck(
    trucks_per_day: int | None = None,
    seed: int = QUEUE_METRIC_SEED,
    replications: int = QUEUE_METRIC_REPLICATIONS,
    arrivals_source: str = "caller-supplied daily truck arrivals",
) -> dict[str, Any] | None:
    """TPA queue minutes per truck: unstaggered baseline vs the recommended stagger.

    Deterministic for a seed, so the simulation is cached keyed by (trucks/day,
    seed, replications) only; the source text is added outside the cache, so
    one truck count is simulated once however it is described. Returns a new
    dict whose nested values are shared with the cache: do not mutate them.
    Returns None when no daily arrival count can be derived.
    """
    if trucks_per_day is None:
        derived = bantargebang_daily_arrivals()
        if derived is None:
            return None
        trucks_per_day, arrivals_source = derived
    if trucks_per_day <= 0:
        raise ValueError("trucks_per_day must be positive")
    if replications <= 0:
        raise ValueError("replications must be positive")
    return {
        **_simulate_day(int(trucks_per_day), seed, replications),
        "source": (
            "Seeded discrete-event simulation of one operating day at the TPST Bantargebang "
            f"weighbridges; arrivals: {arrivals_source}. Not a field measurement."
        ),
    }


@lru_cache(maxsize=64)
def _simulate_day(trucks_per_day: int, seed: int, replications: int) -> dict[str, Any]:
    """The cached simulation behind `queue_minutes_per_truck` (no source text)."""
    runs: dict[bool, list[tuple[float, float, int]]] = {False: [], True: []}
    for i in range(replications):
        for staggered in (False, True):
            rng = random.Random(seed * 100000 + i)  # same draws for both arms
            arrivals = _arrival_hours(trucks_per_day, staggered, rng)
            runs[staggered].append(_day_queue(arrivals, WEIGHBRIDGE_LANES, rng))

    def summarise(staggered: bool) -> tuple[float, float, list[float], int]:
        rows = runs[staggered]
        means = [r[0] for r in rows]
        return (
            round(statistics.fmean(means), 1),
            round(statistics.fmean(r[1] for r in rows), 1),
            _ci95(means),
            round(statistics.fmean(r[2] for r in rows)),
        )

    b_mean, b_p95, b_ci, b_queue = summarise(False)
    s_mean, s_p95, s_ci, s_queue = summarise(True)
    return {
        "baseline_mean": b_mean,
        "staggered_mean": s_mean,
        "baseline_p95": b_p95,
        "staggered_p95": s_p95,
        "staggered_ci95": s_ci,
        "baseline_ci95": b_ci,
        "replications": replications,
        "seed": seed,
        "trucks_per_day": trucks_per_day,
        "classification": "SIMULATED",
        "unit": "minutes of weighbridge queue per truck arrival",
        "baseline_max_queue": b_queue,
        "staggered_max_queue": s_queue,
        "recommended_stagger_minutes": STAGGER_SLOT_MINUTES,
        "assumptions": {
            "weighbridge_lanes": WEIGHBRIDGE_LANES,
            "weigh_cycle_minutes": WEIGH_CYCLE_MINUTES,
            "weighbridge_basis": WEIGHBRIDGE_ASSUMPTION,
            "collection_round_hours_mean_sd": [COLLECTION_ROUND_MEAN_H, COLLECTION_ROUND_SD_H],
            "shifts_per_day": SHIFTS_PER_DAY,
            "shift_hours": SHIFT_HOURS,
            "first_shift_start_hour": FIRST_SHIFT_START_HOUR,
            "baseline": "every truck of a shift departs the depot at shift start",
            "staggered": f"departures spread over {STAGGER_SLOT_MINUTES}-minute slots",
        },
    }


# ── Scenario scaling (gsc C1) ─────────────────────────────────────────────
# Modelled assumption: daily truck arrivals at the gate scale linearly with the
# city's collected tonnage: scenario trucks/day = normal trucks/day x
# (scenario-day tonnes / normal-day tonnes) for the selected forecast day, at
# the same tonnes per trip (rain or an event adds trips, not heavier trucks).
# The normal day is the same forecast without rain or event.
SCENARIO_SCALING_ASSUMPTION = (
    "modelled assumption: scenario trucks/day = normal trucks/day x "
    "(scenario-day tonnes / normal-day tonnes), same tonnes per trip"
)
# The scaled count moves from the normal day in steps of this many trucks/day,
# so nearby scenarios share one cached simulation instead of each paying a run.
SCENARIO_TRUCK_STEP = 25


def scenario_queue_metric(
    scenario_tons: float | None = None, normal_tons: float | None = None
) -> dict[str, Any] | None:
    """The queue metric for a scenario day; without tonnes, the normal day.

    Keeps every key of `queue_minutes_per_truck()` (now describing the scenario)
    and adds `scenario_scaled` and `normal_day`. Returns a new dict, so the
    cached simulation results are never mutated.
    """
    derived = bantargebang_daily_arrivals()
    if derived is None:
        return None
    normal_trucks, arrivals_source = derived
    normal = queue_minutes_per_truck(normal_trucks, arrivals_source=arrivals_source)
    normal_day = {k: normal[k] for k in ("trucks_per_day", "baseline_mean", "staggered_mean")}
    ratio = scenario_tons / normal_tons if scenario_tons is not None and normal_tons else 1.0
    unrounded = normal_trucks * ratio
    step = SCENARIO_TRUCK_STEP * round((unrounded - normal_trucks) / SCENARIO_TRUCK_STEP)
    trucks = max(1, normal_trucks + step)
    if trucks == normal_trucks:
        return {**normal, "scenario_scaled": False, "normal_day": normal_day}
    scaled = queue_minutes_per_truck(
        trucks,
        arrivals_source=(
            f"{arrivals_source}, scaled x{ratio:.3f} by scenario/normal-day tonnes "
            f"and rounded to {SCENARIO_TRUCK_STEP}-truck steps from the normal day"
        ),
    )
    return {
        **scaled,
        "scenario_scaled": True,
        "normal_day": normal_day,
        "scaling": {
            "tonnage_ratio": round(ratio, 4),
            "scenario_tons": round(scenario_tons, 1),
            "normal_tons": round(normal_tons, 1),
            "unrounded_trucks_per_day": round(unrounded, 1),
            "truck_step": SCENARIO_TRUCK_STEP,
            "basis": SCENARIO_SCALING_ASSUMPTION,
        },
    }


@lru_cache(maxsize=4)
def hourly_queue_profile(
    trucks_per_day: int | None = None,
    seed: int = QUEUE_METRIC_SEED,
    replications: int = QUEUE_METRIC_REPLICATIONS,
) -> tuple[dict[str, Any], ...] | None:
    """The metric's unstaggered baseline day, broken down by gate-arrival clock hour (WIB).

    Same arrival model, lanes, weigh cycle and seeds as `queue_minutes_per_truck`
    (the baseline arm's draws are identical), so the TPA status panel and the
    daily metric cannot disagree. 24 rows; hours without arrivals read zero.
    """
    if trucks_per_day is None:
        derived = bantargebang_daily_arrivals()
        if derived is None:
            return None
        trucks_per_day = derived[0]
    waits: list[list[float]] = [[] for _ in range(24)]
    rep_means: list[list[float]] = [[] for _ in range(24)]
    rep_max_queue: list[list[int]] = [[] for _ in range(24)]
    queued_ahead: list[list[int]] = [[] for _ in range(24)]
    for i in range(replications):
        rng = random.Random(seed * 100000 + i)
        arrivals = _arrival_hours(trucks_per_day, False, rng)
        day_waits, queued = _day_trace(arrivals, WEIGHBRIDGE_LANES, rng)
        hour_waits: dict[int, list[float]] = defaultdict(list)
        hour_queue: dict[int, int] = defaultdict(int)
        for arr, wait, ahead in zip(arrivals, day_waits, queued, strict=True):
            hour = int(FIRST_SHIFT_START_HOUR + arr) % 24
            hour_waits[hour].append(wait)
            hour_queue[hour] = max(hour_queue[hour], ahead)
            queued_ahead[hour].append(ahead)
        for hour, values in hour_waits.items():
            waits[hour].extend(values)
            rep_means[hour].append(statistics.fmean(values))
            rep_max_queue[hour].append(hour_queue[hour])
    capacity = WEIGHBRIDGE_LANES * WEIGHBRIDGE_TRUCKS_PER_HOUR
    rows = []
    for hour in range(24):
        arrivals_per_rep = len(waits[hour]) / replications
        rows.append(
            {
                "hour": hour,
                "arrivals": round(arrivals_per_rep),
                # Trucks already waiting when a truck of this hour reaches the gate.
                "queue_trucks_mean": (
                    round(statistics.fmean(queued_ahead[hour]), 1) if queued_ahead[hour] else 0.0
                ),
                "mean_wait_minutes": round(statistics.fmean(waits[hour]), 1) if waits[hour] else 0.0,
                "p95_wait_minutes": round(_p95(waits[hour]), 1) if waits[hour] else 0.0,
                "max_queue": round(statistics.fmean(rep_max_queue[hour])) if rep_max_queue[hour] else 0,
                "wait_ci95": _ci95(rep_means[hour]) if rep_means[hour] else [0.0, 0.0],
                "utilization": round(arrivals_per_rep / capacity, 3),
                "throughput_per_hour": capacity,
            }
        )
    return tuple(rows)
