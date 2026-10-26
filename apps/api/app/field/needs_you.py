"""The dispatcher's "Needs you" feed: every open item that wants a decision, one list (wave 13).

Read-only. It gathers what other stores already hold and adds no fact of its own:

- ``deviation``: simulated trucks off their corridor (``SIMULATED`` positions);
- ``accident`` / ``truck_breakdown`` / ``road_closed`` / ``tps_empty``: today's
  driver exception reports (field records); open heavy damage reports also count
  as a breakdown;
- ``gate_peak``: unaccepted hold recommendations of today's gate-slot board (queue model);
- ``duty_warn`` / ``duty_blocked``: duty hours from **observed** app events only.
  The safety module's seeded scenario is not an alert (blocking and WhatsApp
  alerts act on observed events only), so it is counted under ``sources`` instead.

An item whose follow-up (``POST /api/alert/follow-up``, keyed by the item ``id``)
is RESOLVED is dropped. Ids that recur every day (a corridor, a duty clock, a
gate slot) only honour a follow-up recorded on the same local day.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.core.env import local_today
from app.field import safety
from app.field.damage_reports import DAMAGE_STORE
from app.field.driver_exceptions import EXCEPTION_STORE
from app.field.spj import SPJ_STORE

CATEGORIES = {
    "deviation": "trucks",
    "accident": "trucks",
    "truck_breakdown": "trucks",
    "road_closed": "trucks",
    "duty_warn": "trucks",
    "duty_blocked": "trucks",
    "gate_peak": "gate",
    "tps_empty": "tps",
}
URGENT_KINDS = ("accident", "truck_breakdown", "duty_blocked")
FOLLOW_UP_SCAN = 2000
# Unique per record: a follow-up on any day closes them.
_UNIQUE_PREFIXES = ("driver-exception:", "damage:")


def _local_date(iso: str | None) -> str | None:
    parsed = safety._parse(iso)
    return parsed.astimezone(safety.WIB).date().isoformat() if parsed else None


def exception_alert_id(exception_id: str) -> str:
    """The follow-up key the console uses for one driver exception."""
    return f"driver-exception:{exception_id}"


def follow_up_statuses(day: str) -> dict[str, dict[str, Any]]:
    """alert_id -> its latest follow-up ``{status, note, operator, at}``.

    A recurring id (anything not unique per record) only counts a follow-up of ``day``.
    """
    latest: dict[str, dict[str, Any]] = {}
    for event in history_store.list_events(limit=FOLLOW_UP_SCAN):  # newest first
        if event["event_type"] != "alert_followup":
            continue
        payload = event["payload"]
        alert_id = str(payload.get("alert_id") or "")
        if not alert_id or alert_id in latest:
            continue
        if not alert_id.startswith(_UNIQUE_PREFIXES) and _local_date(event["created_at"]) != day:
            continue
        latest[alert_id] = {
            "status": payload.get("status"),
            "note": payload.get("note") or "",
            "operator": payload.get("operator"),
            "at": event["created_at"],
        }
    return latest


def _item(
    item_id: str,
    kind: str,
    *,
    truck_code: str | None,
    created_at: str | None,
    facts: dict[str, Any],
    actions: list[str],
    classification: str,
    spj_id: str | None = None,
    severity: str | None = None,
    suggestion: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "kind": kind,
        "category": CATEGORIES[kind],
        "severity": severity or ("urgent" if kind in URGENT_KINDS else "normal"),
        "truck_code": truck_code,
        "spj_id": spj_id,
        "created_at": created_at,
        "facts": facts,
        "suggestion": suggestion,
        "actions": actions,
        "classification": classification,
    }


def _active_spj_ids() -> dict[str, str]:
    return {s.truck_code: s.spj_id for s in SPJ_STORE.list() if s.status == "aktif"}


def _plan_of(truck_code: str, day: str) -> str | None:
    """The approved plan of ``day`` that holds this truck (for a reassign), or None."""
    for plan in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=100):
        if plan.get("plan_date") != day:
            continue
        if any(d.get("truck_code") == truck_code for d in plan.get("dispatches") or []):
            return plan["plan_id"]
    return None


def _deviations(active: dict[str, str]) -> list[dict[str, Any]]:
    from app.fleet.data import get_dynamic_trucks

    items = []
    for truck in get_dynamic_trucks():
        deviation = truck.get("deviation") or {}
        if not deviation.get("violated"):
            continue
        code = truck["truck_code"]
        items.append(
            _item(
                f"ALT-{code}",  # the command-center alert id, so follow-ups match
                "deviation",
                truck_code=code,
                spj_id=active.get(code),
                created_at=None,  # the simulated feed carries no onset time
                facts={
                    "distance_meters": deviation.get("distance_meters"),
                    "sustained": "sustained_deviation" in (deviation.get("rule_flags") or []),
                    "model_severity": deviation.get("severity"),
                },
                actions=["send_route", "mark_handled"],
                classification="SIMULATED",
                severity="urgent" if deviation.get("severity") == "critical" else "normal",
            )
        )
    return items


def _stop(spj_id: str | None, stop_index: int | None) -> tuple[str | None, str | None, bool]:
    """(stop name, stop status, whether dispatch may still skip it)."""
    if not spj_id or stop_index is None:
        return None, None, False
    spj = SPJ_STORE.get(spj_id)
    if spj is None or not 0 <= stop_index < len(spj.stops):
        return None, None, False
    stop = spj.stops[stop_index]
    return stop.name, stop.status, spj.status == "aktif" and stop.status == "pending"


def _stop_name(spj_id: str | None, stop_index: int | None) -> str | None:
    return _stop(spj_id, stop_index)[0]


def _exceptions(day: str, follow_ups: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], set[str]]:
    """Today's open driver exceptions; also the damage report ids they already stand for."""
    items: list[dict[str, Any]] = []
    covered: set[str] = set()
    tps: dict[tuple, list[Any]] = {}
    for exc in EXCEPTION_STORE.list():  # newest first
        if _local_date(exc.reported_at or exc.created_at) != day:
            continue
        alert_id = exception_alert_id(exc.exception_id)
        if exc.damage_report_id:
            covered.add(exc.damage_report_id)
        if (follow_ups.get(alert_id) or {}).get("status") == "RESOLVED":
            continue
        if exc.kind == "tps_empty":
            key = (exc.spj_id, exc.stop_index) if exc.spj_id and exc.stop_index is not None else (alert_id,)
            tps.setdefault(key, []).append(exc)
            continue
        facts = {
            "exception_id": exc.exception_id,
            "driver_name": exc.driver_name,
            "note": exc.note,
            "has_photo": bool(exc.photo_b64),
            "lat": exc.lat,
            "lng": exc.lng,
            "stop_index": exc.stop_index,
            "stop_name": _stop_name(exc.spj_id, exc.stop_index),
            "damage_report_id": exc.damage_report_id,
            "follow_up": follow_ups.get(alert_id),
        }
        actions = {
            "accident": ["escalate", "mark_handled"],
            "truck_breakdown": ["reassign", "mark_handled"],
            "road_closed": ["send_route", "mark_handled"],
        }[exc.kind]
        items.append(
            _item(
                alert_id,
                exc.kind,
                truck_code=exc.truck_code,
                spj_id=exc.spj_id,
                created_at=exc.reported_at or exc.created_at,
                facts=facts,
                actions=actions,
                classification="FIELD",
            )
        )
    for key, reports in tps.items():
        first = reports[0]
        item_id = f"tps-empty:{first.spj_id}:{first.stop_index}" if len(key) == 2 else key[0]
        if (follow_ups.get(item_id) or {}).get("status") == "RESOLVED":
            continue
        name, stop_status, skippable = _stop(first.spj_id, first.stop_index)
        if stop_status == "skipped":
            continue  # dispatch already decided
        items.append(
            _item(
                item_id,
                "tps_empty",
                truck_code=first.truck_code,
                spj_id=first.spj_id,
                created_at=first.reported_at or first.created_at,
                facts={
                    "reports": len(reports),
                    "stop_index": first.stop_index,
                    "stop_name": name,
                    "stop_status": stop_status,
                    "truck_codes": sorted({r.truck_code for r in reports}),
                    "exception_ids": [r.exception_id for r in reports],
                    "notes": [r.note for r in reports if r.note],
                },
                actions=["skip_stop", "mark_handled"] if skippable else ["mark_handled"],
                classification="FIELD",
            )
        )
    return items, covered


