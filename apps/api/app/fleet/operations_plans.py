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
from datetime import UTC, datetime
from typing import Any

from app.core.env import getenv

logger = logging.getLogger(__name__)


class OperationsPlanStore:
    _BUSY_TIMEOUT_MS = 10_000

    def __init__(self, db_path: str | None = None) -> None:
        if db_path is None:
            env = getenv("DB_PATH")
            if env:
                db_path = os.path.join(os.path.dirname(env), "pythia_operations.db")
            else:
                db_path = os.path.join(tempfile.gettempdir(), "pythia_operations.db")
        self.db_path = db_path
        parent = os.path.dirname(db_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._lock = threading.RLock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=self._BUSY_TIMEOUT_MS / 1000)
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
                # The structured side of each plan dispatch (truck, stops, slot,
                # reason): the dispatch row holds only the instruction text.
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS operations_dispatch_instructions (
                        dispatch_id TEXT PRIMARY KEY,
                        plan_id TEXT NOT NULL,
                        truck_code TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                # One draft SPJ per (plan, truck). The row is claimed before the
                # SPJ exists, so a raced or retried approval never creates two;
                # status is claimed | linked | skipped | error.
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS operations_plan_spj (
                        plan_id TEXT NOT NULL,
                        truck_code TEXT NOT NULL,
                        spj_id TEXT,
                        dispatch_id TEXT,
                        status TEXT NOT NULL,
                        detail TEXT,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (plan_id, truck_code)
                    )
                    """
                )
                # A truck reassign spans three databases (plan, dispatches, SPJ), so it
                # is ordered and resumable rather than atomic: this row records the
                # decision and the new dispatch id before the dispatch is written.
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS operations_plan_reassign (
                        plan_id TEXT NOT NULL,
                        from_truck TEXT NOT NULL,
                        to_truck TEXT NOT NULL,
                        old_dispatch_id TEXT NOT NULL,
                        new_dispatch_id TEXT NOT NULL,
                        spj_id TEXT,
                        item TEXT NOT NULL,
                        reason TEXT NOT NULL,
                        actor TEXT NOT NULL,
                        status TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY (plan_id, from_truck)
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
                    (plan_id, json.dumps(payload), "proposed", datetime.now(UTC).isoformat()),
                )
        return self.get(plan_id) or payload

    def get(self, plan_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM operations_plans WHERE plan_id=?", (plan_id,)).fetchone()
        if row is None:
            return None
        return self._payload(row)

    @staticmethod
    def _payload(row: sqlite3.Row) -> dict[str, Any]:
        payload = json.loads(row["payload"])
        payload["status"] = row["status"]
        payload["created_at"] = row["created_at"]
        if row["approved_at"]:
            payload["approved_at"] = row["approved_at"]
            payload["approved_by"] = row["approved_by"]
        if row["dispatch_ids"]:
            payload["dispatch_ids"] = json.loads(row["dispatch_ids"])
        return payload

    def list_plans(self, status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Stored plans, newest first; `status` narrows to proposed or approved.

        This is how a plan built in one browser reaches the approver in another.
        """
        query = "SELECT * FROM operations_plans"
        params: list[Any] = []
        if status:
            query += " WHERE status=?"
            params.append(status)
        query += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        params.append(limit)
        with closing(self._connect()) as connection:
            rows = connection.execute(query, params).fetchall()
        return [self._payload(row) for row in rows]

    def approve(self, plan_id: str, approved_by: str, create_dispatch) -> tuple[dict[str, Any], bool]:
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
                            "SELECT * FROM operations_plans WHERE plan_id=?", (plan_id,)
                        ).fetchone()
                        if row is None:
                            raise KeyError(f"Plan {plan_id} not found")
                        if row["status"] == "approved":
                            connection.execute("COMMIT")
                            return self.get(plan_id), False
                        payload = json.loads(row["payload"])
                        dispatch_ids: list[str] = []
                        now = datetime.now(UTC).isoformat()
                        # A day plan dispatches once per truck (all its trips);
                        # plans stored before the day plan dispatch per assignment.
                        for item in payload.get("dispatches") or payload["assignments"]:
                            dispatch = create_dispatch(item)
                            dispatch_ids.append(dispatch["id"])
                            if "fields" in item:
                                connection.execute(
                                    "INSERT OR REPLACE INTO operations_dispatch_instructions "
                                    "(dispatch_id, plan_id, truck_code, payload, created_at) VALUES (?,?,?,?,?)",
                                    (dispatch["id"], plan_id, item["truck_code"], json.dumps(item), now),
                                )
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

    def instructions_for(self, truck_code: str) -> list[dict[str, Any]]:
        """Structured plan instructions sent to one truck, oldest first."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM operations_dispatch_instructions WHERE truck_code=? ORDER BY created_at, dispatch_id",
                (truck_code,),
            ).fetchall()
        return [
            {
                "dispatch_id": row["dispatch_id"],
                "plan_id": row["plan_id"],
                "created_at": row["created_at"],
                **json.loads(row["payload"]),
            }
            for row in rows
        ]

    def spj_links(self, plan_id: str) -> list[dict[str, Any]]:
        """The plan's draft-SPJ link rows, one per truck, by truck code."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM operations_plan_spj WHERE plan_id=? ORDER BY truck_code", (plan_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def _set_spj_link(self, plan_id: str, truck_code: str, spj_id: str | None, status: str, detail) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "UPDATE operations_plan_spj SET spj_id=?, status=?, detail=?, updated_at=? "
                    "WHERE plan_id=? AND truck_code=?",
                    (spj_id, status, detail, datetime.now(UTC).isoformat(), plan_id, truck_code),
                )

    def ensure_spj_links(
        self, plan_id: str, trucks: list[tuple[str, str]], create_spj
    ) -> list[dict[str, Any]]:
        """Make sure every (truck_code, dispatch_id) of an approved plan has its draft SPJ.

        Claim first: the link row is inserted (INSERT OR IGNORE) before the SPJ
        exists, under the store lock, so a raced or retried approval never
        creates a second SPJ. A row left without an SPJ (a failed earlier
        attempt) is repaired: ``create_spj(truck_code) -> (spj_id, skipped)``
        adopts an existing draft or creates one. A failure is recorded on the
        row (status ``error``) and never raised: the approval stays committed.
        """
        with self._lock:
            for truck_code, dispatch_id in trucks:
                with closing(self._connect()) as connection:
                    with connection:
                        connection.execute(
                            "INSERT OR IGNORE INTO operations_plan_spj "
                            "(plan_id, truck_code, spj_id, dispatch_id, status, detail, updated_at) "
                            "VALUES (?,?,NULL,?,'claimed',NULL,?)",
                            (plan_id, truck_code, dispatch_id, datetime.now(UTC).isoformat()),
                        )
                        row = connection.execute(
                            "SELECT spj_id, status FROM operations_plan_spj WHERE plan_id=? AND truck_code=?",
                            (plan_id, truck_code),
                        ).fetchone()
                if row["spj_id"] or row["status"] == "skipped":
                    continue
                try:
                    spj_id, skipped = create_spj(truck_code)
                    status = "skipped" if skipped else "linked"
                    self._set_spj_link(plan_id, truck_code, spj_id, status, skipped)
                except Exception as exc:  # noqa: BLE001 - recorded on the row, approval stays
                    logger.exception("draft SPJ for plan %s truck %s failed", plan_id, truck_code)
                    try:
                        self._set_spj_link(plan_id, truck_code, None, "error", str(exc) or type(exc).__name__)
                    except sqlite3.Error:
                        logger.exception("could not record the draft SPJ failure")
        return self.spj_links(plan_id)

    def reassign_row(self, plan_id: str, from_truck: str) -> dict[str, Any] | None:
        """The reassign record of one truck of a plan, or None (status claimed | moved | done)."""
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM operations_plan_reassign WHERE plan_id=? AND from_truck=?",
                (plan_id, from_truck),
            ).fetchone()
        if row is None:
            return None
        return {**dict(row), "item": json.loads(row["item"])}

    def claim_reassign(self, plan_id: str, from_truck: str, **record: Any) -> dict[str, Any]:
        """Record a reassign before its first write elsewhere; the first claim wins.

        ``record`` holds to_truck, old_dispatch_id, new_dispatch_id (chosen up
        front, so the dispatch save is idempotent), spj_id, item, reason, actor.
        """
        with self._lock, closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "INSERT OR IGNORE INTO operations_plan_reassign "
                    "(plan_id, from_truck, to_truck, old_dispatch_id, new_dispatch_id, spj_id, item, "
                    "reason, actor, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'claimed',?)",
                    (
                        plan_id,
                        from_truck,
                        record["to_truck"],
                        record["old_dispatch_id"],
                        record["new_dispatch_id"],
                        record["spj_id"],
                        json.dumps(record["item"]),
                        record["reason"],
                        record["actor"],
                        datetime.now(UTC).isoformat(),
                    ),
                )
        return self.reassign_row(plan_id, from_truck)

    def set_reassign_status(self, plan_id: str, from_truck: str, status: str) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "UPDATE operations_plan_reassign SET status=? WHERE plan_id=? AND from_truck=?",
                    (status, plan_id, from_truck),
                )

    def reassign_truck(self, plan_id: str, from_truck: str) -> None:
        """Move one truck's share of an approved plan as its reassign record says, in ONE transaction.

        The plan payload (dispatch, assignments, dispatch id list), the
        structured instruction row and the draft-SPJ link row all move together,
        and the record turns ``moved``. A record already past ``claimed`` is a
        no-op, so a resumed reassign never moves twice.
        """
        with self._lock:
            connection = self._connect()
            connection.isolation_level = None
            with closing(connection):
                connection.execute("BEGIN IMMEDIATE")
                try:
                    record = connection.execute(
                        "SELECT * FROM operations_plan_reassign WHERE plan_id=? AND from_truck=?",
                        (plan_id, from_truck),
                    ).fetchone()
                    if record is None:
                        raise KeyError(f"No reassign recorded for {from_truck} in plan {plan_id}")
                    if record["status"] != "claimed":
                        connection.execute("COMMIT")
                        return
                    to_truck = record["to_truck"]
                    old_dispatch_id, new_dispatch_id = record["old_dispatch_id"], record["new_dispatch_id"]
                    item = json.loads(record["item"])
                    row = connection.execute(
                        "SELECT * FROM operations_plans WHERE plan_id=?", (plan_id,)
                    ).fetchone()
                    payload = json.loads(row["payload"])
                    payload["dispatches"] = [
                        item if d.get("truck_code") == from_truck else d
                        for d in payload.get("dispatches") or []
                    ]
                    for assignment in payload.get("assignments") or []:
                        if assignment.get("truck_code") == from_truck:
                            assignment["truck_code"] = to_truck
                    dispatch_ids = [
                        new_dispatch_id if d == old_dispatch_id else d
                        for d in json.loads(row["dispatch_ids"] or "[]")
                    ]
                    now = datetime.now(UTC).isoformat()
                    connection.execute(
                        "UPDATE operations_plans SET payload=?, dispatch_ids=? WHERE plan_id=?",
                        (json.dumps(payload), json.dumps(dispatch_ids), plan_id),
                    )
                    connection.execute(
                        "DELETE FROM operations_dispatch_instructions WHERE dispatch_id=?", (old_dispatch_id,)
                    )
                    connection.execute(
                        "INSERT OR REPLACE INTO operations_dispatch_instructions "
                        "(dispatch_id, plan_id, truck_code, payload, created_at) VALUES (?,?,?,?,?)",
                        (new_dispatch_id, plan_id, to_truck, json.dumps(item), now),
                    )
                    connection.execute(
                        "UPDATE operations_plan_spj SET truck_code=?, dispatch_id=?, updated_at=? "
                        "WHERE plan_id=? AND truck_code=?",
                        (to_truck, new_dispatch_id, now, plan_id, from_truck),
                    )
                    connection.execute(
                        "UPDATE operations_plan_reassign SET status='moved' WHERE plan_id=? AND from_truck=?",
                        (plan_id, from_truck),
                    )
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise

    def reload_cache(self) -> None:
        """Compatibility hook: durability comes from SQLite, nothing to do."""


def default_plan_store() -> OperationsPlanStore:
    return OperationsPlanStore()
