"""The dispatcher's "Needs you" feed: every open item that wants a decision, one list (wave 13).

Read-only. It gathers what other stores already hold and adds no fact of its own:

- ``deviation``: simulated trucks off their corridor (``SIMULATED`` positions);
- ``accident`` / ``truck_breakdown`` / ``road_closed`` / ``tps_empty``: today's
  driver exception reports (field records); open heavy damage reports also count
  as a breakdown;
- ``gate_peak``: unaccepted hold recommendations of today's gate-slot board (queue model);
- ``duty_warn`` / ``duty_blocked``: duty hours from **observed** app events only.
  The safety module's seeded scenario is not an alert (blocking and WhatsApp
  alerts act on observed events only), so it is counted under ``sources`` instead;
- ``receipt_check``: a weighbridge receipt of the last ``RECEIPT_CHECK_DAYS`` local
  days whose rule checks (app.field.receipt_checks) want a review: recorded data
  compared by plain rules, not AI. A broken seal is urgent;
- ``escalation``: an operator's escalation to the field supervisor (an approved Ana
  proposal or a console action), open until handled.

Every item also carries a deterministic ``next_step`` (one imperative sentence) and
the ``rule`` that raised it (the constant's name and value), both as an i18n key
plus params for the console's ``ns_`` catalog: templates, never generated text.

An item whose follow-up (``POST /api/alert/follow-up``, keyed by the item ``id``)
is RESOLVED is dropped. Ids that recur every day (a corridor, a duty clock, a
gate slot) only honour a follow-up recorded on the same local day.
"""

from __future__ import annotations

from datetime import datetime
from inspect import signature
from typing import Any

from app.api.state import _OPERATIONS_PLAN_STORE, history_store
from app.core.env import local_today
from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN, TRUCK_CAPACITY_TONS
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
    "receipt_check": "gate",
    "escalation": "trucks",
}
URGENT_KINDS = ("accident", "truck_breakdown", "duty_blocked")
FOLLOW_UP_SCAN = 2000
# Unique per record: a follow-up on any day closes them.
_UNIQUE_PREFIXES = ("driver-exception:", "damage:", "receipt-check:", "escalation:")
RECEIPT_CHECK_DAYS = 7


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


def _active_spjs() -> dict[str, Any]:
    return {s.truck_code: s for s in SPJ_STORE.list() if s.status == "aktif"}


def _plan_of(truck_code: str, day: str) -> str | None:
    """The approved plan of ``day`` that holds this truck (for a reassign), or None."""
    for plan in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=100):
        if plan.get("plan_date") != day:
            continue
        if any(d.get("truck_code") == truck_code for d in plan.get("dispatches") or []):
            return plan["plan_id"]
    return None


