"""Pythia settings from the environment: every setting is ``PYTHIA_<NAME>``."""

from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

PREFIX = "PYTHIA_"


def getenv(name: str, default: str | None = None) -> str | None:
    """Return the ``PYTHIA_<name>`` environment variable, else ``default``."""
    return os.environ.get(PREFIX + name, default)


def today() -> date:
    """The forecast "today": ``PYTHIA_DEMO_DATE`` (YYYY-MM-DD) when set, else the wall clock.

    Pinning it makes a recording deterministic (twin, fleet and forecast share one date).
    A malformed value raises, so a typo cannot silently fall back to the wall clock.
    """
    pinned = getenv("DEMO_DATE")
    return date.fromisoformat(pinned.strip()) if pinned and pinned.strip() else date.today()


# The operating day of DLH DKI Jakarta. WIB has had no DST since 1964, so a fixed
# UTC+7 is an exact fallback where the IANA database is missing (bare Windows/Docker).
LOCAL_TZ_NAME = "Asia/Jakarta"


def _local_tz() -> tzinfo:
    try:
        return ZoneInfo(LOCAL_TZ_NAME)
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=7), "WIB")


def local_now() -> datetime:
    """Wall-clock time in Asia/Jakarta (WIB), timezone-aware."""
    return datetime.now(UTC).astimezone(_local_tz())


def local_today() -> date:
    """The operational working day in Asia/Jakarta (WIB), not the UTC date.

    A 06:00 WIB pre-trip is still 23:00 UTC the previous day; SPJ numbering,
    pre-trip "today" and compliance lateness all use this day. ``PYTHIA_DEMO_DATE``
    wins when set, exactly as in :func:`today`.
    """
    pinned = getenv("DEMO_DATE")
    return date.fromisoformat(pinned.strip()) if pinned and pinned.strip() else local_now().date()
