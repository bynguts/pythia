"""Pythia settings from the environment: every setting is ``PYTHIA_<NAME>``."""

from __future__ import annotations

import os

PREFIX = "PYTHIA_"


def getenv(name: str, default: str | None = None) -> str | None:
    """Return the ``PYTHIA_<name>`` environment variable, else ``default``."""
    return os.environ.get(PREFIX + name, default)
