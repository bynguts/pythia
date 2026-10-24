"""Shared XR tabletop session: two or more /xr devices on one scenario.

Public like /xr itself. A session is only the scenario a group is looking at
(city, rain, event preset, day, the district someone pointed at) plus whether the
group agreed on it — no names, no accounts, no personal data. "Agreed" is a note
between the people in the room, never an official approval. State lives in memory,
expires after 12 h of inactivity, and the newest write wins (`updated_at` is
stamped by the server).

Presence: each open device posts a heartbeat with a random per-page id; a device
counts as present for 10 s after its last heartbeat. Heartbeats never change the
scenario or its `updated_at`, and only the count is ever returned.

Writes and heartbeats are rate-limited per client address (token buckets, single
worker): a steady stream of updates per device and a small budget of new codes.
"""

from __future__ import annotations

import ipaddress
import time
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Path, Request
from pydantic import BaseModel, Field

from app.api.state import _xr_sessions, _xr_sessions_lock

router = APIRouter()

SESSION_TTL_S = 12 * 3600
# Bounds memory for a public endpoint: past this, the stalest sessions go first.
MAX_SESSIONS = 500
CODE_PATTERN = "^[A-Z0-9]{4,8}$"
# A device is "here" for this long after its last heartbeat.
PRESENCE_TTL_S = 10.0
# Bounds the per-session presence table; past this the stalest device drops out.
MAX_PARTICIPANTS = 32
# Per-client token buckets: (capacity, refill per second).
PUT_BUCKET = (60.0, 10.0)  # a dragged slider, coalesced client-side, stays well below
NEW_SESSION_BUCKET = (30.0, 1 / 20)  # 30 fresh codes, then one every 20 s
MAX_CLIENTS = 2000
# (kind, client) -> (tokens, last refill); insertion order = least recently seen first.
_buckets: dict[tuple[str, str], tuple[float, float]] = {}


def _clock() -> float:
    """Wall clock in seconds; tests replace it to exercise expiry."""
    return time.time()


class XrSessionState(BaseModel):
    city: Literal["jakarta", "hcmc"]
    rainfall_mm: float = Field(0.0, ge=0, le=300)
    event_preset: Literal["none", "50k", "100k"] = "none"
    day: int = Field(0, ge=0, le=6)
    agreed: bool = False
    # The district the last device pointed at (a scene district id), or none.
    selected_id: str | None = Field(None, pattern="^[A-Za-z0-9_.-]{1,64}$")


class XrPresence(BaseModel):
    # Random per-page id generated on the device; never a name or an account.
    participant_id: str = Field(..., pattern="^[A-Za-z0-9]{8,32}$")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="milliseconds")


def _present(record: dict[str, Any], now: float) -> int:
    """Drop heartbeats older than the presence TTL and count the rest; caller holds the lock."""
    seen = record.setdefault("participants", {})
    for pid in [p for p, last in seen.items() if now - last >= PRESENCE_TTL_S]:
        del seen[pid]
    return len(seen)


def _public(code: str, record: dict[str, Any], now: float) -> dict[str, Any]:
    return {
        "code": code,
        **record["state"],
        "participants": _present(record, now),
        "updated_at": _iso(record["updated"]),
        "expires_at": _iso(record["updated"] + SESSION_TTL_S),
        "classification": "SESSION_STATE",
    }


def _client(request: Request) -> str:
    """The caller's address. Behind a local or private-network proxy (vite preview,
    nginx, a tunnel) the peer is the proxy, so the last X-Forwarded-For hop — the one
    that proxy chain appended — names the client; a direct public peer is never overridden."""
    peer = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("x-forwarded-for", "")
    try:
        trusted = ipaddress.ip_address(peer).is_private
    except ValueError:
        trusted = False
    if trusted and forwarded.strip():
        return forwarded.split(",")[-1].strip()
    return peer


def _take(kind: str, client: str, bucket: tuple[float, float], now: float) -> None:
    """Spend one token or raise 429; caller holds the lock."""
    capacity, rate = bucket
    tokens, last = _buckets.pop((kind, client), (capacity, now))
    tokens = min(capacity, tokens + max(0.0, now - last) * rate)
    if len(_buckets) >= MAX_CLIENTS:
        del _buckets[next(iter(_buckets))]
    if tokens < 1:
        _buckets[(kind, client)] = (tokens, now)
        retry = max(1, round((1 - tokens) / rate))
        raise HTTPException(
            status_code=429,
            detail="Too many XR session updates; try again shortly",
            headers={"Retry-After": str(retry)},
        )
    _buckets[(kind, client)] = (tokens - 1, now)


def _purge(now: float) -> None:
    """Drop expired sessions; caller holds the lock."""
    for code in [c for c, r in _xr_sessions.items() if now - r["updated"] >= SESSION_TTL_S]:
        del _xr_sessions[code]


@router.get("/api/xr/session/{code}")
def get_xr_session(code: str = Path(..., pattern=CODE_PATTERN)) -> dict[str, Any]:
    now = _clock()
    with _xr_sessions_lock:
        _purge(now)
        record = _xr_sessions.get(code)
        if record is None:
            raise HTTPException(status_code=404, detail="Unknown or expired XR session")
        return _public(code, record, now)


@router.put("/api/xr/session/{code}")
def put_xr_session(
    body: XrSessionState, request: Request, code: str = Path(..., pattern=CODE_PATTERN)
) -> dict[str, Any]:
    """Create or replace the session's scenario (last writer wins)."""
    now = _clock()
    client = _client(request)
    with _xr_sessions_lock:
        _purge(now)
        previous = _xr_sessions.get(code)
        _take("put", client, PUT_BUCKET, now)
        if previous is None:
            _take("new", client, NEW_SESSION_BUCKET, now)
        # Strictly increasing per session, so clients can order writes by updated_at
        # even when two arrive within the same millisecond.
        updated = max(now, previous["updated"] + 0.001) if previous else now
        if previous is None and len(_xr_sessions) >= MAX_SESSIONS:
            stalest = min(_xr_sessions, key=lambda c: _xr_sessions[c]["updated"])
            del _xr_sessions[stalest]
        participants = previous.get("participants", {}) if previous else {}
        record = {"state": body.model_dump(), "updated": updated, "participants": participants}
        _xr_sessions[code] = record
        return _public(code, record, now)


@router.post("/api/xr/session/{code}/presence")
def post_xr_presence(
    body: XrPresence, request: Request, code: str = Path(..., pattern=CODE_PATTERN)
) -> dict[str, Any]:
    """Heartbeat: mark this device present and return the session with the live count.

    Spends from the same per-client bucket as scenario writes, and never touches the
    scenario or `updated_at`, so polling devices do not re-apply state because of it."""
    now = _clock()
    client = _client(request)
    with _xr_sessions_lock:
        _purge(now)
        record = _xr_sessions.get(code)
        if record is None:
            raise HTTPException(status_code=404, detail="Unknown or expired XR session")
        _take("put", client, PUT_BUCKET, now)
        seen = record.setdefault("participants", {})
        seen.pop(body.participant_id, None)
        if len(seen) >= MAX_PARTICIPANTS:
            del seen[min(seen, key=seen.get)]
        seen[body.participant_id] = now
        return _public(code, record, now)
