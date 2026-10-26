"""Field facts CRUD: the planning loop's only manual input (wave 13)."""

from __future__ import annotations

import logging
from datetime import date as date_type
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.deps import require_any_principal, require_permission
from app.api.state import history_store
from app.core.env import local_today
from app.core.storage import StorageError
from app.field.field_facts import SOURCES, add_fact, delete_fact, list_facts

router = APIRouter()
logger = logging.getLogger(__name__)


class FieldFactBody(BaseModel):
    date: date_type
    text: str = Field(min_length=1, max_length=280)
    source: str = Field(default="other", pattern="^(" + "|".join(SOURCES) + ")$")
    # {kind: "truck_unavailable", truck_code} | {kind: "gate_lane_closed", from, to} | null
    effect: dict[str, Any] | None = None


def _storage_503(exc: StorageError) -> HTTPException:
    logger.error("field facts persistence failure: %s", exc)
    return HTTPException(status_code=503, detail="Field-fact storage is unavailable; nothing was saved.")


@router.get("/api/field-facts")
def get_field_facts(
    day: date_type | None = Query(None, alias="date", description="Operating day; defaults to today (WIB)"),
    _role: str = Depends(require_permission("dashboard:read")),
) -> dict[str, Any]:
    """The live facts of one day, oldest first, each saying whether the plan uses it."""
    iso = (day or local_today()).isoformat()
    facts = list_facts(iso)
    return {"date": iso, "facts": facts, "count": len(facts), "classification": "FIELD"}


@router.post("/api/field-facts", status_code=201)
def post_field_fact(
    body: FieldFactBody, principal: dict = Depends(require_any_principal("operations:plan"))
) -> dict[str, Any]:
    try:
        fact = add_fact(body.date.isoformat(), body.text, body.source, body.effect, principal["username"])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except StorageError as exc:
        raise _storage_503(exc) from exc
    history_store.record_event(
        "field_fact_added",
        {"id": fact["id"], "date": fact["date"], "source": fact["source"], "effect": fact["effect"]},
    )
    return fact


@router.delete("/api/field-facts/{fact_id}")
def remove_field_fact(
    fact_id: str, principal: dict = Depends(require_any_principal("operations:plan"))
) -> dict[str, Any]:
    try:
        fact = delete_fact(fact_id, principal["username"])
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Field fact {fact_id} not found.") from None
    except StorageError as exc:
        raise _storage_503(exc) from exc
    history_store.record_event("field_fact_deleted", {"id": fact_id, "date": fact["date"]})
    return fact
