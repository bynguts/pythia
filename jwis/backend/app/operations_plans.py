"""Durable operations-plan storage (#32) with idempotent approval (#17).

Plans used to live in an in-process dict (_OPERATIONS_PLANS in main.py):
a restart or second API worker lost them, and approving the same plan
twice created a duplicate dispatch set every time. This store keeps the
plan payload in SQLite (WAL) and makes approval at-most-once — the plan
status transition and its dispatch ids commit in ONE transaction, so
concurrent or retried approvals observe the first result.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import tempfile
import threading
from contextlib import closing
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


class OperationsPlanStore:
    _BUSY_TIMEOUT_MS = 10_000

    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            env = os.environ.get("JWIS_DB_PATH")
            if env:
                db_path = os.path.join(os.path.dirname(env), "jwis_operations.db")
            else:
                db_path = os.path.join(tempfile.gettempdir(), "jwis_operations.db")
        self.db_path = db_path
        parent = os.path.dirname(db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._lock = threading.RLock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path,
                                     timeout=self._BUSY_TIMEOUT_MS / 1000)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
        return connection

    def _init_schema(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS operations_plans (
                        plan_id TEXT PRIMARY KEY,
                        payload TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'proposed',
                        dispatch_ids TEXT,
                        approved_at TEXT,
                        approved_by TEXT,
                        created_at TEXT NOT NULL
                    )
                    """
                )

    # -- plan lifecycle -----------------------------------------------------

    def save_proposed(self, plan_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist a newly proposed plan; returns the stored payload."""
        with self._lock, closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "INSERT OR REPLACE INTO operations_plans "
                    "(plan_id, payload, status, dispatch_ids, approved_at, approved_by, created_at) "
                    "VALUES (?,?,?,NULL,NULL,NULL,?)",
                    (plan_id, json.dumps(payload), "proposed",
                     datetime.now(timezone.utc).isoformat()),
                )
        return self.get(plan_id) or payload

    def get(self, plan_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM operations_plans WHERE plan_id=?", (plan_id,)
            ).fetchone()
        if row is None:
            return None
        payload = json.loads(row["payload"])
        payload["status"] = row["status"]
        if row["dispatch_ids"]:
            payload["dispatch_ids"] = json.loads(row["dispatch_ids"])
        return payload

    def approve(self, plan_id: str, approved_by: str,
                create_dispatch) -> tuple[dict[str, Any], bool]:
        """Approve a plan at-most-once.

        create_dispatch(assignment) -> dispatch dict is called for every
        assignment ONLY if the plan is still 'proposed'. The status
        transition, dispatch id list, and (via the caller's SQLite-backed
        dispatch store) the dispatch rows all commit together; a raced or
        retried approval returns the already-committed result unchanged.

        Returns (plan_payload, created_now).
        """
        with self._lock:
            connection = self._connect()
            connection.isolation_level = None
            try:
                with closing(connection):
                    connection.execute("BEGIN IMMEDIATE")
                    try:
                        row = connection.execute(
                            "SELECT * FROM operations_plans WHERE plan_id=?",
                            (plan_id,)).fetchone()
                        if row is None:
                            raise KeyError(f"Plan {plan_id} not found")
                        if row["status"] == "approved":
                            connection.execute("COMMIT")
                            return self.get(plan_id), False
                        payload = json.loads(row["payload"])
                        dispatch_ids: list[str] = []
                        for assignment in payload["assignments"]:
                            dispatch = create_dispatch(assignment)
                            dispatch_ids.append(dispatch["id"])
                        now = datetime.now(timezone.utc).isoformat()
                        connection.execute(
                            "UPDATE operations_plans SET status='approved', "
                            "dispatch_ids=?, approved_at=?, approved_by=? "
                            "WHERE plan_id=? AND status='proposed'",
                            (json.dumps(dispatch_ids), now, approved_by, plan_id),
                        )
                        connection.execute("COMMIT")
                    except Exception:
                        try:
                            connection.execute("ROLLBACK")
                        except sqlite3.OperationalError:
                            pass
                        raise
            except sqlite3.OperationalError:
                raise
            return self.get(plan_id), True

    def reload_cache(self) -> None:
        """Compatibility hook: durability comes from SQLite, nothing to do."""


def default_plan_store() -> OperationsPlanStore:
    return OperationsPlanStore()
