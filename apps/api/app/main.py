"""Pythia FastAPI application: settings, CORS, startup lifespan and router wiring.

Endpoints live in ``app.api.routers``; shared singletons and caches in
``app.api.state``; the startup cache warm-up in ``app.api.warmup``.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.env import getenv

# Load .env before anything reads settings: app.core.paths and the domain
# modules read PYTHIA_* values at import time.
load_dotenv()

key = os.getenv("OPENAI_API_KEY", "")
logging.getLogger(__name__).info(
    "startup cwd=%s openai_configured=%s base_url=%s",
    os.getcwd(),
    bool(key),
    os.getenv("OPENAI_BASE_URL"),
)

_ALLOWED_ORIGINS = getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5175,http://127.0.0.1:5175,http://localhost:5173,http://127.0.0.1:5173",
).split(",")


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    from app.api.routers.ai import _start_ai_engine
    from app.api.routers.safety import start_gate_alert_timer
    from app.api.warmup import _warm_route_cache
    from app.integrations import wa_gateway_process
    from app.integrations.whatsapp import OpenWAClient

    _warm_route_cache()
    _start_ai_engine()
    gate_timer = start_gate_alert_timer()
    if getenv("WA_AUTOSTART", "off") == "on":
        try:
            wa_gateway_process.start(OpenWAClient.from_env().base_url)
        except (wa_gateway_process.GatewayExternal, wa_gateway_process.GatewayUnavailable) as error:
            logging.getLogger(__name__).warning("WhatsApp gateway autostart skipped: %s", error)
    yield
    if gate_timer is not None:
        gate_timer.set()
    wa_gateway_process.stop()


def create_app() -> FastAPI:
    # Routers (and every domain module behind them) are imported only after
    # load_dotenv(), so settings read at import time see the .env values.
    from app.api.routers import (
        ai,
        assistant,
        dispatch,
        driver,
        driver_trip,
        field_facts,
        fleet,
        forecast,
        gate_slots,
        health,
        messages,
        operations,
        ops,
        readiness,
        recap,
        safety,
        scentinel,
        spj,
        twin,
        whatsapp,
        xr_session,
    )

    application = FastAPI(title="Pythia FastAPI Backend", version="2.5.0", lifespan=_lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in _ALLOWED_ORIGINS if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for module in (
        health,
        forecast,
        fleet,
        assistant,
        dispatch,
        whatsapp,
        operations,
        twin,
        ai,
        spj,
        scentinel,
        driver,
        xr_session,
        safety,
        readiness,
        gate_slots,
        recap,
        ops,
        field_facts,
        driver_trip,
        messages,
    ):
        application.include_router(module.router)
    return application


app = create_app()
