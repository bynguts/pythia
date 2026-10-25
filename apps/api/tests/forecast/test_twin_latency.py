"""Demo latency of /api/twin/scene: what a what-if recomputes once the default scene is warm.

Run with `--durations=0` to read the cold and warm timings. The assertions pin the
work, not wall-clock seconds: a what-if on a new truck count runs the seeded queue
day once (the hourly beacon and the staggered peak hour come from that same pass),
and a repeated what-if runs nothing.
"""

from __future__ import annotations

import pytest

from app.fleet import queue_simulation as qs

WHAT_IF = "/api/twin/scene?weather=none&rainfall_mm=60&day=3"


@pytest.fixture()
def warm_default(api_client):
    res = api_client.get("/api/twin/scene?weather=none")  # the cold scene (models, normal day)
    assert res.status_code == 200
    return res.json()


def test_a_what_if_simulates_its_queue_day_once(api_client, warm_default):
    qs._seeded_day.cache_clear()
    qs.hourly_queue_profile.cache_clear()
    qs.staggered_peak_hour.cache_clear()
    qs._simulate_day.cache_clear()
    scene = api_client.get(WHAT_IF).json()
    metric = scene["landfill_queue"]["minutes_per_truck"]
    assert metric["scenario_scaled"] is True
    # The normal day (for normal_day) and the scaled day: one pass each.
    assert qs._seeded_day.cache_info().misses == 2


def test_a_repeated_what_if_runs_no_simulation(api_client, warm_default):
    first = api_client.get(WHAT_IF).json()
    misses = qs._seeded_day.cache_info().misses
    again = api_client.get(WHAT_IF).json()
    assert qs._seeded_day.cache_info().misses == misses
    assert again["landfill_queue"] == first["landfill_queue"]
    assert [d["series"] for d in again["districts"]] == [d["series"] for d in first["districts"]]
