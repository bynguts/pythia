"""Driver-safety guard: duty hours and gate dwell (requirements R5, R6).

Two DKI garbage-truck drivers died in Dec 2025 after 8-13 h queues at
Bantargebang. DLH promises a gate wait of 3 h or less, and DPRD demanded caps
on working hours. This module turns those promises into per-truck states:

- **Duty**: minutes since the truck's first pre-trip check or SPJ activation of
  the local (WIB) day. ``warn`` from ``DUTY_WARN_MIN``, ``blocked`` from
  ``DUTY_BLOCK_MIN``; while blocked a new SPJ is refused unless a holder of
  ``spj:override`` recorded a reasoned override for that truck today.
- **Gate wait**: from the SPJ ``gate_arrival`` event to the weighbridge receipt
  (or to now while the truck still waits). ``alert`` from ``GATE_ALERT_MIN``;
  each alert is stored once and, when a supervisor group is configured, sent
  once to that WhatsApp group.

Classification is never mixed: when this server holds app events for the local
day, every number comes from them (``OBSERVED_APP_EVENTS``). Only when it holds
none (a fresh demo) does the overview fall back to a seeded scenario over the
simulated fleet, labelled ``SIMULATED``. Blocking and WhatsApp alerts act on
observed events only.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from app.core.env import getenv
from app.core.errors import CodedError, coded_detail
from app.core.storage import RecordStore
from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN, GATE_ALERT_MIN
from app.field.pretrip import PRETRIP_STORE
from app.field.spj import SPJ_STORE, Spj
from app.integrations.whatsapp import OpenWAClient, wa_text

logger = logging.getLogger(__name__)

# Asia/Jakarta has had no daylight saving since 1964, so a fixed offset is exact
# and needs no tz database on Windows hosts.
WIB = timezone(timedelta(hours=7), "WIB")

OBSERVED = "OBSERVED_APP_EVENTS"
SIMULATED = "SIMULATED"
LABELS = {
    OBSERVED: "Observed app events on this server: pre-trip checks, work order activations, "
    "gate arrivals and weighbridge receipts (local WIB day).",
    SIMULATED: "SIMULATED: seeded demo scenario over the simulated fleet; no driver's "
    "duty or gate wait was observed.",
}
# The simulated scenario's gate waits are example values per truck that exercise the
# gate alert; they are not drawn from the weighbridge queue model (/api/tpa/queue-metric).
SIM_GATE_WAIT_MIN = 15
SIM_GATE_WAIT_MAX = 240
GATE_WAIT_BASIS = {
    OBSERVED: "observed per truck: gate arrival event to weighbridge receipt (or now while waiting)",
    SIMULATED: (
        f"example per simulated truck: a seeded gate dwell of {SIM_GATE_WAIT_MIN}-{SIM_GATE_WAIT_MAX} "
        "min at the top of the hour, growing while it waits, to exercise the gate alert; not drawn "
        "from the weighbridge queue model (/api/tpa/queue-metric)"
    ),
}
OVERRIDE_REASON_MIN = 10
SEED_CREATOR = "seed"  # the demo seed SPJ is not an observed app event
FUTURE_SKEW = timedelta(minutes=5)

OVERRIDES = RecordStore("pythia_safety_overrides")
ALERTS = RecordStore("pythia_safety_alerts")


def _now() -> datetime:
    return datetime.now(UTC)


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _minutes(start: datetime, end: datetime) -> int:
    return max(0, int((end - start).total_seconds() // 60))


def local_day_window(now: datetime) -> tuple[datetime, datetime]:
    """Start (inclusive) and end (exclusive) of the WIB calendar day holding ``now``."""
    local = now.astimezone(WIB)
    start = datetime(local.year, local.month, local.day, tzinfo=WIB)
    return start, start + timedelta(days=1)


def shift_window_payload(now: datetime) -> dict[str, str]:
    start, end = local_day_window(now)
    return {
        "date": start.date().isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "timezone": "Asia/Jakarta (WIB, UTC+7)",
        "basis": "local operating day; a work order still active from the previous day carries its start over",
    }


def duty_state(minutes: int) -> str:
    if minutes >= DUTY_BLOCK_MIN:
        return "blocked"
    if minutes >= DUTY_WARN_MIN:
        return "warn"
    return "ok"


def gate_state(wait_minutes: int | None) -> str | None:
    if wait_minutes is None:
        return None
    return "alert" if wait_minutes >= GATE_ALERT_MIN else "ok"


def percentile(values: list[float], q: float) -> float | None:
    """Linear-interpolated percentile (q in 0..1); None for no samples."""
    if not values:
        return None
    ordered = sorted(values)
    position = q * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (position - low), 1)


# -- observed app events ------------------------------------------------------


def _gate_arrival(spj: Spj) -> datetime | None:
    for entry in SPJ_STORE.audit_log(spj.spj_id):
        if entry["action"] == "gate_arrival":
            return _parse(entry["payload"].get("arrived_at")) or _parse(entry["created_at"])
    return None


def observed_activity(now: datetime, truck_code: str | None = None) -> dict[str, dict[str, Any]]:
    """Per truck: the first duty event of the local day and the latest gate visit.

    Built only from records on this server. The demo seed SPJ is excluded: it is
    created at start-up, not by anyone at work.
    """
    start, end = local_day_window(now)
    trucks: dict[str, dict[str, Any]] = {}

    def entry(code: str) -> dict[str, Any]:
        return trucks.setdefault(code, {"shift_started_at": None, "shift_source": None, "gate": None})

    def note_start(code: str, at: datetime, source: str) -> None:
        record = entry(code)
        if record["shift_started_at"] is None or at < record["shift_started_at"]:
            record["shift_started_at"], record["shift_source"] = at, source

    for raw in PRETRIP_STORE._records.all():
        code = raw.get("truck_code")
        at = _parse(raw.get("created_at"))
        if code and at and start <= at < end and at <= now and truck_code in (None, code):
            note_start(code, at, "pretrip")

    for spj in SPJ_STORE.list():
        if spj.created_by == SEED_CREATOR or truck_code not in (None, spj.truck_code):
            continue
        activated = _parse(spj.activated_at)
        if activated is None or activated > now:
            continue
        carried_over = spj.status == "aktif" and activated < start
        if not (start <= activated < end or carried_over):
            continue
        note_start(spj.truck_code, activated, "spj_activation")
        arrived = _gate_arrival(spj)
        if arrived is None:
            continue
        record = entry(spj.truck_code)
        if record["gate"] is None or arrived > record["gate"]["arrived_at"]:
            record["gate"] = {
                "spj_id": spj.spj_id,
                "destination": spj.destination,
                "arrived_at": arrived,
                "exited_at": _parse((spj.receipt or {}).get("recorded_at")),
            }
    return trucks


# -- simulated fallback --------------------------------------------------------


def simulated_fleet_codes() -> list[str]:
    """The simulated fleet's own trucks, so Safety counts the same units as Fleet.

    ASSIGNED_PATHS also holds a corridor (T-136) that no truck drives; listing it
    made Safety say 60 trucks against Fleet's 59 (teardown v4 F4).
    """
    from app.fleet.data import get_dynamic_trucks

    return [truck["truck_code"] for truck in get_dynamic_trucks()]


def simulated_activity(now: datetime, codes: list[str]) -> dict[str, dict[str, Any]]:
    """Seeded per truck and local day, anchored to the current hour.

    A scenario for an empty demo server, not a model of any real shift: duty
    60-780 min, about a third of the fleet at the gate with 15-240 min waits.
    """
    hour = now.astimezone(WIB).replace(minute=0, second=0, microsecond=0)
    day = hour.date().isoformat()
    trucks: dict[str, dict[str, Any]] = {}
    for code in codes:
        seed = int(hashlib.sha256(f"{code}|{day}".encode()).hexdigest()[:16], 16)
        duty_offset = 60 + seed % 721
        shift = hour - timedelta(minutes=duty_offset)
        gate = None
        if (seed >> 12) % 100 < 35:
            spread = SIM_GATE_WAIT_MAX - SIM_GATE_WAIT_MIN + 1
            wait_offset = min(duty_offset, SIM_GATE_WAIT_MIN + (seed >> 20) % spread)
            gate = {
                "spj_id": None,
                "destination": "TPST Bantargebang",
                "arrived_at": hour - timedelta(minutes=wait_offset),
                "exited_at": None,
            }
        trucks[code] = {"shift_started_at": shift, "shift_source": "simulated", "gate": gate}
    return trucks


# -- overrides -----------------------------------------------------------------


def overrides_today(now: datetime) -> dict[str, dict[str, Any]]:
    """Latest override per truck for the local day, as ``{by, reason, at}``."""
    day = local_day_window(now)[0].date().isoformat()
    latest: dict[str, dict[str, Any]] = {}
    for raw in OVERRIDES.all():
        if raw.get("local_date") == day:
            latest[raw["truck_code"]] = {"by": raw["by"], "reason": raw["reason"], "at": raw["at"]}
    return latest


def grant_override(
    truck_code: str, reason: str, actor: str, classification: str, now: datetime | None = None
) -> dict[str, Any]:
    """Store a reasoned duty-limit override for one truck for the rest of the local day."""
    now = now or _now()
    truck_code = (truck_code or "").strip()
    reason = (reason or "").strip()
    if not truck_code:
        raise ValueError("truck_code is required")
    if len(reason) < OVERRIDE_REASON_MIN:
        raise CodedError(
            "override_reason_short",
            f"An override needs a reason of at least {OVERRIDE_REASON_MIN} characters.",
            n=OVERRIDE_REASON_MIN,
        )
    record = {
        "override_id": uuid4().hex[:12],
        "truck_code": truck_code,
        "local_date": local_day_window(now)[0].date().isoformat(),
        "by": actor,
        "reason": reason,
        "at": now.isoformat(),
        "classification_at_grant": classification,
    }
    OVERRIDES.write(record["override_id"], record)
    return record


# -- per-truck state -------------------------------------------------------------


def truck_payload(
    code: str,
    activity: dict[str, Any] | None,
    override: dict[str, Any] | None,
    classification: str,
    now: datetime,
) -> dict[str, Any]:
    activity = activity or {}
    started = activity.get("shift_started_at")
    duty = _minutes(started, now) if started else 0
    gate = activity.get("gate")
    wait = None
    if gate:
        wait = _minutes(gate["arrived_at"], gate["exited_at"] or now)
    return {
        "truck_code": code,
        "shift_started_at": _iso(started),
        "shift_source": activity.get("shift_source"),
        "duty_minutes": duty,
        "duty_state": duty_state(duty),
        "warn_at_minutes": DUTY_WARN_MIN,
        "block_at_minutes": DUTY_BLOCK_MIN,
        "override": override,
        "gate_wait_minutes": wait,
        "gate_state": gate_state(wait),
        "gate_alert_at_minutes": GATE_ALERT_MIN,
        "gate_status": None if not gate else ("exited" if gate["exited_at"] else "waiting"),
        "gate_arrived_at": _iso(gate["arrived_at"]) if gate else None,
        "gate_exited_at": _iso(gate["exited_at"]) if gate else None,
        "gate_destination": gate["destination"] if gate else None,
        "spj_id": gate["spj_id"] if gate else None,
        "risk_score": round(max(duty / DUTY_BLOCK_MIN, (wait or 0) / GATE_ALERT_MIN), 3),
        "classification": classification,
        "label": LABELS[classification],
    }


def _risk_key(truck: dict[str, Any]) -> tuple:
    unresolved_block = truck["duty_state"] == "blocked" and truck["override"] is None
    return (not unresolved_block, truck["gate_state"] != "alert", -truck["risk_score"], truck["truck_code"])


def driver_state(truck_code: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    observed = observed_activity(now)
    override = overrides_today(now).get(truck_code)
    if observed:
        return truck_payload(truck_code, observed.get(truck_code), override, OBSERVED, now)
    # One driver's own duty and gate are never a seeded example: the 12-hour hold and the
    # "queue over 3 hours, supervisor notified" notice need this driver's observed events.
    # The fleet scenario stays on the console's overview, where it is labelled.
    empty = {"shift_started_at": None, "shift_source": None, "gate": None}
    return truck_payload(truck_code, empty, override, SIMULATED, now)


def overview(now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    observed = observed_activity(now)
    if observed:
        classification, activity = OBSERVED, observed
    else:
        classification, activity = SIMULATED, simulated_activity(now, simulated_fleet_codes())
    overrides = overrides_today(now)
    trucks = sorted(
        (
            truck_payload(code, act, overrides.get(code), classification, now)
            for code, act in activity.items()
        ),
        key=_risk_key,
    )
    waits = [t["gate_wait_minutes"] for t in trucks if t["gate_wait_minutes"] is not None]
    return {
        "trucks": trucks,
        "gate_wait_p50": percentile(waits, 0.5),
        "gate_wait_p90": percentile(waits, 0.9),
        "gate_wait_samples": len(waits),
        "gate_wait_basis": GATE_WAIT_BASIS[classification],
        "counts": {
            "trucks": len(trucks),
            "duty_warn": sum(1 for t in trucks if t["duty_state"] == "warn"),
            "duty_blocked": sum(1 for t in trucks if t["duty_state"] == "blocked"),
            "gate_alert": sum(1 for t in trucks if t["gate_state"] == "alert"),
        },
        "warn_at_minutes": DUTY_WARN_MIN,
        "block_at_minutes": DUTY_BLOCK_MIN,
        "gate_alert_at_minutes": GATE_ALERT_MIN,
        "shift_window": shift_window_payload(now),
        "classification": classification,
        "label": LABELS[classification],
    }


# -- SPJ activation guard ----------------------------------------------------------


def duty_check(truck_code: str, now: datetime | None = None) -> dict[str, Any]:
    """Whether a new SPJ may start for this truck, from observed events only.

    ``blocked`` with an Indonesian ``reason`` when duty is at or past the block
    limit and no override exists today; a simulated scenario never blocks work.
    """
    now = now or _now()
    activity = observed_activity(now, truck_code).get(truck_code) or {}
    started = activity.get("shift_started_at")
    duty = _minutes(started, now) if started else 0
    override = overrides_today(now).get(truck_code) if duty >= DUTY_BLOCK_MIN else None
    blocked = duty >= DUTY_BLOCK_MIN and override is None
    reason = None
    if blocked:
        reason = (
            f"Truk {truck_code} sudah bertugas {duty // 60} jam {duty % 60} menit hari ini "
            f"(batas {DUTY_BLOCK_MIN // 60} jam). SPJ baru diblokir demi keselamatan sopir; "
            "pengawas dapat memberi override dengan alasan."
        )
    return {"blocked": blocked, "reason": reason, "duty_minutes": duty, "override": override}


def duty_detail(truck_code: str, check: dict[str, Any]) -> dict[str, Any]:
    """The coded 409 detail of a duty block (`check` from duty_check), for the UI to say in its language."""
    duty = check["duty_minutes"]
    return coded_detail(
        "duty_blocked",
        f"Truck {truck_code} has been on duty {duty // 60} h {duty % 60} min today (limit "
        f"{DUTY_BLOCK_MIN // 60} h). New work orders are blocked for the driver's safety; a supervisor "
        "can grant an override with a reason.",
        truck=truck_code,
        h=duty // 60,
        m=duty % 60,
        limit=DUTY_BLOCK_MIN // 60,
    )


# -- gate arrival and alerts -------------------------------------------------------


def record_gate_arrival(
    spj_id: str, actor: str, arrived_at: str | None = None, now: datetime | None = None
) -> dict[str, Any]:
    """Record the gate arrival for an SPJ; a device time is accepted for offline replays."""
    now = now or _now()
    spj = SPJ_STORE.get(spj_id)
    if spj is None:
        raise LookupError(f"Work order {spj_id} not found")
    at = now
    if arrived_at:
        at = _parse(arrived_at)
        if at is None:
            raise ValueError("arrived_at must be an ISO-8601 timestamp")
        if at > now + FUTURE_SKEW:
            raise ValueError("arrived_at is in the future")
        activated = _parse(spj.activated_at)
        if activated is not None and at < activated:
            raise ValueError("arrived_at is before the work order was activated")
    SPJ_STORE.record_gate_arrival(spj_id, actor, at.isoformat())
    return driver_state(spj.truck_code, now)


def _dispatch(fn: Callable[..., Any], *args: Any) -> None:
    """Run a slow side effect (the WhatsApp send) off the request thread."""
    threading.Thread(target=fn, args=args, daemon=True).start()


def gate_alert_message(alert: dict[str, Any], lang: str | None = None) -> str:
    """The group's gate-wait alert in the WhatsApp message language (or ``lang``)."""
    wait = int(alert["wait_minutes"])
    arrived = _parse(alert["gate_arrived_at"])
    return wa_text(
        "gate_safety",
        lang,
        truck=alert["truck_code"],
        h=wait // 60,
        m=wait % 60,
        dest=alert.get("destination") or "TPA",
        since=arrived.astimezone(WIB).strftime("%H:%M") if arrived else "?",
        limit=GATE_ALERT_MIN // 60,
    )


