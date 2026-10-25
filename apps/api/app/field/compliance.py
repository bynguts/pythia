"""Evidence-based driver compliance scoring (Fase 3).

Every deduction traces to a record: fleet deviation state (SIMULATED fleet),
SPJ stop evidence, damage reports, and pre-trip records. classification="derived"
per the provenance convention in app/impact.py; `inputs` labels each term.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from app.core.env import local_now, local_today
from app.field.damage_reports import DAMAGE_STORE
from app.field.pretrip import PRETRIP_STORE
from app.field.spj import SPJ_STORE
from app.fleet.data import get_dynamic_trucks

W_DEVIATION = 15
W_NO_EVIDENCE = 10
W_LATE = 5
W_HEAVY_REPORT = 10
W_NO_PRETRIP = 5
WINDOW_DAYS = 30


def _grade(score: float) -> str:
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    return "D"


def _window_start(today: date) -> date:
    return today - timedelta(days=WINDOW_DAYS)


def _local_day(iso_ts: str | None) -> date | None:
    """The Asia/Jakarta day of a stored timestamp (stored in UTC; a bare date is kept as is)."""
    if not iso_ts:
        return None
    try:
        stamp = datetime.fromisoformat(iso_ts)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return stamp.date()
    return stamp.astimezone(local_now().tzinfo).date()


def _in_window(iso_ts: str | None, start: date) -> bool:
    day = _local_day(iso_ts)
    return day is not None and day >= start


def compute_driver_score(driver_name: str, truck_codes: list[str], today: str | None = None) -> dict:
    ref = date.fromisoformat(today) if today else local_today()
    start = _window_start(ref)
    codes = set(truck_codes)

    deviation_violations = sum(
        1
        for t in get_dynamic_trucks()
        if t["truck_code"] in codes and (t.get("deviation") or {}).get("violated")
    )

    stops_without_evidence = 0
    stops_closed_by_override = 0
    late_completions = 0
    spj_dates: set[str] = set()
    for spj in SPJ_STORE.list():
        if spj.truck_code not in codes:
            continue
        spj_dates.add(spj.date)
        # Late = closed on a later WIB working day than the SPJ's own date (gap 10:
        # an early-shift SPJ is not "late" just because UTC rolled over at 07:00 WIB).
        completed_day = _local_day(spj.completed_at)
        if (
            spj.status == "selesai"
            and _in_window(spj.completed_at, start)
            and completed_day is not None
            and completed_day.isoformat() > spj.date
        ):
            late_completions += 1
        for stop in spj.stops:
            if not (stop.status == "completed" and _in_window(stop.completed_at, start)):
                continue
            if stop.evidence is not None:
                continue
            # A stop closed without field evidence is either an audited
            # supervisor override (a supervisor decision, reported but not
            # charged to the driver) or an unaudited gap that must never exist.
            if stop.override:
                stops_closed_by_override += 1
            else:
                stops_without_evidence += 1

    unresolved_heavy = sum(
        1
        for r in DAMAGE_STORE.list()
        if r.driver_name == driver_name and r.severity == "berat" and r.status != "selesai"
    )

    pretrip_dates: set[str] = set()
    for code in codes:
        for rec in PRETRIP_STORE.list_recent(code, days=WINDOW_DAYS * 4):
            pretrip_dates.add(rec.date)
    days_without_pretrip = len({d for d in spj_dates if _in_window(d, start)} - pretrip_dates)
    deductions = (
        W_DEVIATION * deviation_violations
        + W_NO_EVIDENCE * stops_without_evidence
        + W_LATE * late_completions
        + W_HEAVY_REPORT * unresolved_heavy
        + W_NO_PRETRIP * days_without_pretrip
    )
    score = round(max(0.0, 100.0 - deductions), 1)
    return {
        "driver_name": driver_name,
        "score": score,
        "grade": _grade(score),
        "breakdown": {
            "deviation_violations": deviation_violations,
            "stops_without_evidence": stops_without_evidence,
            "stops_closed_by_override": stops_closed_by_override,
            "late_completions": late_completions,
            "unresolved_heavy_reports": unresolved_heavy,
            "days_without_pretrip": days_without_pretrip,
        },
        "weights": {
            "deviation": W_DEVIATION,
            "no_evidence": W_NO_EVIDENCE,
            "late": W_LATE,
            "heavy_report": W_HEAVY_REPORT,
            "no_pretrip": W_NO_PRETRIP,
        },
        "computed_at": ref.isoformat(),
        "window_days": WINDOW_DAYS,
        "classification": "derived",
        # H11: the deviation term reads the simulated fleet, so the score mixes
        # simulated and recorded inputs; each input says which it is.
        "inputs": {
            "deviation": "SIMULATED",
            "spj": "REAL_RECORD",
            "damage_reports": "REAL_RECORD",
            "pretrip": "REAL_RECORD",
        },
        "inputs_note": "Deviation counts come from the simulated fleet, not from truck GPS.",
    }


def compute_fleet_scores(today: str | None = None) -> list[dict]:
    drivers: dict[str, list[str]] = {}
    for truck in get_dynamic_trucks():
        drivers.setdefault(truck["driver_name"], []).append(truck["truck_code"])
    scores = [compute_driver_score(name, codes, today=today) for name, codes in drivers.items()]
    scores.sort(key=lambda s: s["score"], reverse=True)
    return scores
