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

Ask Pythia on the table (`POST /api/xr/ask`): /xr has no login, so a device without
a command-center session asks here. It runs the assistant's deterministic local
parser and the same read-only `run_scenario` tool (the /api/twin/scene forecast) —
never an LLM, and the question is neither stored nor logged. Results are cached by
their parsed parameters for a few minutes, so only a fresh forecast run spends from
the rate limit: per shared-table code when one is given, else per address, plus a
global cap.
"""

from __future__ import annotations

import ipaddress
import time
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Path, Request
from pydantic import BaseModel, Field

from app.api.state import _xr_sessions, _xr_sessions_lock
from app.assistant.scenario import (
    parse_scenario_question,
    question_language,
    run_scenario,
    scenario_answer,
    with_parse_step,
)
from app.core.env import today

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
ASK_BUCKET = (10.0, 1 / 6)  # each uncached ask runs a forecast: 10 at once, then one every 6 s
# All uncached asks together, whatever their session or address: the cap a rotation of
# session codes or addresses cannot get past.
ASK_GLOBAL_BUCKET = (40.0, 1 / 2)
MAX_CLIENTS = 2000
# (kind, client) -> (tokens, last refill); insertion order = least recently seen first.
_buckets: dict[tuple[str, str], tuple[float, float]] = {}
# Scenario results by their parsed parameters and the forecast date (gsc v3 N10): a
# repeated or identically-parsed ask is answered from here and spends no token. The
# TTL bounds how stale the base week's forecast weather can be; the LRU bounds memory.
ASK_CACHE_SIZE = 64
ASK_CACHE_TTL_S = 300.0
# key -> (stored at, run_scenario result); insertion order = least recently used first.
_ask_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}


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
    # The event venue (a twin venue id such as "jis"); none keeps the device's own venue.
    venue_id: str | None = Field(None, pattern="^[a-z0-9_-]{1,32}$")
    # The horizon day the what-if (rain / event) applies to; other days keep the base week.
    scenario_day: int = Field(0, ge=0, le=6)


class XrAsk(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    language: Literal["id", "en"] = "id"
    # The shared table's code, when the device has joined one: the rate limit is then
    # per session instead of per address (judges on one venue NAT share an address).
    session: str | None = Field(None, pattern=CODE_PATTERN)


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


@router.post("/api/xr/ask")
def post_xr_ask(body: XrAsk, request: Request) -> dict[str, Any]:
    """A what-if asked at the table: the local parser, then the read-only scenario tool.

    Returns the assistant's shape (`provider`, `answer`, `scenario` with its trace),
    or `scenario: null` when the question is not a what-if the parser understands.

    Only a forecast run spends rate-limit tokens: a question the parser does not read
    as a what-if, or one whose parameters were run in the last few minutes, is free.
    A run spends from the session's bucket when `session` names a live table (else the
    client address's) and from one global bucket."""
    language = question_language(body.question, body.language)
    parsed = parse_scenario_question(body.question)
    if not parsed:
        return {"provider": "local", "mode": "local", "tools_used": [], "answer": "", "scenario": None}
    # The parser's output is run_scenario's whole input (city, rain and its BMKG word,
    # crowd, venue, day = the what-if's scenario_day); the date fixes the forecast week.
    key = (today().isoformat(), *sorted((k, repr(v)) for k, v in parsed.items()))
    now = _clock()
    with _xr_sessions_lock:
        hit = _ask_cache.pop(key, None)
        if hit and now - hit[0] < ASK_CACHE_TTL_S:
            _ask_cache[key] = hit
            result = hit[1]
        else:
            result = None
            _purge(now)
            live_session = body.session and body.session in _xr_sessions
            _take("ask", f"session:{body.session}" if live_session else _client(request), ASK_BUCKET, now)
            _take("ask-all", "*", ASK_GLOBAL_BUCKET, now)
    if result is None:
        try:
            result = with_parse_step(run_scenario(parsed), "local_parser")
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        with _xr_sessions_lock:
            _ask_cache.pop(key, None)
            while len(_ask_cache) >= ASK_CACHE_SIZE:
                del _ask_cache[next(iter(_ask_cache))]
            _ask_cache[key] = (now, result)
    return {
        "provider": "local",
        "mode": "local",
        "tools_used": ["run_scenario"],
        "answer": scenario_answer(result, language),
        "scenario": result,
    }