def _deviations(active: dict[str, Any]) -> list[dict[str, Any]]:
    from app.fleet.data import get_dynamic_trucks

    items = []
    for truck in get_dynamic_trucks():
        deviation = truck.get("deviation") or {}
        if not deviation.get("violated"):
            continue
        code = truck["truck_code"]
        spj = active.get(code)
        items.append(
            _item(
                f"ALT-{code}",  # the command-center alert id, so follow-ups match
                "deviation",
                truck_code=code,
                spj_id=spj.spj_id if spj else None,
                created_at=None,  # the simulated feed carries no onset time
                facts={
                    # The human work-order number the row shows; the spj_id is a hash.
                    "spj_number": spj.spj_number if spj else None,
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
                            "to_slot_end": r.get("to_slot_end"),
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


def _receipt_checks(day: str, follow_ups: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Receipts of the recent local days whose rule checks ask for a review."""
    from datetime import date, timedelta

    from app.field.receipt_checks import checks_for

    since = (date.fromisoformat(day) - timedelta(days=RECEIPT_CHECK_DAYS - 1)).isoformat()
    recent = [
        s
        for s in SPJ_STORE.list()
        if s.receipt and (_local_date(s.receipt.get("recorded_at")) or "") >= since
    ]
    photos = SPJ_STORE.sealed_receipt_photos() if recent else {}
    tickets = SPJ_STORE.receipt_ticket_numbers() if recent else {}
    items = []
    for spj in recent:
        alert_id = f"receipt-check:{spj.spj_id}"
        if (follow_ups.get(alert_id) or {}).get("status") == "RESOLVED":
            continue
        result = checks_for(SPJ_STORE, spj, photos, tickets)
        if result is None or result["overall"] != "review":
            continue
        failed = [c for c in result["checks"] if c["state"] == "fail"]
        items.append(
            _item(
                alert_id,
                "receipt_check",
                truck_code=spj.truck_code,
                spj_id=spj.spj_id,
                created_at=spj.receipt.get("recorded_at"),
                facts={
                    "spj_number": spj.spj_number,
                    "failed": [{"id": c["id"], "detail": c["detail"]} for c in failed],
                    "basis": result["basis"],
                },
                actions=["mark_handled"],
                classification="FIELD",
                severity="urgent" if any(c["id"] == "sealed" for c in failed) else None,
            )
        )
    return items


def _escalations() -> list[dict[str, Any]]:
    """Open escalations to the supervisor (their own store), whatever day they were raised."""
    from app.field.driver_messages import escalations

    return [
        _item(
            esc["id"],
            "escalation",
            truck_code=esc.get("truck_code"),
            created_at=esc["created_at"],
            facts={
                "subject": esc.get("subject") or "",
                "text": esc.get("text") or "",
                "source": (esc.get("client_hints") or {}).get("source"),
                "raised_by": esc.get("approved_by"),
            },
            actions=["mark_handled"],
            classification="FIELD",
        )
        for esc in escalations()
    ]


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


def _step(key: str, **params: Any) -> dict[str, Any]:
    return {"key": f"ns_step_{key}", "params": params}


def _rule(key: str, rule_id: str, value: Any, unit: str | None = None, **params: Any) -> dict[str, Any]:
    """The rule or threshold that raised an item: its name, its value, and the i18n key that says it."""
    return {
        "id": rule_id,
        "value": value,
        "unit": unit,
        "key": f"ns_rule_{key}",
        "params": {"value": value, **params},
    }


# A failed receipt check, most serious first: the one the next step answers.
_RECEIPT_CHECK_ORDER = (
    "sealed",
    "duplicate_ticket",
    "duplicate_ticket_no",
    "ticket_document",
    "plate_vs_truck",
    "ticket_arithmetic",
    "net_vs_capacity",
    "ocr_vs_entered",
)


def _guidance(item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """(next_step, rule) of one item, from its kind and facts alone."""
    kind, facts = item["kind"], item["facts"]
    truck = item["truck_code"] or ""
    if kind == "deviation":
        from app.forecast.engine import detect_route_deviation

        # The corridor width the fleet feed calls the detector with (its default), read, not copied.
        meters = signature(detect_route_deviation).parameters["threshold_meters"].default
        return _step("deviation", truck=truck), _rule("deviation", "CORRIDOR_THRESHOLD_M", meters, "m")
    if kind == "truck_breakdown" and "exception_id" not in facts:
        rule = _rule("damage_heavy", "DAMAGE_SEVERITY", "berat")
    elif kind in ("accident", "truck_breakdown", "road_closed", "tps_empty"):
        rule = _rule(kind, "DRIVER_EXCEPTION", kind, reports=facts.get("reports", 1))
    if kind == "accident":
        return _step("accident", truck=truck), rule
    if kind == "truck_breakdown":
        suggestion = item["suggestion"] or {}
        if suggestion.get("kind") == "reassign":
            return _step("breakdown_backup", truck=truck, to=suggestion["to_truck"]), rule
        return _step("breakdown", truck=truck), rule
    if kind == "road_closed":
        return _step("road_closed", truck=truck), rule
    if kind == "tps_empty":
        stop = facts.get("stop_name") or ""
        return _step("tps_skip" if "skip_stop" in item["actions"] else "tps", stop=stop), rule
    if kind == "gate_peak":
        from app.fleet.gate_slots import CAPACITY_PER_SLOT, STAGGER_SLOT_MINUTES

        return (
            _step("gate_peak", n=len(facts["holds"]), slot=facts["slot"]),
            _rule(
                "gate_peak",
                "CAPACITY_PER_SLOT",
                CAPACITY_PER_SLOT,
                "trucks",
                slot=facts["slot"],
                minutes=STAGGER_SLOT_MINUTES,
            ),
        )
    if kind in ("duty_warn", "duty_blocked"):
        # An overridden block stays a warning, but the 12 h limit is what it crossed.
        blocked = (facts.get("duty_minutes") or 0) >= DUTY_BLOCK_MIN
        rule = (
            _rule("duty_block", "DUTY_BLOCK_MIN", DUTY_BLOCK_MIN, "min")
            if blocked
            else _rule("duty_warn", "DUTY_WARN_MIN", DUTY_WARN_MIN, "min")
        )
        return _step(kind, truck=truck, h=DUTY_BLOCK_MIN // 60), rule
    if kind == "receipt_check":
        from app.field.receipt_checks import (
            OCR_TOLERANCE_MIN_KG,
            OCR_TOLERANCE_SHARE,
            TICKET_ARITHMETIC_TOLERANCE_KG,
        )

        failed = {c["id"] for c in facts.get("failed") or []}
        check = next((c for c in _RECEIPT_CHECK_ORDER if c in failed), None)
        spj = facts.get("spj_number") or item["spj_id"] or ""
        if check == "sealed":
            return _step("receipt_sealed", spj=spj), _rule("receipt_sealed", "SPJ_SEAL", "broken")
        if check == "duplicate_ticket":
            return _step("receipt_duplicate", spj=spj), _rule(
                "receipt_duplicate", "DUPLICATE_TICKET_PHOTO", "same photo"
            )
        if check == "duplicate_ticket_no":
            return _step("receipt_ticket_no", spj=spj), _rule(
                "receipt_ticket_no", "DUPLICATE_TICKET_NO", "same ticket number"
            )
        if check == "ticket_document":
            return _step("receipt_document", spj=spj), _rule(
                "receipt_document", "TICKET_DOCUMENT", "not a ticket"
            )
        if check == "plate_vs_truck":
            return _step("receipt_plate", spj=spj, truck=truck), _rule(
                "receipt_plate", "PLATE_VS_TRUCK", "mismatch"
            )
        if check == "ticket_arithmetic":
            return _step("receipt_arithmetic", spj=spj), _rule(
                "receipt_arithmetic", "TICKET_ARITHMETIC_TOLERANCE_KG", TICKET_ARITHMETIC_TOLERANCE_KG, "kg"
            )
        if check == "net_vs_capacity":
            return _step("receipt_capacity", spj=spj), _rule(
                "receipt_capacity", "TRUCK_CAPACITY_TONS", TRUCK_CAPACITY_TONS, "t"
            )
        if check is None:
            return _step("review", truck=truck), _rule("review", "RECEIPT_CHECK", "review")
        return _step("receipt_ocr", spj=spj), _rule(
            "receipt_ocr",
            "OCR_TOLERANCE_SHARE",
            round(OCR_TOLERANCE_SHARE * 100, 1),
            "%",
            min_kg=OCR_TOLERANCE_MIN_KG,
        )
    if kind == "escalation":
        # Lane ea catalog: the supervisor's step, and that an operator raised it.
        return (
            {"key": "ea_step_escalation", "params": {"by": facts.get("raised_by") or ""}},
            {"id": "ESCALATION", "value": None, "unit": None, "key": "ea_rule_escalation", "params": {}},
        )
    return _step("review", truck=truck), _rule("review", kind, None)


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
        _deviations(_active_spjs())
        + exceptions
        + _damage(covered, follow_ups)
        + _gate_peaks(day, follow_ups)
        + _receipt_checks(day, follow_ups)
        + duty
        + _escalations()
    )
    # An escalation closes only through its own store (a supervisor's Mark handled), never
    # through a generic alert follow-up.
    items = [
        i
        for i in items
        if i["kind"] == "escalation" or (follow_ups.get(i["id"]) or {}).get("status") != "RESOLVED"
    ]
    _suggest_backups(items, day)
    for item in items:
        item["next_step"], item["rule"] = _guidance(item)
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
            "receipts": {
                "classification": "FIELD",
                "window_days": RECEIPT_CHECK_DAYS,
                "method": "rule checks",
            },
        },
    }
