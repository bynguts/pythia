from __future__ import annotations

import json
import logging
import os
import sqlite3
import tempfile
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

logger = logging.getLogger(__name__)


class StorageError(RuntimeError):
    """A mutation could not be durably committed.

    Raised instead of logging-and-continuing so no caller can acknowledge a
    write that never reached disk (see the JSON-store regression where a failed
    write still returned a successful domain object).
    """


def default_records_db(name: str) -> Path:
    """Durable store location: next to $JWIS_DB_PATH, else the temp dir.

    Same contract the JSON stores used, so an operator who pinned JWIS_DB_PATH
    keeps every record in one directory.
    """
    db_path = os.environ.get("JWIS_DB_PATH")
    if db_path:
        return Path(db_path).parent / f"{name}.db"
    return Path(tempfile.gettempdir()) / f"{name}.db"


class RecordStore:
    """Durable single-table record store backed by SQLite.

    One row per record with the domain object serialized as JSON, so the
    payload shape stays exactly what the JSON stores produced while the commit
    becomes atomic, ordered, and safe across worker processes (SQLite
    serializes writers; the primary key guarantees one row per record id).
    """

    def __init__(self, table: str, db_path: Path | str | None = None) -> None:
        if not table.isidentifier():
            raise ValueError(f"invalid table name: {table!r}")
        self.table = table
        self.db_path = Path(db_path) if db_path is not None else default_records_db(table)
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._init_schema()
        except (sqlite3.Error, OSError, StorageError) as exc:
            raise StorageError(
                f"cannot open durable store {table} at {self.db_path}: {exc}") from exc

    def _connect(self) -> sqlite3.Connection:
        try:
            connection = sqlite3.connect(self.db_path, timeout=15.0)
            connection.row_factory = sqlite3.Row
            # busy_timeout must be set before anything that takes a lock, so a
            # concurrent worker waits instead of failing immediately.
            connection.execute("PRAGMA busy_timeout=15000")
            try:
                # WAL is persistent, so this is a no-op after the first worker.
                # It briefly needs an exclusive lock, which is why the timeout
                # above comes first; losing the race is not an error.
                connection.execute("PRAGMA journal_mode=WAL")
            except sqlite3.OperationalError:
                logger.debug("%s: WAL already being set by another worker",
                             self.table)
        except sqlite3.Error as exc:
            raise StorageError(
                f"{self.table}: cannot open {self.db_path}: {exc}") from exc
        return connection

    def _init_schema(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {self.table} (
                        record_id TEXT PRIMARY KEY,
                        payload TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sequences (
                        name TEXT PRIMARY KEY,
                        value INTEGER NOT NULL
                    )
                    """
                )

    @contextmanager
    def _transaction(self, connection: sqlite3.Connection | None) -> Iterator[sqlite3.Connection]:
        if connection is not None:
            yield connection
            return
        owned = self._connect()
        try:
            with owned:
                yield owned
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: transaction failed: {exc}") from exc
        finally:
            owned.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Exclusive read-modify-write transaction (BEGIN IMMEDIATE).

        `IMMEDIATE` takes the write lock before the first read, so two workers
        cannot both read the same state, both decide their change is legal, and
        both commit — the failure mode that let two processes activate an SPJ
        for the same truck.
        """
        connection = self._connect()
        try:
            connection.isolation_level = None
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.Error as exc:
            connection.close()
            raise StorageError(
                f"{self.table}: cannot begin transaction: {exc}") from exc
        try:
            yield connection
        except BaseException:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            connection.close()
            raise
        try:
            connection.execute("COMMIT")
        except sqlite3.Error as exc:
            connection.close()
            raise StorageError(f"{self.table}: commit failed: {exc}") from exc
        connection.close()

    def write(self, record_id: str, payload: dict[str, Any],
              connection: sqlite3.Connection | None = None) -> None:
        """Insert or replace one record. Commits before returning."""
        now = datetime.now(timezone.utc).isoformat()
        blob = json.dumps(payload, ensure_ascii=False)
        try:
            with self._transaction(connection) as connection:
                connection.execute(
                    f"""
                    INSERT INTO {self.table} (record_id, payload, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(record_id) DO UPDATE SET
                        payload = excluded.payload,
                        updated_at = excluded.updated_at
                    """,
                    (record_id, blob, now, now),
                )
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: cannot persist {record_id}: {exc}") from exc

    def get(self, record_id: str,
            connection: sqlite3.Connection | None = None) -> dict[str, Any] | None:
        try:
            if connection is not None:
                row = connection.execute(
                    f"SELECT payload FROM {self.table} WHERE record_id=?",
                    (record_id,),
                ).fetchone()
            else:
                with closing(self._connect()) as owned:
                    row = owned.execute(
                        f"SELECT payload FROM {self.table} WHERE record_id=?",
                        (record_id,),
                    ).fetchone()
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: cannot read {record_id}: {exc}") from exc
        return json.loads(row["payload"]) if row is not None else None

    def all(self, connection: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        """Every record in insertion order (matches the JSON list order)."""
        try:
            if connection is not None:
                rows = connection.execute(
                    f"SELECT payload FROM {self.table} ORDER BY rowid ASC"
                ).fetchall()
            else:
                with closing(self._connect()) as owned:
                    rows = owned.execute(
                        f"SELECT payload FROM {self.table} ORDER BY rowid ASC"
                    ).fetchall()
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: cannot list records: {exc}") from exc
        return [json.loads(row["payload"]) for row in rows]

    def count(self) -> int:
        try:
            with closing(self._connect()) as connection:
                row = connection.execute(f"SELECT COUNT(*) AS n FROM {self.table}").fetchone()
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: cannot count records: {exc}") from exc
        return int(row["n"])

    def allocate_sequence(self, name: str,
                          connection: sqlite3.Connection | None = None) -> int:
        """Atomically reserve the next value of a monotonic counter."""
        try:
            with self._transaction(connection) as connection:
                row = connection.execute(
                    """
                    INSERT INTO sequences (name, value) VALUES (?, 1)
                    ON CONFLICT(name) DO UPDATE SET value = value + 1
                    RETURNING value
                    """,
                    (name,),
                ).fetchone()
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: cannot allocate {name}: {exc}") from exc
        return int(row["value"])

    def peek_sequence(self, name: str) -> int:
        """Next value without reserving it (display/formatting only)."""
        try:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT value FROM sequences WHERE name=?", (name,)
                ).fetchone()
        except sqlite3.Error as exc:
            raise StorageError(f"{self.table}: cannot read {name}: {exc}") from exc
        return int(row["value"]) + 1 if row is not None else 1

    def migrate_legacy_json(self, path: Path | str, id_key: str) -> int:
        """Import a pre-SQLite JSON store once, then retire the file.

        Returns the number of imported records. The JSON file is renamed so the
        import cannot run twice and cannot resurrect deleted records.
        """
        legacy = Path(path)
        if not legacy.exists() or self.count() > 0:
            return 0
        try:
            raw = json.loads(legacy.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.error("legacy store %s unreadable, not importing: %s", legacy, exc)
            return 0
        if not isinstance(raw, list):
            return 0
        imported = 0
        connection = self._connect()
        try:
            with connection:
                for item in raw:
                    if not isinstance(item, dict) or not item.get(id_key):
                        continue
                    self.write(str(item[id_key]), item, connection=connection)
                    imported += 1
        except (sqlite3.Error, StorageError) as exc:
            logger.error("legacy import of %s failed: %s", legacy, exc)
            return 0
        finally:
            connection.close()
        legacy.rename(legacy.with_suffix(legacy.suffix + ".migrated"))
        logger.info("imported %s records from %s", imported, legacy)
        return imported


class HistoryStore:
    # Necessary: the DB file must live OUTSIDE the backend cwd — uvicorn --reload
    # watches every file there, so each dispatch write to data/processed/*.db
    # triggered a worker restart (ECONNRESET mid-request + all caches dropped).
    def __init__(self, db_path: Path | str | None = None):
        if db_path is None:
            db_path = os.environ.get("JWIS_DB_PATH") or os.path.join(tempfile.gettempdir(), "jwis_history.db")
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_schema(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_type TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS dispatches (
                        id TEXT PRIMARY KEY,
                        truck_code TEXT NOT NULL,
                        instruction TEXT NOT NULL,
                        manager_id TEXT NOT NULL,
                        field_status TEXT NOT NULL,
                        confirmed_note TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL,
                        confirmed_at TEXT,
                        confirm_operation_id TEXT
                    )
                    """
                )

    def record_event(self, event_type: str, payload: dict[str, Any]) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "INSERT INTO events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
                    (event_type, json.dumps(payload), datetime.now(timezone.utc).isoformat()),
                )

    def list_events(self, limit: int = 50) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT event_type, payload_json, created_at FROM events ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "event_type": row["event_type"],
                "payload": json.loads(row["payload_json"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def save_dispatch(self, truck_code: str, instruction: str, manager_id: str) -> dict[str, Any]:
        dispatch = {
            "id": str(uuid4()),
            "truck_code": truck_code,
            "instruction": instruction,
            "manager_id": manager_id,
            "field_status": "PENDING",
            "confirmed_note": "",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "confirmed_at": None,
        }
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "INSERT INTO dispatches (id, truck_code, instruction, manager_id, "
                    "field_status, confirmed_note, created_at, confirmed_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (dispatch["id"], truck_code, instruction, manager_id, "PENDING",
                     "", dispatch["created_at"], None),
                )
        return dispatch

    def update_dispatch_status(self, dispatch_id: str, status: str, note: str = "",
                               operation_id: str | None = None) -> dict[str, Any]:
        confirmed_at = datetime.now(timezone.utc).isoformat()
        with closing(self._connect()) as connection:
            with connection:
                self._ensure_confirm_operation_column(connection)
                cur = connection.execute(
                    "UPDATE dispatches SET field_status=?, confirmed_note=?, confirmed_at=?, "
                    "confirm_operation_id=? WHERE id=?",
                    (status, note, confirmed_at, operation_id, dispatch_id),
                )
                if cur.rowcount == 0:
                    raise KeyError(f"Dispatch {dispatch_id} was not found.")
        return {"id": dispatch_id, "field_status": status, "confirmed_note": note,
                "confirmed_at": confirmed_at}

    def get_dispatch_operation(self, dispatch_id: str, operation_id: str) -> dict[str, Any] | None:
        """Return the stored confirmation for a replayed operation_id (#44)."""
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM dispatches WHERE id=? AND confirm_operation_id=?",
                (dispatch_id, operation_id),
            ).fetchone()
        if row is None:
            return None
        return {"id": row["id"], "field_status": row["field_status"],
                "confirmed_note": row["confirmed_note"], "confirmed_at": row["confirmed_at"]}

    @staticmethod
    def _ensure_confirm_operation_column(connection) -> None:
        # Lightweight migration for databases created before #44.
        columns = {row[1] for row in connection.execute("PRAGMA table_info(dispatches)")}
        if "confirm_operation_id" not in columns:
            connection.execute("ALTER TABLE dispatches ADD COLUMN confirm_operation_id TEXT")

    def get_dispatch(self, dispatch_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM dispatches WHERE id=?", (dispatch_id,)
            ).fetchone()
        return dict(row) if row is not None else None

    def list_dispatches(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM dispatches ORDER BY created_at ASC"
            ).fetchall()
        return [dict(row) for row in rows]

    def pending_dispatches(self, truck_code: str) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM dispatches WHERE truck_code=? AND field_status='PENDING' "
                "ORDER BY created_at ASC",
                (truck_code,),
            ).fetchall()
        return [dict(row) for row in rows]
