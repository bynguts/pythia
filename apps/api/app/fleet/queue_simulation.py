"""Discrete-event simulation of the Bantargebang weighbridge queue.

Replaces the previous fixed 116->48 minute demo numbers with a seeded
multi-server queue (M/M/c style) whose outputs respond to arrival demand,
number of active weighbridges, and service rate. Every result is reproducible
from a seed and reports mean/P95 wait, max queue, throughput, utilization, and
a 95% confidence interval across replications.
"""

from __future__ import annotations

import calendar
import csv
import heapq
import random
import statistics
from collections import defaultdict
from functools import lru_cache
from typing import Any

import numpy as np

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
# One operating day at the Bantargebang weighbridges, simulated with the same
# random draws (common random numbers) for each arm: the "current practice"
# baseline, where each shift's trucks leave the depot around shift start with a
# stated departure spread, and the recommended stagger, where departures are
# spread over 15-minute slots. The daily arrival count comes from the real
# weighbridge intake file; every other parameter below is a labelled model
# assumption, not a facility measurement.
QUEUE_METRIC_SEED = 42
QUEUE_METRIC_REPLICATIONS = 100
COLLECTION_ROUND_MEAN_H = 3.0  # assumption: depot -> collection round -> TPA gate
COLLECTION_ROUND_SD_H = 0.75
SHIFTS_PER_DAY = 2
FIRST_SHIFT_START_HOUR = 6  # 06:00 WIB
STAGGER_SLOT_MINUTES = 15
# Current-practice baseline (gsc teardown #3): departures are a normal around
# shift start, truncated at +/- DEPARTURE_TRUNCATION_SD standard deviations.
# No DLH dispatch log publishes the real spread, so the headline uses a stated
# 30-minute SD and the payload reports the same day under the tightest and the
# loosest plausible spreads (the sensitivity band), never one chosen point.
BASELINE_DEPARTURE_SD_MINUTES = 30.0
DEPARTURE_SD_BAND_MINUTES = (10.0, 30.0, 60.0)
DEPARTURE_TRUNCATION_SD = 2.0
BASELINE_ASSUMPTION = (
    "assumption (current practice): each shift's trucks leave the depot around shift start, "
    f"normal departure spread SD {BASELINE_DEPARTURE_SD_MINUTES:g} min truncated at "
    f"+/-{DEPARTURE_TRUNCATION_SD:g} SD; not a dispatch-log measurement"
)
WEIGHING_CSV = REAL_DIR / "bantargebang_hasil_penimbangan.csv"