def _damage(covered: set[str], follow_ups: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Open heavy damage reports not already raised by a driver exception."""
    items = []
    for report in DAMAGE_STORE.list(status="baru"):
        if report.severity != "berat" or report.report_id in covered:
            continue
        alert_id = f"damage:{report.report_id}"
        if (follow_ups.get(alert_id) or {}).get("status") == "RESOLVED":
            continue
        items.append(
            _item(
                alert_id,
                "truck_breakdown",
                truck_code=report.truck_code,
                created_at=report.created_at,
                facts={
                    "damage_report_id": report.report_id,
                    "component": report.component,
                    "note": report.note,
                    "source": report.source,
                    "driver_name": report.driver_name,
                },
                actions=["reassign", "mark_handled"],
                classification="FIELD",
            )
        )
    return items


def _gate_peaks(day: str, follow_ups: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    from datetime import date

    from app.api.routers.gate_slots import gate_slots_payload

    board = gate_slots_payload(date.fromisoformat(day))
    waits = {s["start"]: s["expected_wait_min"] for s in board["slots"]}
    peaks: dict[str, list[dict[str, Any]]] = {}
    for rec in board["recommendations"]:
        if not rec.get("accepted"):
            peaks.setdefault(rec["from_slot"], []).append(rec)
    items = []
    for start, recs in sorted(peaks.items()):
        item_id = f"gate-peak:{day}:{start}"
        if (follow_ups.get(item_id) or {}).get("status") == "RESOLVED":
            continue
        items.append(
            _item(
                item_id,
                "gate_peak",
                truck_code=None,
                created_at=None,
                facts={
                    "date": day,
                    "slot": start,
                    "expected_wait_min": waits.get(start),
                    "holds": [
                        {
                            "rec_id": r["id"],
                            "truck_code": r["truck_code"],
                            "hold_minutes": r["hold_minutes"],
                            "to_slot": r["to_slot"],
                            "expected_wait_reduction_min": r["expected_wait_reduction_min"],
                        }
                        for r in recs
                    ],
                    "wait_method": board.get("wait_method"),
                },
                actions=["accept"],
                classification=board["classification"],
            )
        )
    return items


def _duty(day: str, now: datetime, follow_ups: dict[str, dict[str, Any]]) -> tuple[list, dict[str, Any]]:
    overview = safety.overview(now)
    observed = overview["classification"] == safety.OBSERVED
    flagged = [t for t in overview["trucks"] if t["duty_state"] in ("warn", "blocked")]
    source = {
        "classification": overview["classification"],
        "included": observed,
        "flagged": len(flagged),
        "reason": None if observed else "no observed duty events today; the seeded scenario is not an alert",
    }
    if not observed:
        return [], source
    items = []
    for truck in flagged:
        alert_id = f"duty-{truck['truck_code']}"
        if (follow_ups.get(alert_id) or {}).get("status") == "RESOLVED":
            continue
        blocked = truck["duty_state"] == "blocked" and truck["override"] is None
        items.append(
            _item(
                alert_id,
                "duty_blocked" if blocked else "duty_warn",
                truck_code=truck["truck_code"],
                created_at=truck["shift_started_at"],
                facts={
                    "duty_minutes": truck["duty_minutes"],
                    "warn_at_minutes": truck["warn_at_minutes"],
                    "block_at_minutes": truck["block_at_minutes"],
                    "override": truck["override"],
                    "shift_source": truck["shift_source"],
                    "follow_up": follow_ups.get(alert_id),
                },
                actions=["plan_relief", "mark_handled"],
                classification="FIELD",
            )
        )
    return items, source


def _suggest_backups(items: list[dict[str, Any]], day: str) -> None:
    """A breakdown in an approved plan gets the first readiness backup as its suggestion."""
    breakdowns = [i for i in items if i["kind"] == "truck_breakdown"]
    if not breakdowns:
        return
    from app.field.readiness import readiness_payload

    candidates = readiness_payload(day, "plan")["backup_candidates"]
    for item in breakdowns:
        plan_id = _plan_of(item["truck_code"], day)
        item["facts"]["plan_id"] = plan_id
        if plan_id and candidates:
            backup = candidates[0]
            item["suggestion"] = {
                "kind": "reassign",
                "plan_id": plan_id,
                "from_truck": item["truck_code"],
                "to_truck": backup["truck_code"],
                "basis": backup["basis"],
                "classification": backup["classification"],
            }


def _sort_key(item: dict[str, Any]) -> tuple:
    """Urgent first, then newest first; items without a time last."""
    at = safety._parse(item["created_at"])
    return (item["severity"] != "urgent", -(at.timestamp() if at else 0.0), item["id"])


def needs_you(now: datetime | None = None) -> dict[str, Any]:
    now = now or safety._now()
    day = local_today().isoformat()
    follow_ups = follow_up_statuses(day)
    exceptions, covered = _exceptions(day, follow_ups)
    duty, duty_source = _duty(day, now, follow_ups)
    items = (
        _deviations(_active_spj_ids())
        + exceptions
        + _damage(covered, follow_ups)
        + _gate_peaks(day, follow_ups)
        + duty
    )
    items = [i for i in items if (follow_ups.get(i["id"]) or {}).get("status") != "RESOLVED"]
    _suggest_backups(items, day)
    items.sort(key=_sort_key)
    counts = {"all": len(items), "urgent": sum(1 for i in items if i["severity"] == "urgent")}
    for category in ("trucks", "gate", "tps"):
        counts[category] = sum(1 for i in items if i["category"] == category)
    return {
        "date": day,
        "generated_at": now.isoformat(),
        "counts": counts,
        "items": items,
        "sources": {
            "deviation": {"classification": "SIMULATED"},
            "exceptions": {"classification": "FIELD", "window": "local day"},
            "gate": {"classification": "SIMULATED"},
            "duty": duty_source,
        },
    }
