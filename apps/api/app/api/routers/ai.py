"""Background AI engine startup and its read-only /api/ai/* surface."""

from __future__ import annotations

import logging
import threading
from typing import Any

from fastapi import APIRouter

from app.ai.actions.auto_state import EVENT_FEED
from app.ai.engine_loop import maybe_start_engine
from app.api.state import (
    _AI_ENGINE_STATE,
    _ai_carbon,
    _ai_deviation,
    _ai_forecast,
    _ai_queue,
    _ai_rerouter,
    _ai_stop,
)

router = APIRouter()


def _start_ai_engine() -> None:
    engine = maybe_start_engine()
    if engine is None:
        _AI_ENGINE_STATE["running"] = False
        return
    _AI_ENGINE_STATE["running"] = True
    engine.register("auto_reroute", _ai_rerouter.run)
    engine.register("tpa_queue", _ai_queue.update)
    engine.register("deviation_replay", _ai_deviation.check)
    engine.register("stop_pattern", lambda source: _ai_stop.scan())
    engine.register("carbon", _ai_carbon.update)

    def _forecast_loop() -> None:
        while True:
            try:
                _ai_forecast.refresh()
            except Exception:  # noqa: BLE001
                logging.getLogger(__name__).exception("event forecast refresh failed")
            threading.Event().wait(3600)

    threading.Thread(target=_forecast_loop, daemon=True, name="pythia-ai-forecast").start()


@router.get("/api/ai/events")
def ai_events() -> dict[str, Any]:
    events = EVENT_FEED.snapshot()
    return {"events": events, "count": len(events)}


@router.post("/api/ai/events/{index}/ack")
def ai_event_ack(index: int) -> dict[str, Any]:
    return {"ok": EVENT_FEED.acknowledge(index)}


@router.get("/api/ai/tpa-queue-live")
def ai_tpa_queue_live() -> dict[str, Any]:
    return _ai_queue.latest()


@router.get("/api/ai/unlicensed-flags")
def ai_unlicensed_flags() -> dict[str, Any]:
    flags = _ai_stop.flags()
    return {"flags": flags, "count": len(flags)}


@router.get("/api/ai/carbon-live")
def ai_carbon_live() -> dict[str, Any]:
    return _ai_carbon.latest()


@router.get("/api/ai/event-forecast")
def ai_event_forecast() -> dict[str, Any]:
    outlook = _ai_forecast.latest()
    return {"outlook": outlook, "count": len(outlook)}
