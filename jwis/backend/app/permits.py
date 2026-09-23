"""Submitted event permits (Case 2 crowd-permit intake).

Permits used to live in a module-level list, so a restart deleted them and the
`EV-USER-{len+1}` identifier could be handed out twice once the list was
rebuilt. They now live in the shared durable store with a sequence-allocated
identifier, so a restart preserves every permit and an identifier is never
reused.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from app.storage import RecordStore

logger = logging.getLogger(__name__)

TABLE = "jwis_permits"
ID_SEQUENCE = "event_permit"


class PermitStore:
    """Durable submitted-permit store, keyed by a monotonic `EV-USER-nnn` id."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._records = RecordStore(TABLE, db_path)

    def next_id(self, connection=None) -> str:
        return f"EV-USER-{self._records.allocate_sequence(ID_SEQUENCE, connection=connection):03d}"

    def add(self, permit: dict[str, Any]) -> dict[str, Any]:
        """Persist a permit under its already-allocated `id`."""
        permit_id = str(permit.get("id") or "").strip()
        if not permit_id:
            raise ValueError("permit id is required")
        self._records.write(permit_id, permit)
        return permit

    def list(self) -> list[dict[str, Any]]:
        return self._records.all()

    def count(self) -> int:
        return self._records.count()


PERMIT_STORE = PermitStore()