@lru_cache(maxsize=1)
def bantargebang_daily_arrivals(months: int = 12) -> tuple[int, str] | None:
    """Median truck arrivals (ritasi) per day at Bantargebang over the latest months.

    Later releases of the open-data file write ritasi as decimals ("6216.0"), so
    values are parsed as numbers, not by stripping non-digits. Falls back to Jakarta's SIPSN daily tonnage
    divided by the canonical truck capacity when the weighing file is absent.
    """
    if WEIGHING_CSV.exists():
        per_month: dict[str, int] = defaultdict(int)
        with WEIGHING_CSV.open(encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                period = (row.get("periode_data") or "").strip()
                try:
                    trips = round(float((row.get("ritasi") or "").strip()))
                except ValueError:
                    continue
                # A malformed month (00, 13, ...) would make monthrange raise: skip it.
                if len(period) == 6 and period.isdigit() and 1 <= int(period[4:]) <= 12:
                    per_month[period] += trips
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


def _departure_z(trips: int, seed: int, replication: int) -> list[float]:
    """Standard-normal departure draws truncated at +/- DEPARTURE_TRUNCATION_SD, one per trip.

    A stream of its own (seeded by seed and replication, not by the SD), so every
    departure spread of the band scales the same draws and the collection-round
    and weigh-cycle draws stay common to every arm.
    """
    rng = random.Random(f"departure-{seed}-{replication}")
    draws: list[float] = []
    for _ in range(trips):
        z = rng.gauss(0.0, 1.0)
        while abs(z) > DEPARTURE_TRUNCATION_SD:
            z = rng.gauss(0.0, 1.0)
        draws.append(z)
    return draws


def _round_draws(trips: int, rng: random.Random) -> list[float]:
    """Each trip's collection-round leg (hours), in trip order: the day's first `trips` draws."""
    return [max(0.5, rng.gauss(COLLECTION_ROUND_MEAN_H, COLLECTION_ROUND_SD_H)) for _ in range(trips)]


@lru_cache(maxsize=32)
def _trip_shift_starts(trips: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Per trip, in trip order: (its shift's start hour, its rank within the shift)."""
    starts: list[int] = []
    ranks: list[int] = []
    for shift in range(SHIFTS_PER_DAY):
        count = trips // SHIFTS_PER_DAY + (1 if shift < trips % SHIFTS_PER_DAY else 0)
        starts.extend([shift * SHIFT_HOURS] * count)
        ranks.extend(range(count))
    return tuple(starts), tuple(ranks)


@lru_cache(maxsize=32)
def _stagger_departures(trips: int) -> tuple[float, ...]:
    """Per trip: its staggered depot departure (hours after the first shift start)."""
    slots = stagger_slot_count()
    starts, ranks = _trip_shift_starts(trips)
    return tuple(
        start + (i % slots) * STAGGER_SLOT_MINUTES / 60.0 for start, i in zip(starts, ranks, strict=True)
    )


def _gate_arrivals(trips: int, rounds: list[float], departure_offsets_h: list[float] | None) -> list[float]:
    """Sorted gate arrival times (hours after the first shift start) from drawn round legs.

    `departure_offsets_h` (one per trip, hours from its shift start) is the
    current-practice baseline; None is the recommended 15-minute stagger.
    """
    if departure_offsets_h is None:
        departures: tuple[float, ...] | list[float] = _stagger_departures(trips)
    else:
        starts, _ranks = _trip_shift_starts(trips)
        departures = [start + offset for start, offset in zip(starts, departure_offsets_h, strict=True)]
    arrivals = [leave + leg for leave, leg in zip(departures, rounds, strict=True)]
    arrivals.sort()
    return arrivals


def _arrival_hours(trips: int, rng: random.Random, departure_offsets_h: list[float] | None) -> list[float]:
    """Gate arrival times (hours after the first shift start) for one day; see `_gate_arrivals`."""
    return _gate_arrivals(trips, _round_draws(trips, rng), departure_offsets_h)


def _baseline_offsets(z: list[float], sd_minutes: float) -> list[float]:
    return [d * sd_minutes / 60.0 for d in z]


def baseline_departure_sd_minutes(
    trucks_per_day: int, sd_minutes: float = BASELINE_DEPARTURE_SD_MINUTES
) -> float:
    """Realised SD (minutes) of the baseline's departure offsets for replication 0 of the metric seed."""
    offsets = _baseline_offsets(_departure_z(trucks_per_day, QUEUE_METRIC_SEED, 0), sd_minutes)
    return statistics.pstdev(offsets) * 60.0


def _service_draws(trips: int, rng: random.Random) -> list[float]:
    """Weigh-in durations (hours), one per gate arrival in arrival order."""
    return [rng.expovariate(WEIGHBRIDGE_TRUCKS_PER_HOUR) for _ in range(trips)]


def _trace(arrivals: list[float], lanes: int, services: list[float]) -> tuple[list[float], list[int]]:
    """FIFO multi-lane weighbridge. Per truck: (wait minutes, trucks queued ahead on arrival)."""
    # Lanes are free before the first arrival, which may precede 06:00 when a
    # baseline truck leaves the depot before shift start.
    free_at = [float("-inf")] * lanes
    starts: list[float] = []
    append, heapreplace = starts.append, heapq.heapreplace
    for arr, service in zip(arrivals, services, strict=True):
        start = max(arr, free_at[0])
        heapreplace(free_at, start + service)  # the earliest-free lane takes this truck
        append(start)
    # FIFO start times never decrease, so the trucks still waiting when truck j
    # arrives are exactly the earlier ones whose start lies after its arrival:
    # j minus those among the first j that started by then (a sorted prefix).
    started_by = np.searchsorted(np.asarray(starts), np.asarray(arrivals), side="right")
    index = np.arange(len(starts))
    queued = (index - np.minimum(index, started_by)).tolist()
    waits = [(start - arr) * 60.0 for start, arr in zip(starts, arrivals, strict=True)]
    return waits, queued


def _day_trace(arrivals: list[float], lanes: int, rng: random.Random) -> tuple[list[float], list[int]]:
    """FIFO multi-lane weighbridge, drawing the weigh-ins from `rng`; see `_trace`."""
    return _trace(arrivals, lanes, _service_draws(len(arrivals), rng))


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
    """TPA queue minutes per truck: current-practice baseline vs the recommended stagger.

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


def _reduction_percent(baseline: float, staggered: float) -> float:
    return round((baseline - staggered) / baseline * 100, 1) if baseline > 0 else 0.0


class _HourlyTally:
    """The baseline day by gate-arrival clock hour (WIB), across replications."""

    def __init__(self) -> None:
        self.waits: list[list[float]] = [[] for _ in range(24)]
        self.rep_means: list[list[float]] = [[] for _ in range(24)]
        self.rep_max_queue: list[list[int]] = [[] for _ in range(24)]
        self.queued_ahead: list[list[int]] = [[] for _ in range(24)]

    def add_day(self, arrivals: list[float], day_waits: list[float], queued: list[int]) -> None:
        hour_waits: dict[int, list[float]] = defaultdict(list)
        hour_queue: dict[int, int] = defaultdict(int)
        for arr, wait, ahead in zip(arrivals, day_waits, queued, strict=True):
            hour = int(FIRST_SHIFT_START_HOUR + arr) % 24
            hour_waits[hour].append(wait)
            hour_queue[hour] = max(hour_queue[hour], ahead)
            self.queued_ahead[hour].append(ahead)
        for hour, values in hour_waits.items():
            self.waits[hour].extend(values)
            self.rep_means[hour].append(statistics.fmean(values))
            self.rep_max_queue[hour].append(hour_queue[hour])

    def rows(self, replications: int) -> tuple[dict[str, Any], ...]:
        capacity = WEIGHBRIDGE_LANES * WEIGHBRIDGE_TRUCKS_PER_HOUR
        waits, rep_means, rep_max_queue, queued_ahead = (
            self.waits,
            self.rep_means,
            self.rep_max_queue,
            self.queued_ahead,
        )
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


class _StaggeredTally:
    """The staggered day by gate-arrival clock hour (WIB), across replications."""

    def __init__(self) -> None:
        self.waits: list[list[float]] = [[] for _ in range(24)]
        self.queued_ahead: list[list[int]] = [[] for _ in range(24)]
        self.max_queue: list[list[int]] = [[] for _ in range(24)]

    def add_day(self, arrivals: list[float], day_waits: list[float], queued: list[int]) -> None:
        day_max = [0] * 24  # queued-ahead counts are never negative
        for arr, wait, ahead in zip(arrivals, day_waits, queued, strict=True):
            hour = int(FIRST_SHIFT_START_HOUR + arr) % 24
            self.waits[hour].append(wait)
            self.queued_ahead[hour].append(ahead)
            day_max[hour] = max(day_max[hour], ahead)
        for hour in range(24):
            self.max_queue[hour].append(day_max[hour])

    def hours(self, replications: int) -> tuple[tuple[int, float, float, int], ...]:
        """Per clock hour: (arrivals, mean wait, mean queued ahead, mean max queue)."""
        return tuple(
            (
                round(len(waits) / replications),
                round(statistics.fmean(waits), 1) if waits else 0.0,
                round(statistics.fmean(queued), 1) if queued else 0.0,
                round(statistics.fmean(max_queue)) if max_queue else 0,
            )
            for waits, queued, max_queue in zip(self.waits, self.queued_ahead, self.max_queue, strict=True)
        )


@lru_cache(maxsize=16)
def _seeded_day(
    trucks_per_day: int, seed: int, replications: int
) -> tuple[dict[str, Any], tuple[dict[str, Any], ...], tuple[tuple[int, float, float, int], ...]]:
    """One pass over the seeded day: (daily metric, baseline hourly profile, staggered hours).

    Every arm of a replication uses the same random draws (common random numbers):
    the collection-round legs and the weigh-ins are drawn once per replication and
    shared, which is exactly what reseeding the generator per arm produced. The
    hourly profile is the headline-spread baseline arm and the staggered hours the
    stagger arm of this same pass, so `hourly_queue_profile` and
    `staggered_peak_hour` never re-simulate a day the metric already ran.
    """
    sds = tuple(sorted(set(DEPARTURE_SD_BAND_MINUTES) | {BASELINE_DEPARTURE_SD_MINUTES}))
    arms: tuple[float | None, ...] = (None, *sds)  # None = staggered
    runs: dict[float | None, list[tuple[float, float, int]]] = {arm: [] for arm in arms}
    hourly, staggered = _HourlyTally(), _StaggeredTally()
    for i in range(replications):
        z = _departure_z(trucks_per_day, seed, i)
        rng = random.Random(seed * 100000 + i)  # same draws for every arm
        rounds = _round_draws(trucks_per_day, rng)
        services = _service_draws(trucks_per_day, rng)
        for arm in arms:
            offsets = None if arm is None else _baseline_offsets(z, arm)
            arrivals = _gate_arrivals(trucks_per_day, rounds, offsets)
            waits, queued = _trace(arrivals, WEIGHBRIDGE_LANES, services)
            runs[arm].append((statistics.fmean(waits), _p95(waits), max(queued, default=0)))
            if arm is None:
                staggered.add_day(arrivals, waits, queued)
            elif arm == BASELINE_DEPARTURE_SD_MINUTES:
                hourly.add_day(arrivals, waits, queued)
    return (
        _day_summary(runs, trucks_per_day, seed, replications),
        hourly.rows(replications),
        staggered.hours(replications),
    )


@lru_cache(maxsize=64)
def _simulate_day(trucks_per_day: int, seed: int, replications: int) -> dict[str, Any]:
    """The cached simulation behind `queue_minutes_per_truck` (no source text).

    Arms: the recommended stagger, and the current-practice baseline at every
    departure spread of the sensitivity band (the headline spread among them).
    """
    return _seeded_day(trucks_per_day, seed, replications)[0]


def _day_summary(
    runs: dict[float | None, list[tuple[float, float, int]]],
    trucks_per_day: int,
    seed: int,
    replications: int,
) -> dict[str, Any]:
    """The daily metric from each arm's per-replication (mean wait, p95 wait, max queue)."""

    def summarise(arm: float | None) -> tuple[float, float, list[float], int]:
        rows = runs[arm]
        means = [r[0] for r in rows]
        return (
            round(statistics.fmean(means), 1),
            round(statistics.fmean(r[1] for r in rows), 1),
            _ci95(means),
            round(statistics.fmean(r[2] for r in rows)),
        )

    b_mean, b_p95, b_ci, b_queue = summarise(BASELINE_DEPARTURE_SD_MINUTES)
    s_mean, s_p95, s_ci, s_queue = summarise(None)
    rows = []
    for sd in sorted(DEPARTURE_SD_BAND_MINUTES):
        mean, p95, ci, _queue = summarise(sd)
        rows.append(
            {
                "departure_sd_minutes": sd,
                "baseline_mean": mean,
                "baseline_p95": p95,
                "baseline_ci95": ci,
                "reduction_minutes": round(mean - s_mean, 1),
                "reduction_percent": _reduction_percent(mean, s_mean),
            }
        )
    band_means = [row["baseline_mean"] for row in rows]
    band_reductions = [row["reduction_percent"] for row in rows]
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
        "reduction_percent": _reduction_percent(b_mean, s_mean),
        "baseline_departure_sd_minutes": BASELINE_DEPARTURE_SD_MINUTES,
        # The headline is a range, not one chosen point: the same day and draws
        # under the tightest and the loosest plausible departure spreads.
        "sensitivity": {
            "basis": (
                "baseline re-run with the same draws at each departure SD; the staggered arm "
                "does not depend on the baseline spread"
            ),
            "rows": rows,
            "baseline_band": [min(band_means), max(band_means)],
            "reduction_percent_band": [min(band_reductions), max(band_reductions)],
        },
        "assumptions": {
            "weighbridge_lanes": WEIGHBRIDGE_LANES,
            "weigh_cycle_minutes": WEIGH_CYCLE_MINUTES,
            "weighbridge_basis": WEIGHBRIDGE_ASSUMPTION,
            "collection_round_hours_mean_sd": [COLLECTION_ROUND_MEAN_H, COLLECTION_ROUND_SD_H],
            "shifts_per_day": SHIFTS_PER_DAY,
            "shift_hours": SHIFT_HOURS,
            "first_shift_start_hour": FIRST_SHIFT_START_HOUR,
            "baseline_departure_sd_minutes": BASELINE_DEPARTURE_SD_MINUTES,
            "departure_truncation_sd": DEPARTURE_TRUNCATION_SD,
            "sensitivity_departure_sd_minutes": list(sorted(DEPARTURE_SD_BAND_MINUTES)),
            "baseline": BASELINE_ASSUMPTION,
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


@lru_cache(maxsize=16)
def hourly_queue_profile(
    trucks_per_day: int | None = None,
    seed: int = QUEUE_METRIC_SEED,
    replications: int = QUEUE_METRIC_REPLICATIONS,
) -> tuple[dict[str, Any], ...] | None:
    """The metric's current-practice baseline day, broken down by gate-arrival clock hour (WIB).

    Same arrival model, headline departure spread, lanes, weigh cycle and seeds
    as `queue_minutes_per_truck` (the baseline arm's draws are identical), so the
    TPA status panel and the daily metric cannot disagree. 24 rows; hours
    without arrivals read zero.
    """
    if trucks_per_day is None:
        derived = bantargebang_daily_arrivals()
        if derived is None:
            return None
        trucks_per_day = derived[0]
    return _seeded_day(int(trucks_per_day), seed, replications)[1]


def modelled_peak_hour(trucks_per_day: int | None = None) -> dict[str, Any] | None:
    """The modelled peak hour of a day: the clock hour with the most queue-minutes.

    Reads the baseline day of `hourly_queue_profile` for `trucks_per_day` (the
    normal day when None), so a beacon showing it and the daily metric for the
    same truck count describe one day and one model. Never the wall clock.
    """
    profile = hourly_queue_profile(trucks_per_day)
    if not profile:
        return None
    return max(profile, key=lambda r: r["arrivals"] * r["mean_wait_minutes"])


def _clock(hours_after_first_shift: float) -> str:
    minutes = round((FIRST_SHIFT_START_HOUR + hours_after_first_shift) * 60) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


@lru_cache(maxsize=16)
def peak_hour_weigh_ins(trucks_per_day: int, hour: int, count: int = 3) -> tuple[dict[str, Any], ...]:
    """The first `count` gate arrivals of a clock hour on the metric's baseline day.

    Replication 0 of the same seeded day as `hourly_queue_profile` (same draws,
    departure spread, lanes and weigh cycle), so the TPA panel's weighbridge log
    is that day's own simulated trucks, not hand-written entries. `truck` is the
    arrival's rank in the simulated day, not a fleet unit; no weight is given
    because the simulation does not model payloads.
    """
    rng = random.Random(QUEUE_METRIC_SEED * 100000)
    offsets = _baseline_offsets(
        _departure_z(trucks_per_day, QUEUE_METRIC_SEED, 0), BASELINE_DEPARTURE_SD_MINUTES
    )
    arrivals = _arrival_hours(trucks_per_day, rng, offsets)
    waits, _queued = _day_trace(arrivals, WEIGHBRIDGE_LANES, rng)
    rows = []
    for rank, (arr, wait) in enumerate(zip(arrivals, waits, strict=True), start=1):
        if int(FIRST_SHIFT_START_HOUR + arr) % 24 != hour:
            continue
        rows.append(
            {
                "truck": f"SIM-{rank:04d}",
                "arrived": _clock(arr),
                "weigh_start": _clock(arr + wait / 60.0),
                "wait_minutes": round(wait, 1),
                "source": "SIMULATED",
            }
        )
        if len(rows) == count:
            break
    return tuple(rows)


@lru_cache(maxsize=16)
def staggered_peak_hour(trucks_per_day: int, hour: int) -> dict[str, Any]:
    """The recommended stagger's queue at the unstaggered day's modelled peak clock hour.

    The same seeded day as `hourly_queue_profile` (same seed per replication,
    lanes and weigh cycle), with departures spread over the stagger slots
    instead of the current-practice spread. SIMULATED.
    """
    hours = _seeded_day(trucks_per_day, QUEUE_METRIC_SEED, QUEUE_METRIC_REPLICATIONS)[2]
    # A clock hour outside 0-23 matches no arrival.
    arrivals, mean_wait, queue_mean, queue_max = hours[hour] if 0 <= hour < 24 else (0, 0.0, 0.0, 0)
    return {
        "hour": hour,
        "hour_label": f"modelled peak hour {hour:02d}:00",
        "arrivals": arrivals,
        "mean_wait_minutes": mean_wait,
        "queue_trucks_mean": queue_mean,
        "queue_trucks_max": queue_max,
        "stagger_minutes": STAGGER_SLOT_MINUTES,
        "trucks_per_day": trucks_per_day,
        "classification": "SIMULATED",
        "basis": (
            "same seeded day and clock hour as the unstaggered beacon, departures spread over "
            f"{STAGGER_SLOT_MINUTES}-minute slots"
        ),
    }
