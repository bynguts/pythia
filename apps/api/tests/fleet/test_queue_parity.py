"""The single-pass queue simulation reproduces the per-arm reference exactly (demo latency).

`_seeded_day` draws each replication's collection-round legs and weigh-ins once and
shares them across arms, and derives the hourly profile and the staggered peak hour
from the same pass. The reference below is the earlier implementation, which
reseeded the generator for every arm and re-simulated the day for the hourly
profile and the staggered hour. Same seeds, same numbers: equality, not closeness.
"""

from __future__ import annotations

import bisect
import heapq
import random
import statistics
from collections import defaultdict

import pytest

from app.fleet import queue_simulation as qs


def _ref_arrival_hours(trips: int, rng: random.Random, offsets: list[float] | None) -> list[float]:
    slots = qs.stagger_slot_count()
    arrivals: list[float] = []
    trip = 0
    for shift in range(qs.SHIFTS_PER_DAY):
        start = shift * qs.SHIFT_HOURS
        count = trips // qs.SHIFTS_PER_DAY + (1 if shift < trips % qs.SHIFTS_PER_DAY else 0)
        for i in range(count):
            offset = (i % slots) * qs.STAGGER_SLOT_MINUTES / 60.0 if offsets is None else offsets[trip]
            trip += 1
            arrivals.append(
                start + offset + max(0.5, rng.gauss(qs.COLLECTION_ROUND_MEAN_H, qs.COLLECTION_ROUND_SD_H))
            )
    arrivals.sort()
    return arrivals


def _ref_day_trace(arrivals: list[float], lanes: int, rng: random.Random) -> tuple[list[float], list[int]]:
    free_at = [float("-inf")] * lanes
    starts: list[float] = []
    waits: list[float] = []
    queued: list[int] = []
    for arr in arrivals:
        queued.append(len(starts) - bisect.bisect_right(starts, arr))
        start = max(arr, heapq.heappop(free_at))
        heapq.heappush(free_at, start + rng.expovariate(qs.WEIGHBRIDGE_TRUCKS_PER_HOUR))
        starts.append(start)
        waits.append((start - arr) * 60.0)
    return waits, queued


def _ref_simulate_day(trucks: int, seed: int, replications: int) -> dict:
    sds = tuple(sorted(set(qs.DEPARTURE_SD_BAND_MINUTES) | {qs.BASELINE_DEPARTURE_SD_MINUTES}))
    arms = (None, *sds)
    runs: dict = {arm: [] for arm in arms}
    for i in range(replications):
        z = qs._departure_z(trucks, seed, i)
        for arm in arms:
            rng = random.Random(seed * 100000 + i)
            offsets = None if arm is None else qs._baseline_offsets(z, arm)
            arrivals = _ref_arrival_hours(trucks, rng, offsets)
            waits, queued = _ref_day_trace(arrivals, qs.WEIGHBRIDGE_LANES, rng)
            runs[arm].append((statistics.fmean(waits), qs._p95(waits), max(queued, default=0)))
    return qs._day_summary(runs, trucks, seed, replications)


def _ref_hourly(trucks: int, seed: int, replications: int) -> tuple:
    waits: list[list[float]] = [[] for _ in range(24)]
    rep_means: list[list[float]] = [[] for _ in range(24)]
    rep_max_queue: list[list[int]] = [[] for _ in range(24)]
    queued_ahead: list[list[int]] = [[] for _ in range(24)]
    for i in range(replications):
        rng = random.Random(seed * 100000 + i)
        offsets = qs._baseline_offsets(qs._departure_z(trucks, seed, i), qs.BASELINE_DEPARTURE_SD_MINUTES)
        arrivals = _ref_arrival_hours(trucks, rng, offsets)
        day_waits, queued = _ref_day_trace(arrivals, qs.WEIGHBRIDGE_LANES, rng)
        hour_waits: dict[int, list[float]] = defaultdict(list)
        hour_queue: dict[int, int] = defaultdict(int)
        for arr, wait, ahead in zip(arrivals, day_waits, queued, strict=True):
            hour = int(qs.FIRST_SHIFT_START_HOUR + arr) % 24
            hour_waits[hour].append(wait)
            hour_queue[hour] = max(hour_queue[hour], ahead)
            queued_ahead[hour].append(ahead)
        for hour, values in hour_waits.items():
            waits[hour].extend(values)
            rep_means[hour].append(statistics.fmean(values))
            rep_max_queue[hour].append(hour_queue[hour])
    capacity = qs.WEIGHBRIDGE_LANES * qs.WEIGHBRIDGE_TRUCKS_PER_HOUR
    rows = []
    for hour in range(24):
        per_rep = len(waits[hour]) / replications
        rows.append(
            {
                "hour": hour,
                "arrivals": round(per_rep),
                "queue_trucks_mean": (
                    round(statistics.fmean(queued_ahead[hour]), 1) if queued_ahead[hour] else 0.0
                ),
                "mean_wait_minutes": round(statistics.fmean(waits[hour]), 1) if waits[hour] else 0.0,
                "p95_wait_minutes": round(qs._p95(waits[hour]), 1) if waits[hour] else 0.0,
                "max_queue": round(statistics.fmean(rep_max_queue[hour])) if rep_max_queue[hour] else 0,
                "wait_ci95": qs._ci95(rep_means[hour]) if rep_means[hour] else [0.0, 0.0],
                "utilization": round(per_rep / capacity, 3),
                "throughput_per_hour": capacity,
            }
        )
    return tuple(rows)


