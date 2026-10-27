"""Driver safety: duty-hour guard, gate-dwell alerts and supervisor overrides (R5, R6).

Gate alerts are swept on every safety read and, independently of any open
panel, by a background timer started from the app lifespan
(``PYTHIA_SAFETY_GATE_TIMER``, on by default).
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import ensure_truck_access, require_any_principal, require_permission
from app.api.state import history_store
from app.core.auth import has_permission
from app.core.env import getenv
from app.core.errors import error_detail
from app.core.storage import StorageError
from app.field import safety

router = APIRouter()
logger = logging.getLogger(__name__)

GATE_TIMER_SECONDS = 60


class SafetyOverrideBody(BaseModel):
    truck_code: str = Field(min_length=1, max_length=32)
    reason: str = Field(default="", max_length=500)


class GateArrivalBody(BaseModel):
    spj_id: str = Field(min_length=1, max_length=64)
    # Device time of the arrival, so an offline replay does not shorten the wait.
    arrived_at: str | None = Field(default=None, max_length=64)


def _record_alerts(alerts: list[dict[str, Any]]) -> None:
    for alert in alerts:
        history_store.record_event(
            "safety_gate_alert",
            {
                "alert_id": alert["alert_id"],
                "truck_code": alert["truck_code"],
                "spj_id": alert["spj_id"],
                "wait_minutes": alert["wait_minutes"],
                "whatsapp": alert["whatsapp"]["status"],
            },
        )


def _storage_503(exc: StorageError) -> HTTPException:
    logger.error("safety persistence failure: %s", exc)
    return HTTPException(status_code=503, detail="Safety storage is unavailable; the change was not saved.")


def enforce_duty_limit(truck_code: str, action: str) -> None:
    """409 with a coded duty-block refusal when observed duty is past the block limit.

    Called before an SPJ is created or activated. A start allowed by an
    override is written to the history log with the override's actor.
    """
    check = safety.duty_check(truck_code)
    if check["blocked"]:
        history_store.record_event(
            "safety_duty_block",
            {"truck_code": truck_code, "action": action, "duty_minutes": check["duty_minutes"]},
        )
        raise HTTPException(status_code=409, detail=safety.duty_detail(truck_code, check))
    if check["override"] is not None:
        history_store.record_event(
            "safety_override_used",
            {
                "truck_code": truck_code,
                "action": action,
                "duty_minutes": check["duty_minutes"],
                "override_by": check["override"]["by"],
                "override_reason": check["override"]["reason"],
            },
        )


def gate_alert_tick() -> list[dict[str, Any]]:
    """One timer pass: store, send and log the gate alerts that are due; returns the new ones."""
    alerts = safety.gate_alert_tick()
    _record_alerts(alerts)
    return alerts


def start_gate_alert_timer(interval_seconds: float = GATE_TIMER_SECONDS) -> threading.Event | None:
    """Sweep gate alerts every ``interval_seconds`` so they fire with no panel open.

    Returns the stop event (set it to end the thread), or None when
    ``PYTHIA_SAFETY_GATE_TIMER`` is off.
    """
    if (getenv("SAFETY_GATE_TIMER", "on") or "").strip().lower() != "on":
        return None
    stop = threading.Event()

    def _loop() -> None:
        while not stop.wait(interval_seconds):
            try:
                gate_alert_tick()
            except Exception:  # noqa: BLE001 - one failed pass must not end the timer
                logger.exception("gate alert timer pass failed")

    threading.Thread(target=_loop, daemon=True, name="pythia-safety-gate-timer").start()
    return stop


@router.get("/api/safety/driver/{truck_code}")
def safety_driver(
    truck_code: str,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dashboard:read")),
) -> dict[str, Any]:
    ensure_truck_access(principal, truck_code)
    state = safety.driver_state(truck_code)
    _record_alerts(safety.sweep_gate_alerts([state]))
    return state


@router.get("/api/safety/overview")
def safety_overview(_role: str = Depends(require_permission("dashboard:read"))) -> dict[str, Any]:
    payload = safety.overview()
    _record_alerts(safety.sweep_gate_alerts(payload["trucks"]))
    payload["alerts"] = safety.alerts_today()
    payload["viewer"] = {"role": _role, "can_override": has_permission(_role, "spj:override")}
    return payload


@router.post("/api/safety/override", status_code=201)
def safety_override(
    body: SafetyOverrideBody, principal: dict = Depends(require_any_principal("spj:override"))
) -> dict[str, Any]:
    before = safety.driver_state(body.truck_code.strip())
    try:
        record = safety.grant_override(
            body.truck_code, body.reason, principal["username"], before["classification"]
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=error_detail(exc)) from exc
    except StorageError as exc:
        raise _storage_503(exc) from exc
    history_store.record_event(
        "safety_duty_override",
        {
            "override_id": record["override_id"],
            "truck_code": record["truck_code"],
            "actor": record["by"],
            "reason": record["reason"],
            "duty_minutes": before["duty_minutes"],
            "duty_state": before["duty_state"],
            "classification": before["classification"],
        },
    )
    return safety.driver_state(record["truck_code"])


@router.post("/api/safety/gate-arrival", status_code=201)
def safety_gate_arrival(
    body: GateArrivalBody,
    principal: dict = Depends(require_any_principal("dispatch:confirm", "dispatch:create")),
) -> dict[str, Any]:
    """The truck reached the disposal gate; the wait runs until the weighbridge receipt."""
    spj = safety.SPJ_STORE.get(body.spj_id)
    if spj is not None:
        ensure_truck_access(principal, spj.truck_code)
    try:
        state = safety.record_gate_arrival(body.spj_id, principal["username"], body.arrived_at)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except StorageError as exc:
        raise _storage_503(exc) from exc
    _record_alerts(safety.sweep_gate_alerts([state]))
    return state
