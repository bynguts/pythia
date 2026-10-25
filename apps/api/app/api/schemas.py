"""Pydantic request bodies for the HTTP API."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.field.spj import MAX_STOP_WEIGHT_KG as MAX_RECEIPT_WEIGHT_KG
from app.integrations.whatsapp import default_chat_id


class AssistantRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[dict] = Field(default_factory=list, max_length=8)
    file_data: str | None = Field(default=None, max_length=30_000_000)
    file_type: str | None = Field(default=None, pattern="^(image|pdf)$")
    # #76: UI locale requested explicitly so the answer language follows the
    # user's selected mode for the whole conversation.
    language: str = Field(default="id", pattern="^(id|en)$")


class WhatsAppAlertRequest(BaseModel):
    truck_code: str = Field(min_length=1, max_length=20)
    issue: str = Field(min_length=1, max_length=500)
    recommendation: str = Field(min_length=1, max_length=500)
    chat_id: str = Field(default_factory=default_chat_id)  # direct chat (PYTHIA_WA_DEFAULT_CHAT_ID)


class DispatchRequest(BaseModel):
    truck_code: str = Field(min_length=1, max_length=20)
    instruction: str = Field(min_length=1, max_length=500)
    manager_id: str = Field(default="manager_central", min_length=1, max_length=50)


class DispatchConfirmRequest(BaseModel):
    # #24: documented field-status enum. PENDING is the initial DB state,
    # not a confirmable outcome; confirmations are READY (acknowledged and
    # ready to execute), ISSUE (field problem reported), SIAP (legacy
    # Indonesian READY used by existing clients), and DONE (completed).
    status: Literal["READY", "ISSUE", "SIAP", "DONE"]
    note: str = Field(default="", max_length=500)
    # #44: optional client operation id. When supplied and already recorded
    # for this dispatch, the confirmation is treated as a replay: the stored
    # result is returned and no second history event is written, so flush
    # retries keep exactly-once observable behavior.
    operation_id: str | None = Field(default=None, min_length=8, max_length=80)


class PlanReassignRequest(BaseModel):
    """Move one truck's share of an approved plan to another truck."""

    from_truck: str = Field(min_length=1, max_length=20)
    to_truck: str = Field(min_length=1, max_length=20)
    reason: str = Field(min_length=1, max_length=200)


class HybridPredictRequest(BaseModel):
    kelurahan: str = Field(min_length=1, max_length=50)
    precipitation_mm: float = Field(default=0.0, ge=0, le=1000)
    temp_max_c: float = Field(default=31.0, ge=-10, le=60)
    wind_max_kmh: float = Field(default=10.0, ge=0, le=300)
    is_weekend: bool = False
    is_holiday: bool = False
    event_attendance: int = Field(default=0, ge=0, le=5_000_000)
    target_date: date | None = None


class EventPermitRequest(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    location_name: str = Field(min_length=3, max_length=160)
    event_date: date
    expected_attendance: int = Field(gt=0, le=2_000_000)
    lat: float = Field(ge=-7.5, le=-5.5)
    lng: float = Field(ge=105.5, le=108.0)
    organizer: str | None = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)


class SpjStopBody(BaseModel):
    name: str
    kecamatan: str
    address: str
    lat: float
    lng: float
    location_type: str = "Pemukiman Kelas Menengah"
    # gsc P0-3: a DEMO stop at the operator's position (stored DEMO-labelled).
    demo: bool = False


class SpjCreateBody(BaseModel):
    driver_name: str
    truck_code: str
    destination: str
    weigh_on_site: bool = False
    priority: str = "normal"
    note: str = ""
    # #60: optional composed stops — when present, the SPJ and ALL stops
    # are created in one atomic transaction; a failing stop rolls the
    # whole draft back (no partial state).
    stops: list[SpjStopBody] | None = None


class SpjOverrideBody(BaseModel):
    """PR #90 (#63): a supervisor override names a substantive reason."""

    reason: str = Field(min_length=10, max_length=500)
    documents: str | None = Field(default=None, max_length=500)


class SpjCompleteBody(BaseModel):
    evidence: dict | None = None
    override: SpjOverrideBody | None = None


class SpjCompleteOverrideBody(BaseModel):
    override: bool = False
    reason: str = ""


class SpjReceiptBody(BaseModel):
    photo_name: str
    photo_b64: str = Field(default="", max_length=7_000_000)
    # #57: operational bound for one truck's single-run handover weight.
    # Absent (None) is allowed — not all handovers are weighed; when
    # present the value must be finite and 0 < w <= 60,000 kg.
    total_weight_kg: float | None = Field(
        default=None,
        gt=0,
        le=MAX_RECEIPT_WEIGHT_KG,
        allow_inf_nan=False,
        description="Receipt total weight in kg; omit when unweighed.",
    )
    # Provenance of the number above. Callers that do not state one are not
    # guessed at: "unspecified" keeps an unlabelled submission from being
    # recorded as if a human had typed it.
    weight_source: Literal["ocr", "manual", "unspecified"] = "unspecified"
    # Client-generated id for one submission attempt; a retry with the same id
    # returns the original receipt instead of a conflict.
    operation_id: str | None = Field(default=None, min_length=8, max_length=80)
    # PR #90 (#56): explicit replacement consent when overwriting a receipt.
    replace_reason: str | None = Field(default=None, min_length=10, max_length=500)


class PretripBody(BaseModel):
    truck_code: str
    driver_name: str
    items: dict[str, bool]
    note: str = ""


class DamageReportBody(BaseModel):
    truck_code: str
    driver_name: str
    component: str
    severity: str
    note: str
    photo_name: str | None = None
    photo_b64: str | None = Field(default=None, max_length=7_000_000)
    source: str = "driver_pwa"


class ScentinelImportBody(BaseModel):
    manifest: dict[str, Any]
    sensor_csv: str
    truck_code: str | None = None


class ServiceRecordBody(BaseModel):
    truck_code: str
    service_date: str
    component: str
    description: str
    cost_idr: int | None = None
    odometer_km: float | None = None
    technician: str = ""
    next_due_date: str | None = None


class OcrBody(BaseModel):
    photo_b64: str = Field(max_length=7_000_000)
