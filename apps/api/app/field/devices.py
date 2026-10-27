"""Driver phones seen by this server: a last-seen heartbeat per truck.

Every truck-scoped read or write of a driver-role session (instructions poll,
pre-trip, safety, exceptions, gate arrival) passes ``ensure_truck_access``,
which notes the truck here. Nothing is inferred: a phone that never called
this server is not counted, so a fresh demo honestly shows 0 synced.

Writes are throttled per (username, truck) so a polling phone costs one
SQLite write a minute, not one per request. No usernames leave the API.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from app.core.storage import RecordStore, StorageError

logger = logging.getLogger(__name__)

HEARTBEATS = RecordStore("pythia_device_heartbeats")
WRITE_EVERY_SECONDS = 60.0
WINDOW_MINUTES = 30

_last_write: dict[str, float] = {}
_lock = threading.Lock()


def note_seen(username: str, truck_code: str | None, now: datetime | None = None) -> None:
    """Record that a driver session used ``truck_code``; never raises."""
    if not truck_code:
        return
    key = f"{username}|{truck_code}"
    clock = time.monotonic()
    with _lock:
        if now is None and clock - _last_write.get(key, -WRITE_EVERY_SECONDS) < WRITE_EVERY_SECONDS:
            return
        _last_write[key] = clock
    at = (now or datetime.now(UTC)).isoformat()
    try:
        HEARTBEATS.write(key, {"username": username, "truck_code": truck_code, "at": at})
    except StorageError:
        logger.exception("device heartbeat for %s not stored", truck_code)


def devices_payload(expected: int | None, now: datetime | None = None) -> dict[str, Any]:
    """Trucks whose phone called in within the window; ``expected`` is the planned truck count or None."""
    now = now or datetime.now(UTC)
    since = now - timedelta(minutes=WINDOW_MINUTES)
    latest: dict[str, datetime] = {}
    for raw in HEARTBEATS.all():
        try:
            at = datetime.fromisoformat(raw["at"])
        except (KeyError, TypeError, ValueError):
            continue
        code = raw.get("truck_code")
        if code and (code not in latest or at > latest[code]):
            latest[code] = at
    seen = sorted(latest.items(), key=lambda kv: kv[1], reverse=True)
    return {
        "synced": sum(1 for _, at in seen if since <= at <= now + timedelta(minutes=5)),
        "expected": expected,
        "window_minutes": WINDOW_MINUTES,
        "last_seen": [{"truck_code": code, "at": at.isoformat()} for code, at in seen],
        "classification": "FIELD",
        "basis": "driver-app requests to this server, per truck; a phone that never called in is not counted",
    }