def _ref_staggered_hour(trucks: int, hour: int) -> tuple:
    waits: list[float] = []
    queued_ahead: list[int] = []
    max_queue: list[int] = []
    for i in range(qs.QUEUE_METRIC_REPLICATIONS):
        rng = random.Random(qs.QUEUE_METRIC_SEED * 100000 + i)
        arrivals = _ref_arrival_hours(trucks, rng, None)
        day_waits, queued = _ref_day_trace(arrivals, qs.WEIGHBRIDGE_LANES, rng)
        in_hour = [
            (w, q)
            for a, w, q in zip(arrivals, day_waits, queued, strict=True)
            if int(qs.FIRST_SHIFT_START_HOUR + a) % 24 == hour
        ]
        waits.extend(w for w, _q in in_hour)
        queued_ahead.extend(q for _w, q in in_hour)
        max_queue.append(max((q for _w, q in in_hour), default=0))
    return (
        round(len(waits) / qs.QUEUE_METRIC_REPLICATIONS),
        round(statistics.fmean(waits), 1) if waits else 0.0,
        round(statistics.fmean(queued_ahead), 1) if queued_ahead else 0.0,
        round(statistics.fmean(max_queue)) if max_queue else 0,
    )


@pytest.mark.parametrize(("trucks", "seed", "replications"), [(7, 3, 5), (400, 42, 12), (1303, 42, 8)])
def test_single_pass_matches_the_per_arm_reference(trucks, seed, replications):
    qs._seeded_day.cache_clear()
    metric, hourly, _staggered = qs._seeded_day(trucks, seed, replications)
    assert metric == _ref_simulate_day(trucks, seed, replications)
    assert hourly == _ref_hourly(trucks, seed, replications)


def test_normal_day_payloads_match_the_reference_at_full_replications():
    trucks, _source = qs.bantargebang_daily_arrivals()
    qs._seeded_day.cache_clear()
    qs._simulate_day.cache_clear()
    qs.hourly_queue_profile.cache_clear()
    qs.staggered_peak_hour.cache_clear()
    seed, reps = qs.QUEUE_METRIC_SEED, qs.QUEUE_METRIC_REPLICATIONS
    assert qs._simulate_day(trucks, seed, reps) == _ref_simulate_day(trucks, seed, reps)
    assert qs.hourly_queue_profile(trucks) == _ref_hourly(trucks, seed, reps)
    peak = qs.modelled_peak_hour(trucks)["hour"]
    for hour in (peak, 7, 13, 23, 24):
        got = qs.staggered_peak_hour(trucks, hour)
        expected = _ref_staggered_hour(trucks, hour)
        assert (
            got["arrivals"],
            got["mean_wait_minutes"],
            got["queue_trucks_mean"],
            got["queue_trucks_max"],
        ) == expected, hour


def test_rep_zero_helpers_still_draw_like_the_reference():
    trucks = 500
    rng_new, rng_ref = random.Random(4200000), random.Random(4200000)
    offsets = qs._baseline_offsets(qs._departure_z(trucks, 42, 0), 30.0)
    arrivals = qs._arrival_hours(trucks, rng_new, offsets)
    assert arrivals == _ref_arrival_hours(trucks, rng_ref, offsets)
    assert qs._day_trace(arrivals, 4, rng_new) == _ref_day_trace(arrivals, 4, rng_ref)


def test_the_hourly_profile_and_staggered_hour_reuse_the_metric_pass():
    qs._seeded_day.cache_clear()
    qs._simulate_day.cache_clear()
    qs.hourly_queue_profile.cache_clear()
    qs.staggered_peak_hour.cache_clear()
    qs.queue_minutes_per_truck(321)
    qs.hourly_queue_profile(321)
    qs.staggered_peak_hour(321, 9)
    assert qs._seeded_day.cache_info().misses == 1