def send_gate_alert(alert: dict[str, Any]) -> None:
    """Send one alert to the supervisor group and store the honest delivery result.

    Only the configured group receives it: never a driver's personal number.
    """
    group = getenv("WA_DEFAULT_GROUP_ID")
    try:
        result = OpenWAClient.from_env().send_text(group, gate_alert_message(alert))
        status = "sent" if result.get("sent") else "failed"
        message = str(result.get("message") or "")
    except Exception as error:  # noqa: BLE001 - a gateway fault must not lose the alert
        status, message = "failed", str(error)
    with ALERTS.transaction() as connection:
        stored = ALERTS.get(alert["alert_id"], connection) or dict(alert)
        stored["whatsapp"] = {"status": status, "message": message, "at": _now().isoformat()}
        ALERTS.write(alert["alert_id"], stored, connection)


def sweep_gate_alerts(trucks: list[dict[str, Any]], now: datetime | None = None) -> list[dict[str, Any]]:
    """Create one alert per truck per gate visit past the limit; returns the new ones.

    Simulated trucks never raise a stored alert or a WhatsApp message.
    """
    now = now or _now()
    created: list[dict[str, Any]] = []
    for truck in trucks:
        if truck["classification"] != OBSERVED or truck["gate_state"] != "alert":
            continue
        key = f"{truck['truck_code']}|{truck['gate_arrived_at']}"
        alert_id = "gate-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        configured = bool(getenv("WA_DEFAULT_GROUP_ID"))
        alert = {
            "alert_id": alert_id,
            "type": "gate_dwell",
            "truck_code": truck["truck_code"],
            "spj_id": truck["spj_id"],
            "destination": truck["gate_destination"],
            "gate_arrived_at": truck["gate_arrived_at"],
            "wait_minutes": truck["gate_wait_minutes"],
            "threshold_minutes": GATE_ALERT_MIN,
            "local_date": local_day_window(now)[0].date().isoformat(),
            "created_at": now.isoformat(),
            "classification": OBSERVED,
            "whatsapp": {"status": "queued" if configured else "not_configured", "message": "", "at": None},
        }
        with ALERTS.transaction() as connection:
            if ALERTS.get(alert_id, connection) is not None:
                continue
            ALERTS.write(alert_id, alert, connection)
        created.append(alert)
        if configured:
            _dispatch(send_gate_alert, alert)
    return created


def gate_alert_tick(now: datetime | None = None) -> list[dict[str, Any]]:
    """Sweep every observed truck once, with no panel open; returns the new alerts.

    Only observed app events are read, so an empty server does no simulated work.
    """
    now = now or _now()
    observed = observed_activity(now)
    overrides = overrides_today(now) if observed else {}
    trucks = [
        truck_payload(code, activity, overrides.get(code), OBSERVED, now)
        for code, activity in observed.items()
    ]
    return sweep_gate_alerts(trucks, now)


def alerts_today(now: datetime | None = None) -> list[dict[str, Any]]:
    day = local_day_window(now or _now())[0].date().isoformat()
    return [raw for raw in ALERTS.all() if raw.get("local_date") == day]
