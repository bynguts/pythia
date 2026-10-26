"""The forecast learns from the weighbridge: a bounded correction from weighed SPJ days.

For each closed day (before today in WIB, no SPJ still draft or active) whose weighbridge
receipts all carry a net weight and that has an approved plan, the day's weighed tonnes
(OBSERVED_IN_APP) are stored next to the plan's forecast tonnes (MODEL_OUTPUT), both read
from the daily recap. When fewer trips reached the weighbridge than were planned, the
forecast side is pro-rated to the trips that did, so a cancelled trip never reads as the
model over-forecasting. The correction is an EWMA of actual / forecast over the last 14
weighed days, clamped to +/-25 %, and only active from 3 weighed days on. It is reported
next to the raw model value, never instead of it; the ratio comes from the pilot fleet's
trips and is applied to the city-wide figure as stated in `basis`.
"""

from __future__ import annotations

import threading
import time
from datetime import timedelta
from typing import Any

from app.core.env import local_today
from app.core.storage import RecordStore

WINDOW_DAYS = 14
MIN_DAYS = 3
CLAMP = 0.25
EWMA_ALPHA = 0.3
LOOKBACK_DAYS = 30
_CACHE_TTL_S = 60.0

LEARNING_STORE = RecordStore("pythia_forecast_learning")
_lock = threading.Lock()
_cache: dict[str, Any] = {"ts": 0.0, "payload": None}

BASIS = (
    "weighbridge net tonnes of closed SPJ days (pilot fleet) against the approved plan's forecast "
    "tonnes for the same day, pro-rated to the trips weighed; EWMA (alpha 0.3) of actual / forecast "
    "over the last 14 weighed days, clamped to +/-25 %, applied to the city-wide forecast as a factor"
)


def record_day(day: str, forecast_t: float, actual_t: float, **extra: Any) -> dict[str, Any]:
    """Store one weighed day (idempotent per date)."""
    row = {
        "date": day,
        "forecast_t": round(float(forecast_t), 2),
        "actual_t": round(float(actual_t), 2),
        "ratio": round(float(actual_t) / float(forecast_t), 4),
        "forecast_classification": "MODEL_OUTPUT",
        "actual_classification": "OBSERVED_IN_APP",
        **extra,
    }
    LEARNING_STORE.write(day, row)
    _cache["ts"] = 0.0
    return row


def sync_closed_days() -> int:
    """Record every closed, fully weighed day of the last 30 not stored yet; returns how many."""
    from app.field.recap import daily_recap
    from app.field.spj import SPJ_STORE

    today = local_today()
    first = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    stored = {row["date"] for row in LEARNING_STORE.all()}
    candidates = sorted(
        {s.date for s in SPJ_STORE.list() if s.date and first <= s.date < today.isoformat()} - stored
    )
    added = 0
    for day in candidates:
        recap = daily_recap(day)
        spj = recap["actual"]["spj"]
        if spj["draft"] or spj["aktif"] or recap["delta"]["tons"] is None:
            continue  # still open, no plan, or a receipt without a net weight
        planned = recap["forecast"]["planned_tons"]
        actual = recap["actual"]["receipt_tons"]
        trips = recap["forecast"]["planned_trips"]
        weighed = recap["actual"]["receipts"]
        if not planned or not actual:
            continue
        forecast = planned * weighed / trips if trips and weighed < trips else planned
        record_day(day, forecast, actual, planned_t=planned, planned_trips=trips, weighed_trips=weighed)
        added += 1
    return added


def compute_correction(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The bounded EWMA correction from stored days (pure: no store, no clock)."""
    usable = sorted((r for r in rows if r.get("forecast_t", 0) > 0), key=lambda r: r["date"])[-WINDOW_DAYS:]
    n = len(usable)
    raw = None
    if n:
        raw = usable[0]["ratio"]
        for row in usable[1:]:
            raw = EWMA_ALPHA * row["ratio"] + (1 - EWMA_ALPHA) * raw
    active = n >= MIN_DAYS
    factor = min(1 + CLAMP, max(1 - CLAMP, raw)) if raw is not None else 1.0
    return {
        "active": active,
        "factor": round(factor, 4) if active else 1.0,
        "pct": round((factor - 1) * 100, 1) if active else 0.0,
        "learned_factor": round(factor, 4) if raw is not None else None,
        "unclamped_factor": round(raw, 4) if raw is not None else None,
        "clamped": raw is not None and factor != raw,
        "n_days": n,
        "since": usable[0]["date"] if usable else None,
        "last_day": usable[-1]["date"] if usable else None,
        "min_days": MIN_DAYS,
        "window_days": WINDOW_DAYS,
        "clamp_pct": round(CLAMP * 100),
        "days": [{k: r[k] for k in ("date", "forecast_t", "actual_t", "ratio")} for r in usable],
        "basis": BASIS,
        "classification": "LEARNED_FROM_OBSERVED",
    }


def learned_correction() -> dict[str, Any]:
    """The current correction, after recording newly closed days (shared for 60 s)."""
    with _lock:
        if _cache["payload"] is not None and time.time() - _cache["ts"] < _CACHE_TTL_S:
            return _cache["payload"]
        sync_closed_days()
        _cache["payload"] = compute_correction(LEARNING_STORE.all())
        _cache["ts"] = time.time()
        return _cache["payload"]


def corrected(tons: float | None, correction: dict[str, Any]) -> float | None:
    """The raw model tonnes times the learned factor, or None while the correction is inactive."""
    if tons is None or not correction["active"]:
        return None
    return round(tons * correction["factor"], 1)
