"""
deviation_state.py — alert hysteresis for corridor deviation (Case 1).

detect_route_deviation is intentionally stateless. Live dashboards, however,
must not flicker an alert off when a GPS ping briefly drifts under the
threshold while the truck is still mid-detour. This module adds the standard
monitoring-system latch: an alert OPENS above 500 m and only CLEARS once the
truck returns within 50 m of its corridor (its normal loop start clears it).
Both fleet surfaces (_truck and map_truth) share this one latch so panels
never disagree.
"""

from __future__ import annotations

OPEN_THRESHOLD_M = 500.0
CLEAR_THRESHOLD_M = 50.0

_states: dict[str, bool] = {}


def apply_hysteresis(truck_code: str, distance_m: float) -> bool:
    """Latched violation state for a truck: open >=500m, clear <=50m, else hold."""
    state = _states.get(truck_code, False)
    if distance_m >= OPEN_THRESHOLD_M:
        state = True
    elif distance_m <= CLEAR_THRESHOLD_M:
        state = False
    _states[truck_code] = state
    return state


DEMO_SUPPRESSION_MESSAGE = "Deviation not measured: the active SPJ is a DEMO work order."


def deviation_suppression(truck_code: str) -> str | None:
    """Why deviation is not measured for this truck right now, or None.

    The one decision every deviation surface (_truck, map truth, trip
    history) reads, so they cannot disagree (gsc C1). A failed SPJ lookup
    is not a DEMO SPJ: deviation stays measured against the corridor.
    """
    from app.field.spj import active_spj_is_demo

    return "demo_spj" if active_spj_is_demo(truck_code) is True else None


def reset_hysteresis() -> None:
    _states.clear()
