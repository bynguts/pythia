"""Service health, login and data provenance."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException

from app.api.schemas import LoginRequest
from app.api.state import _AI_ENGINE_STATE, history_store
from app.core.auth import ROLES, authenticate, role_for_token, token_for
from app.core.env import getenv
from app.core.paths import MODELS_DIR, REAL_DIR
from app.forecast.engine import hybrid_models_loadable
from app.forecast.real_data import build_provenance_records, data_provenance, load_city_timbulan

router = APIRouter()


@router.get("/api/health")
def health() -> dict[str, Any]:
    # #36: report the configured vs running AI engine state so an
    # accidentally-empty /api/ai/* is visible from health, not silent.
    return {
        "status": "healthy",
        "service": "pythia-backend",
        "version": "2.5.0",
        "ai_engine_configured": getenv("AI_ENGINE", "off").lower() == "on",
        "ai_engine_running": _AI_ENGINE_STATE["running"],
    }


@router.get("/api/health/detailed")
def health_detailed() -> dict[str, Any]:
    """Dependency-aware health: database, models, source files, weather, OSRM."""
    models_dir = MODELS_DIR
    prophet_n = len(list(models_dir.glob("prophet_*.joblib"))) if models_dir.exists() else 0
    xgb_n = len(list(models_dir.glob("xgboost_*.joblib"))) if models_dir.exists() else 0
    real_dir = REAL_DIR
    source_files = (
        len(list(real_dir.glob("*.csv"))) + len(list(real_dir.glob("*.geojson"))) if real_dir.exists() else 0
    )
    models_loadable = hybrid_models_loadable()
    db_ok = True
    try:
        history_store.list_events(limit=1)
    except Exception:
        db_ok = False
    components = {
        "database": {"status": "up" if db_ok else "degraded"},
        "models": {
            "available": prophet_n == 42 and xgb_n == 42 and models_loadable,
            "loadable": models_loadable,
            "prophet": prophet_n,
            "xgboost": xgb_n,
        },
        "source_files": {"count": source_files, "status": "up" if source_files >= 8 else "degraded"},
        "weather": {"status": "external", "note": "Open-Meteo fetched on demand with fallback"},
        "osrm": {"status": "external", "note": "public OSRM with fallback route"},
    }
    degraded = (not db_ok) or prophet_n != 42 or xgb_n != 42 or not models_loadable or source_files < 8
    return {"status": "degraded" if degraded else "healthy", "components": components}


@router.post("/api/auth/login")
def auth_login(payload: LoginRequest) -> dict[str, Any]:
    """Backend role-aware login; replaces the frontend-only admin gate."""
    principal = authenticate(payload.username, payload.password)
    if principal is None:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    return {
        "username": principal["username"],
        "role": principal["role"],
        "permissions": sorted(ROLES[principal["role"]]),
        "token": token_for(principal),
    }


@router.get("/api/auth/session")
def auth_session(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """gsc P0-2: lets the public driver/field surfaces check that a stored token
    is still valid (tokens live in memory and are lost on a backend restart)."""
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    role = role_for_token(token) if token else None
    if role is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    return {"role": role, "permissions": sorted(ROLES[role])}


@router.get("/api/data/provenance")
def data_provenance_endpoint() -> dict[str, Any]:
    """Transparency: which real government datasets are currently loaded."""
    return {
        "provenance": data_provenance(),
        "records": build_provenance_records(),
        "city_timbulan": load_city_timbulan(),
    }
