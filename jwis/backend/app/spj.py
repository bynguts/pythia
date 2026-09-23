"""SPJ (Surat Perintah Jalan) engine — work orders as route ground truth.

An active SPJ becomes the truck's assigned reference path: the existing
deviation detector (rule 500m + IsolationForest + hysteresis) then measures
compliance against the SPJ stops without any change to detection logic.

Records live in the shared durable store (SQLite, see app.storage), so several
API workers read one consistent state and a mutation is only acknowledged once
it has committed. Field evidence is a precondition of normal completion; the
exceptional supervisor path is explicit, permission-gated, reasoned and
audited.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import tempfile
import threading
from contextlib import closing
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from uuid import uuid4

from app.osrm import road_route
from app.facilities import provenance_payload, route_ground_truth

logger = logging.getLogger(__name__)

# Canonical destination list comes from the verified facilities registry
# (#59); the tuple below only re-exports it for backward compatibility.
DESTINATIONS = ("TPST Bantargebang", "JRC Pesanggrahan", "RDF Plant Jakarta")

MAX_EVIDENCE_PHOTO_CHARS = 7_000_000
MAX_STOP_WEIGHT_KG = 60_000  # matches the receipt operational bound (#57)
SUPPORTED_FRACTIONS = ("Residu", "Organik", "Anorganik")
# Greater Jakarta operational region; loose enough for reroutes.
JAKARTA_LAT_RANGE = (-7.5, -5.5)
JAKARTA_LNG_RANGE = (105.5, 107.5)


def _require_text(value, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"evidence.{field} is required")


def _require_photo(value, field: str) -> None:
    _require_text(value, field)
    if len(value) > MAX_EVIDENCE_PHOTO_CHARS:
        raise ValueError(f"evidence.{field} exceeds 7,000,000 chars")


def _require_coord(value, field: str, rng: tuple[float, float]) -> None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"evidence.{field} is required") from None
    if not (rng[0] <= number <= rng[1]):
        raise ValueError(
            f"evidence.{field}={number} is outside the Jakarta operational "
            f"region [{rng[0]}, {rng[1]}]")

TABLE = "jwis_spj"
LEGACY_JSON = "jwis_spj.json"


def _validate_evidence(evidence: dict) -> None:
    """Server-side evidence contract for stop completion (#54).

    A filename alone is NOT evidence: the arrival record needs image data
    and valid Jakarta-region coordinates, every weighing entry needs a
    supported fraction, a positive bounded weight, and photo proof, and
    the officer record needs both identity and photo proof. Every error
    names the offending field.
    """
    if not isinstance(evidence, dict):
        raise ValueError("evidence must be an object")

    arrival = evidence.get("arrival") or {}
    if not isinstance(arrival, dict):
        raise ValueError("evidence.arrival is required")
    _require_photo(arrival.get("photo_name"), "arrival.photo_name")
    _require_photo(arrival.get("photo_b64"), "arrival.photo_b64")
    _require_coord(arrival.get("lat"), "arrival.lat", JAKARTA_LAT_RANGE)
    _require_coord(arrival.get("lng"), "arrival.lng", JAKARTA_LNG_RANGE)

    weighing = evidence.get("weighing")
    if weighing is None:
        weighing = []
    if not isinstance(weighing, list):
        raise ValueError("evidence.weighing must be a list")
    for i, entry in enumerate(weighing):
        if not isinstance(entry, dict):
            raise ValueError(f"evidence.weighing[{i}] must be an object")
        if entry.get("fraction") not in SUPPORTED_FRACTIONS:
            raise ValueError(
                f"evidence.weighing[{i}].fraction must be one of "
                f"{SUPPORTED_FRACTIONS}")
        try:
            weight = float(entry.get("weight_kg"))
        except (TypeError, ValueError):
            raise ValueError(
                f"evidence.weighing[{i}].weight_kg is required") from None
        if not (0 < weight <= MAX_STOP_WEIGHT_KG):
            raise ValueError(
                f"evidence.weighing[{i}].weight_kg={weight} must be "
                f"0 < w <= {MAX_STOP_WEIGHT_KG}")
        _require_photo(entry.get("photo_name"), f"weighing[{i}].photo_name")
        _require_photo(entry.get("photo_b64"), f"weighing[{i}].photo_b64")

    officer = evidence.get("officer") or {}
    if not isinstance(officer, dict):
        raise ValueError("evidence.officer is required")
    _require_text(officer.get("name"), "officer.name")
    _require_photo(officer.get("photo_name"), "officer.photo_name")
    _require_photo(officer.get("photo_b64"), "officer.photo_b64")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _validate_override(override: dict | None, actor: str | None) -> dict:
    """An override must name who authorized it and why — never a bare bypass."""
    if not isinstance(override, dict):
        raise ValueError(
            "closing a stop without field evidence requires a supervisor "
            "override object with a reason")
    reason = str(override.get("reason") or "").strip()
    if len(reason) < 10:
        raise ValueError(
            "a supervisor override without field evidence requires a reason "
            "of at least 10 characters")
    who = str(override.get("actor") or actor or "").strip()
    if not who:
        raise ValueError("supervisor override requires the authorizing actor")
    return {"reason": reason, "actor": who, "at": _utc_now(),
            "documents": override.get("documents") or None}


def spj_summary_payload(spj: Spj) -> dict:
    """List projection: stop evidence and the receipt photo stay out.

    Receipt metadata is small and drives the driver's pending-receipt task;
    the image bytes are served only by the detail endpoint.
    """
    payload = {key: value for key, value in vars(spj).items() if key != "stops"}
    payload["stops"] = []
    for stop in spj.stops:
        item = {key: value for key, value in vars(stop).items() if key != "evidence"}
        evidence = stop.evidence
        if evidence is None:
            item["evidence_summary"] = None
        else:
            weighing = evidence.get("weighing") or []
            item["evidence_summary"] = {
                "has_evidence": True,
                "weighing_count": len(weighing),
                "total_weight_kg": round(
                    sum(float(w.get("weight_kg") or 0) for w in weighing), 1),
            }
        payload["stops"].append(item)
    return payload


@dataclass
class SpjStop:
    name: str
    kecamatan: str
    address: str
    lat: float
    lng: float
    location_type: str = "Pemukiman Kelas Menengah"
    status: str = "pending"  # pending | completed
    completed_at: str | None = None
    evidence: dict | None = None
    override: dict | None = None  # supervisor override that closed this stop


@dataclass
class Spj:
    spj_id: str
    spj_number: str
    date: str
    driver_name: str
    truck_code: str
    destination: str
    weigh_on_site: bool = False
    priority: str = "normal"  # normal | vip
    note: str = ""
    stops: list[SpjStop] = field(default_factory=list)
    status: str = "draft"  # draft | aktif | selesai | batal
    created_by: str = "admin"
    created_at: str = ""
    activated_at: str | None = None
    completed_at: str | None = None
    # #58: road-following compliance geometry resolved at activation.
    route_geometry: list[tuple[float, float]] = field(default_factory=list)
    route_source: str | None = None      # LIVE_EXTERNAL | FALLBACK_DEGRADED
    route_resolved_at: str | None = None
    receipt: dict | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def next_spj_number(store: "SpjStore") -> str:
    """Next daily sequence number, read from the database (not the cache).

    Reading from SQLite is what makes the number multi-process safe: every
    worker sees committed numbers from other workers.
    """
    today = datetime.now(timezone.utc)
    prefix = today.strftime("DLH-DKI/SPJ/%d-%m-%Y/")
    with closing(store._connect()) as connection:
        row = connection.execute(
            "SELECT MAX(CAST(SUBSTR(spj_number, ?) AS INTEGER)) AS max_seq "
            "FROM spj WHERE spj_number LIKE ?",
            (len(prefix) + 1, prefix + "%"),
        ).fetchone()
    max_seq = row["max_seq"] or 0
    return f"{prefix}{max_seq + 1:06d}"


def _default_persist_path() -> str:
    db_path = os.environ.get("JWIS_DB_PATH")
    if db_path:
        return os.path.join(os.path.dirname(db_path), "jwis_spj.db")
    return os.path.join(tempfile.gettempdir(), "jwis_spj.db")


def _legacy_json_path(db_path: str) -> str:
    """Where the pre-SQLite store kept its whole-file JSON state."""
    return os.path.splitext(db_path)[0] + ".json"


class SpjStore:
    """SQLite-backed SPJ store, safe across worker processes.

    Every mutation runs inside one SQLite transaction (BEGIN IMMEDIATE),
    so concurrent workers serialize on the database itself rather than an
    in-process lock. The daily spj_number is allocated inside the same
    transaction as the INSERT, guarded by a UNIQUE constraint; a conflict
    retries with a fresh number.
    """

    _BUSY_TIMEOUT_MS = 10_000

    def __init__(self, persist_path: str | None = None,
                 db_path: str | None = None) -> None:
        # db_path is the PR #90 keyword alias for the same path.
        self._path = persist_path or db_path or _default_persist_path()
        self._spj: dict[str, Spj] = {}  # read cache; SQLite is the source of truth
        self._lock = threading.RLock()
        self._init_schema()
        self._migrate_legacy_json()
        self._reload_cache()

    # -- connection helpers -------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=self._BUSY_TIMEOUT_MS / 1000)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(f"PRAGMA busy_timeout={self._BUSY_TIMEOUT_MS}")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _init_schema(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS spj (
                        spj_id TEXT PRIMARY KEY,
                        spj_number TEXT NOT NULL UNIQUE,
                        date TEXT NOT NULL,
                        driver_name TEXT NOT NULL,
                        truck_code TEXT NOT NULL,
                        destination TEXT NOT NULL,
                        weigh_on_site INTEGER NOT NULL DEFAULT 0,
                        priority TEXT NOT NULL DEFAULT 'normal',
                        note TEXT NOT NULL DEFAULT '',
                        status TEXT NOT NULL DEFAULT 'draft',
                        created_by TEXT NOT NULL DEFAULT 'admin',
                        created_at TEXT NOT NULL,
                        activated_at TEXT,
                        completed_at TEXT,
                        route_geometry TEXT,
                        route_source TEXT,
                        route_resolved_at TEXT
                    )
                    """
                )
                # #58: existing databases gain the route columns.
                columns = {r["name"] for r in connection.execute(
                    "PRAGMA table_info(spj)").fetchall()}
                for col in ("route_geometry", "route_source", "route_resolved_at"):
                    if col not in columns:
                        connection.execute(f"ALTER TABLE spj ADD COLUMN {col} TEXT")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS spj_stops (
                        spj_id TEXT NOT NULL REFERENCES spj(spj_id) ON DELETE CASCADE,
                        idx INTEGER NOT NULL,
                        name TEXT NOT NULL,
                        kecamatan TEXT NOT NULL,
                        address TEXT NOT NULL,
                        lat REAL NOT NULL,
                        lng REAL NOT NULL,
                        location_type TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        completed_at TEXT,
                        evidence TEXT,
                        override TEXT,
                        PRIMARY KEY (spj_id, idx)
                    )
                    """
                )
                # Existing databases gain the override column (#63 PR #90).
                stop_columns = {r["name"] for r in connection.execute(
                    "PRAGMA table_info(spj_stops)").fetchall()}
                if "override" not in stop_columns:
                    connection.execute(
                        "ALTER TABLE spj_stops ADD COLUMN override TEXT")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS spj_receipts (
                        spj_id TEXT PRIMARY KEY REFERENCES spj(spj_id) ON DELETE CASCADE,
                        photo_name TEXT NOT NULL,
                        photo_b64 TEXT NOT NULL,
                        total_weight_kg REAL,
                        weight_source TEXT NOT NULL,
                        submitted_by TEXT NOT NULL,
                        operation_id TEXT,
                        recorded_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS spj_audit (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        spj_id TEXT NOT NULL,
                        action TEXT NOT NULL,
                        actor TEXT NOT NULL,
                        reason TEXT NOT NULL DEFAULT '',
                        payload TEXT NOT NULL DEFAULT '{}',
                        created_at TEXT NOT NULL
                    )
                    """
                )
                self._migrate_receipt_columns(connection)

    @staticmethod
    def _migrate_receipt_columns(connection: sqlite3.Connection) -> None:
        """Add columns introduced after a database was first created."""
        columns = {row["name"] for row in
                   connection.execute("PRAGMA table_info(spj_receipts)")}
        if columns and "operation_id" not in columns:
            connection.execute("ALTER TABLE spj_receipts ADD COLUMN operation_id TEXT")

    @staticmethod
    def _audit(connection: sqlite3.Connection, spj_id: str, action: str,
               actor: str, reason: str = "", payload: dict | None = None) -> None:
        connection.execute(
            "INSERT INTO spj_audit (spj_id, action, actor, reason, payload, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (spj_id, action, actor, reason, json.dumps(payload or {}),
             _utc_now()),
        )

    def audit_log(self, spj_id: str) -> list[dict]:
        """Audit entries for one SPJ, oldest first."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT action, actor, reason, payload, created_at FROM spj_audit "
                "WHERE spj_id=? ORDER BY id", (spj_id,)).fetchall()
        return [
            {"action": r["action"], "actor": r["actor"], "reason": r["reason"],
             "payload": json.loads(r["payload"]), "created_at": r["created_at"]}
            for r in rows
        ]

    def _migrate_legacy_json(self) -> None:
        """One-time import from the pre-SQLite whole-file JSON store."""
        legacy = _legacy_json_path(self._path)
        if not os.path.exists(legacy):
            return
        with open(legacy, "rb") as fh:
            head = fh.read(16)
        if head.startswith(b"SQLite format 3"):
            return  # the "legacy" path is itself a SQLite file (test habit)
        try:
            with closing(self._connect()) as connection:
                row = connection.execute("SELECT COUNT(*) AS n FROM spj").fetchone()
                if row["n"] > 0:
                    return  # DB already populated; JSON is stale
                with open(legacy, encoding="utf-8") as fh:
                    raw = json.loads(fh.read())
                with connection:
                    for item in raw:
                        stops = item.pop("stops", [])
                        connection.execute(
                            "INSERT INTO spj (spj_id, spj_number, date, driver_name, "
                            "truck_code, destination, weigh_on_site, priority, note, "
                            "status, created_by, created_at, activated_at, completed_at) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (item.get("spj_id"), item.get("spj_number"), item.get("date"),
                             item.get("driver_name"), item.get("truck_code"),
                             item.get("destination"), int(bool(item.get("weigh_on_site"))),
                             item.get("priority", "normal"), item.get("note", ""),
                             item.get("status", "draft"), item.get("created_by", "admin"),
                             item.get("created_at", ""), item.get("activated_at"),
                             item.get("completed_at")),
                        )
                        for idx, stop in enumerate(stops):
                            connection.execute(
                                "INSERT INTO spj_stops (spj_id, idx, name, kecamatan, "
                                "address, lat, lng, location_type, status, completed_at, "
                                "evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (item["spj_id"], idx, stop.get("name"),
                                 stop.get("kecamatan"), stop.get("address"),
                                 stop.get("lat"), stop.get("lng"),
                                 stop.get("location_type", "Pemukiman Kelas Menengah"),
                                 stop.get("status", "pending"), stop.get("completed_at"),
                                 json.dumps(stop["evidence"]) if stop.get("evidence") else None),
                            )
            logger.info("migrated legacy SPJ JSON %s into %s", legacy, self._path)
        except Exception:  # noqa: BLE001
            logger.exception("legacy SPJ JSON migration failed for %s", legacy)

    @staticmethod
    def _row_to_spj(spj_row: sqlite3.Row, stop_rows: list,
                    receipt_row: sqlite3.Row | None = None) -> Spj:
        route_geometry = None
        if spj_row["route_geometry"] if "route_geometry" in spj_row.keys() else None:
            try:
                route_geometry = [tuple(p) for p in json.loads(
                    spj_row["route_geometry"])]
            except (ValueError, TypeError):
                route_geometry = None
        return Spj(
            spj_id=spj_row["spj_id"], spj_number=spj_row["spj_number"],
            date=spj_row["date"], driver_name=spj_row["driver_name"],
            truck_code=spj_row["truck_code"], destination=spj_row["destination"],
            weigh_on_site=bool(spj_row["weigh_on_site"]),
            priority=spj_row["priority"], note=spj_row["note"],
            stops=[SpjStop(
                name=r["name"], kecamatan=r["kecamatan"], address=r["address"],
                lat=r["lat"], lng=r["lng"], location_type=r["location_type"],
                status=r["status"], completed_at=r["completed_at"],
                evidence=json.loads(r["evidence"]) if r["evidence"] else None,
                override=json.loads(r["override"]) if r["override"] else None,
            ) for r in sorted(stop_rows, key=lambda r: r["idx"])],
            status=spj_row["status"], created_by=spj_row["created_by"],
            created_at=spj_row["created_at"], activated_at=spj_row["activated_at"],
            completed_at=spj_row["completed_at"],
            route_geometry=route_geometry or [],
            route_source=spj_row["route_source"] if "route_source" in spj_row.keys() else None,
            route_resolved_at=spj_row["route_resolved_at"] if "route_resolved_at" in spj_row.keys() else None,
            receipt=({**{key: receipt_row[key] for key in
                        ("photo_name", "total_weight_kg", "weight_source",
                         "submitted_by", "recorded_at")},
                      "has_photo": bool(receipt_row["has_photo"])}
                     if receipt_row is not None else None),
        )

    def _load_spj(self, connection: sqlite3.Connection, spj_id: str) -> Spj | None:
        row = connection.execute("SELECT * FROM spj WHERE spj_id=?", (spj_id,)).fetchone()
        if row is None:
            return None
        stops = connection.execute(
            "SELECT * FROM spj_stops WHERE spj_id=? ORDER BY idx", (spj_id,)
        ).fetchall()
        receipt = connection.execute(
            "SELECT photo_name, total_weight_kg, weight_source, submitted_by, "
            "recorded_at, (photo_b64 IS NOT NULL AND photo_b64 != '') AS has_photo "
            "FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone()
        return self._row_to_spj(row, stops, receipt)

    def _reload_cache(self) -> None:
        with closing(self._connect()) as connection:
            rows = connection.execute("SELECT spj_id FROM spj").fetchall()
            self._spj = {}
            for row in rows:
                spj = self._load_spj(connection, row["spj_id"])
                if spj is not None:
                    self._spj[spj.spj_id] = spj

    def _save(self) -> None:  # kept for API compat; SQLite persists per mutation
        self._reload_cache()

    # -- public API (transactional, multi-process safe) -----------------------

    @staticmethod
    def _validate_stop(stop: dict, position: int) -> None:
        """Field-level stop validation for composed creates (#60)."""
        for field in ("name", "kecamatan", "address"):
            value = stop.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"stops[{position}].{field} is required")
        for field in ("lat", "lng"):
            try:
                number = float(stop.get(field))
            except (TypeError, ValueError):
                raise ValueError(
                    f"stops[{position}].{field} must be a number") from None
            if not (-90.0 <= number <= 90.0 if field == "lat"
                    else -180.0 <= number <= 180.0):
                raise ValueError(
                    f"stops[{position}].{field}={number} out of range")

    def create_with_stops(self, driver_name: str, truck_code: str,
                          destination: str, weigh_on_site: bool, priority: str,
                          note: str, stops: list[dict],
                          created_by: str = "admin") -> Spj:
        """Create a draft SPJ and ALL of its stops in ONE transaction (#60).

        Either the SPJ exists with every stop in exact order, or nothing
        is persisted — a failing stop rolls the whole draft back.
        """
        if destination not in DESTINATIONS:
            raise ValueError(f"destination must be one of {DESTINATIONS}")
        if priority not in ("normal", "vip"):
            raise ValueError("priority must be 'normal' or 'vip'")
        if not isinstance(stops, list):
            raise ValueError("stops must be a list")
        seen_names: set[str] = set()
        for position, stop in enumerate(stops):
            self._validate_stop(stop, position)
            name = stop["name"].strip()
            if name in seen_names:
                raise ValueError(
                    f"stops[{position}].name '{name}' duplicates an earlier stop")
            seen_names.add(name)
        with self._lock:
            for _attempt in range(20):
                spj_id = uuid4().hex[:12]
                now = _utc_now()
                spj = None
                connection = self._connect()
                connection.isolation_level = None
                try:
                    with closing(connection):
                        connection.execute("BEGIN IMMEDIATE")
                        number = next_spj_number(self)
                        try:
                            connection.execute(
                                "INSERT INTO spj (spj_id, spj_number, date, driver_name, "
                                "truck_code, destination, weigh_on_site, priority, note, "
                                "status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                (spj_id, number, _today(), driver_name, truck_code,
                                 destination, int(bool(weigh_on_site)), priority, note,
                                 "draft", created_by, now),
                            )
                            for idx, stop in enumerate(stops):
                                connection.execute(
                                    "INSERT INTO spj_stops (spj_id, idx, name, kecamatan, "
                                    "address, lat, lng, location_type, status) "
                                    "VALUES (?,?,?,?,?,?,?,?,?)",
                                    (spj_id, idx, stop["name"].strip(),
                                     stop["kecamatan"].strip(),
                                     stop["address"].strip(),
                                     float(stop["lat"]), float(stop["lng"]),
                                     stop.get("location_type",
                                              "Pemukiman Kelas Menengah"),
                                     "pending"),
                                )
                            connection.execute("COMMIT")
                        except sqlite3.IntegrityError:
                            connection.execute("ROLLBACK")
                            continue  # daily-number race: retry
                        spj = self._load_spj(connection, spj_id)
                except sqlite3.OperationalError:
                    raise
                if spj is not None:
                    self._spj[spj_id] = spj
                    return spj
            raise RuntimeError("SPJ create failed after repeated number conflicts")
    def create(self, driver_name: str, truck_code: str, destination: str,
               weigh_on_site: bool, priority: str, note: str,
               created_by: str = "admin") -> Spj:
        if destination not in DESTINATIONS:
            raise ValueError(f"destination must be one of {DESTINATIONS}")
        if priority not in ("normal", "vip"):
            raise ValueError("priority must be 'normal' or 'vip'")
        with self._lock:
            for _attempt in range(20):
                spj_id = uuid4().hex[:12]
                now = _utc_now()
                spj = None
                connection = self._connect()
                connection.isolation_level = None  # explicit transactions
                try:
                    with closing(connection):
                        connection.execute("BEGIN IMMEDIATE")
                        number = next_spj_number(self)
                        try:
                            connection.execute(
                                "INSERT INTO spj (spj_id, spj_number, date, driver_name, "
                                "truck_code, destination, weigh_on_site, priority, note, "
                                "status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                (spj_id, number, _today(), driver_name, truck_code,
                                 destination, int(bool(weigh_on_site)), priority, note,
                                 "draft", created_by, now),
                            )
                            connection.execute("COMMIT")
                        except sqlite3.IntegrityError:
                            connection.execute("ROLLBACK")
                            continue  # daily-number race: retry with a fresh number
                        spj = self._load_spj(connection, spj_id)
                except sqlite3.OperationalError:
                    raise
                if spj is not None:
                    self._spj[spj_id] = spj
                    return spj
            raise RuntimeError("SPJ create failed after repeated number conflicts")

    def get(self, spj_id: str) -> Spj | None:
        with self._lock:
            return self._spj.get(spj_id)

    def list(self, status: str | None = None) -> list[Spj]:
        """Newest first, so a client can rely on position instead of guessing.

        Ordering by created_at descending is part of the contract: the driver
        app picks the newest receipt-pending SPJ from this response.
        """
        with self._lock:
            items = list(self._spj.values())
        items.sort(key=lambda s: (s.created_at, s.spj_number), reverse=True)
        if status is None:
            return items
        return [s for s in items if s.status == status]

    def active_for_truck(self, truck_code: str) -> Spj | None:
        with self._lock:
            for spj in self._spj.values():
                if spj.truck_code == truck_code and spj.status == "aktif":
                    return spj
        return None

    def _mutate(self, spj_id: str, mutate_fn) -> Spj:
        """Run mutate_fn(connection, row) inside BEGIN IMMEDIATE, then reload."""
        with self._lock:
            connection = self._connect()
            connection.isolation_level = None
            try:
                with closing(connection):
                    connection.execute("BEGIN IMMEDIATE")
                    try:
                        mutate_fn(connection)
                    except Exception:
                        connection.execute("ROLLBACK")
                        raise
                    else:
                        connection.execute("COMMIT")
            except sqlite3.OperationalError:
                raise
            spj = self._load_fresh(spj_id)
            self._spj[spj_id] = spj
            return spj

    def _fetch_status(self, connection: sqlite3.Connection, spj_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM spj WHERE spj_id=?", (spj_id,)).fetchone()
        if row is None:
            raise ValueError(f"SPJ {spj_id} not found")
        return row

    def add_stop(self, spj_id: str, name: str, kecamatan: str, address: str,
                 lat: float, lng: float,
                 location_type: str = "Pemukiman Kelas Menengah") -> Spj:
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "draft":
                raise ValueError("stops can only be added to a draft SPJ")
            idx = connection.execute(
                "SELECT COALESCE(MAX(idx)+1, 0) FROM spj_stops WHERE spj_id=?",
                (spj_id,)).fetchone()[0]
            connection.execute(
                "INSERT INTO spj_stops (spj_id, idx, name, kecamatan, address, "
                "lat, lng, location_type, status) VALUES (?,?,?,?,?,?,?,?,?)",
                (spj_id, idx, name, kecamatan, address, lat, lng,
                 location_type, "pending"),
            )
        return self._mutate(spj_id, mutate)

    def activate(self, spj_id: str) -> Spj:
        """Activate after resolving road-following compliance geometry (#58).

        Every leg (stops in order + destination) is resolved via OSRM
        BEFORE the status flips. A degraded (straight-line) result FAILS
        activation visibly — it is never silently promoted as ground
        truth — unless JWIS_SPJ_STRAIGHT_FALLBACK=on, in which case the
        fallback is recorded in the audit trail.
        """
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "draft":
                raise ValueError(f"cannot activate SPJ in status '{row['status']}'")
            stop_count = connection.execute(
                "SELECT COUNT(*) FROM spj_stops WHERE spj_id=?", (spj_id,)).fetchone()[0]
            if stop_count < 1:
                raise ValueError("SPJ needs at least one stop before activation")
            active = connection.execute(
                "SELECT spj_id FROM spj WHERE truck_code=? AND status='aktif'",
                (row["truck_code"],)).fetchone()
            if active is not None:
                raise ValueError(f"truck {row['truck_code']} already has an active SPJ")

            # #58: resolve road-following geometry for the whole path.
            stops = connection.execute(
                "SELECT lat, lng FROM spj_stops WHERE spj_id=? ORDER BY idx",
                (spj_id,)).fetchall()
            waypoints = [(s["lat"], s["lng"]) for s in stops]
            dest = route_ground_truth(row["destination"])
            if dest is None:
                raise ValueError(
                    f"cannot activate: destination '{row['destination']}' has "
                    "no verified ground-truth coordinate (#59); refusing to "
                    "route compliance through a guessed point")
            if not waypoints or waypoints[-1] != dest:
                waypoints.append(dest)
            route = road_route(waypoints) if len(waypoints) >= 2 else {
                "geometry": [{"lat": la, "lng": ln} for la, ln in waypoints],
                "source": "LIVE_EXTERNAL", "distance_km": 0.0, "duration_min": 0,
            }
            source = route.get("source", "FALLBACK_DEGRADED")
            if source == "FALLBACK_DEGRADED":
                if os.getenv("JWIS_SPJ_STRAIGHT_FALLBACK", "off").lower() != "on":
                    raise ValueError(
                        "cannot activate: road-following geometry could not be "
                        "resolved (routing service unavailable); refusing to "
                        "promote a straight-line path as ground truth")
                self._audit(
                    connection, spj_id, "straight_fallback", row["created_by"],
                    reason="JWIS_SPJ_STRAIGHT_FALLBACK=on: activated with "
                           "unresolved road geometry",
                    payload={"source": source})
            geometry = [(p["lat"], p["lng"]) for p in route.get("geometry", [])]
            now = _utc_now()
            connection.execute(
                "UPDATE spj SET status='aktif', activated_at=?, route_geometry=?, "
                "route_source=?, route_resolved_at=? WHERE spj_id=?",
                (now, json.dumps(geometry), source, now, spj_id))
            self._audit(connection, spj_id, "activate", row["created_by"],
                        payload={"route_source": source,
                                 "route_points": len(geometry)})
        return self._mutate(spj_id, mutate)

    def complete_stop(self, spj_id: str, index: int,
                      evidence: dict | None = None,
                      override: dict | None = None,
                      actor: str | None = None) -> Spj:
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "aktif":
                raise ValueError("stops can only be completed on an active SPJ")
            stops = connection.execute(
                "SELECT idx, status FROM spj_stops WHERE spj_id=? ORDER BY idx",
                (spj_id,)).fetchall()
            if not 0 <= index < len(stops):
                raise ValueError(f"stop index {index} out of range")
            if stops[index]["status"] == "completed":
                return  # idempotent
            # #55 (PR #90): route order is a server-side invariant — a
            # stop cannot complete while an earlier stop is still open.
            earlier_open = [s["idx"] for s in stops[:index]
                            if s["status"] != "completed"]
            if earlier_open and override is None:
                raise ValueError(
                    f"stop {index} cannot complete before earlier stop(s) "
                    f"{earlier_open}; route order is a server-side invariant")
            if evidence is None:
                if override is None:
                    raise ValueError(
                        "stop completion requires field evidence "
                        "(arrival, weighing, officer)")
                # Audited supervisor override closing this stop without
                # evidence (PR #90 #63): reason >= 10 chars, actor named.
                checked = _validate_override(override, actor or row["created_by"])
                connection.execute(
                    "UPDATE spj_stops SET status='completed', completed_at=?, "
                    "override=? WHERE spj_id=? AND idx=?",
                    (_utc_now(), json.dumps(checked), spj_id, index))
                self._audit(connection, spj_id, "override", checked["actor"],
                            checked["reason"], payload={"stop_index": index})
            else:
                _validate_evidence(evidence)
                connection.execute(
                    "UPDATE spj_stops SET status='completed', completed_at=?, "
                    "evidence=? WHERE spj_id=? AND idx=?",
                    (_utc_now(), json.dumps(evidence), spj_id, index))
                self._audit(connection, spj_id, "complete_stop",
                            row["created_by"], payload={"stop_index": index})
            pending = connection.execute(
                "SELECT COUNT(*) FROM spj_stops WHERE spj_id=? "
                "AND status != 'completed'", (spj_id,)).fetchone()[0]
            if pending == 0:
                connection.execute(
                    "UPDATE spj SET status='selesai', completed_at=? WHERE spj_id=?",
                    (_utc_now(), spj_id))
        return self._mutate(spj_id, mutate)

    def record_receipt(self, spj_id: str, photo_name: str, photo_b64: str,
                       total_weight_kg: float | None, weight_source: str,
                       submitted_by: str = "driver",
                       operation_id: str | None = None) -> Spj:
        """Attach the weighbridge receipt exactly once.

        The photo lives in its own table: the SPJ cache reloads every record
        on mutation, and a multi-megabyte image must not ride along.

        `total_weight_kg` is optional — not every handover is weighed — but a
        supplied value must be a finite 0 < w <= MAX_STOP_WEIGHT_KG, the same
        bound the API and the stop evidence schema enforce.

        Retrying with the same operation_id returns the original receipt
        unchanged; a different submission for an SPJ that already has one is
        a conflict rather than a silent overwrite of handover evidence.
        """
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "selesai":
                raise ValueError("receipt can only be submitted after the SPJ is selesai")
            if not photo_name.strip() or not photo_b64.strip():
                raise ValueError("receipt photo_name and photo_b64 are required")
            if total_weight_kg is not None and not (
                    0 < total_weight_kg <= MAX_STOP_WEIGHT_KG):
                raise ValueError(
                    f"total_weight_kg must be 0 < w <= {MAX_STOP_WEIGHT_KG}")
            existing = connection.execute(
                "SELECT * FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone()
            if existing is not None:
                if operation_id and existing["operation_id"] == operation_id:
                    return  # client retry of an accepted submission
                raise ValueError("receipt already submitted")
            connection.execute(
                "INSERT INTO spj_receipts (spj_id, photo_name, photo_b64, "
                "total_weight_kg, weight_source, submitted_by, operation_id, "
                "recorded_at) VALUES (?,?,?,?,?,?,?,?)",
                (spj_id, photo_name, photo_b64, total_weight_kg, weight_source,
                 submitted_by, operation_id, _utc_now()))
            self._audit(connection, spj_id, "receipt", submitted_by,
                        payload={"total_weight_kg": total_weight_kg,
                                 "weight_source": weight_source,
                                 "photo_name": photo_name,
                                 "operation_id": operation_id})
        return self._mutate(spj_id, mutate)

    def receipt_photo(self, spj_id: str) -> str | None:
        """Receipt image bytes, read only when a detail view asks for them."""
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT photo_b64 FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone()
        return row["photo_b64"] if row else None

    def complete(self, spj_id: str, override: dict | None = None,
                 actor: str | None = None) -> Spj:
        """Close an active SPJ.

        Normal completion requires every stop to be completed WITH field
        evidence — the same invariant the driver workflow enforces. A
        supervisor override ({"actor": ..., "reason": ...}) forces closure,
        is recorded in the audit trail AND on each stop it closed, so the
        compliance score can distinguish a supervisor decision from a
        driver's missing evidence (reason >= 10 chars, PR #90 #63).
        """
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "aktif":
                raise ValueError(f"cannot complete SPJ in status '{row['status']}'")
            unevidenced = connection.execute(
                "SELECT COUNT(*) FROM spj_stops WHERE spj_id=? "
                "AND (status != 'completed' OR evidence IS NULL)",
                (spj_id,)).fetchone()[0]
            checked = None
            if unevidenced:
                if override is None:
                    raise ValueError(
                        f"cannot complete: {unevidenced} stop(s) lack field evidence; "
                        "a supervisor override with a reason is required")
                checked = _validate_override(override, actor or row["created_by"])
            now = _utc_now()
            if checked is not None:
                # Mark the forced stops so compliance reports (not charges)
                # them as supervisor decisions.
                connection.execute(
                    "UPDATE spj_stops SET status='completed', completed_at=? "
                    "WHERE spj_id=? AND status != 'completed'", (now, spj_id))
                connection.execute(
                    "UPDATE spj_stops SET override=? WHERE spj_id=? "
                    "AND evidence IS NULL",
                    (json.dumps(checked), spj_id))
            else:
                connection.execute(
                    "UPDATE spj_stops SET status='completed', completed_at=? "
                    "WHERE spj_id=? AND status != 'completed'", (now, spj_id))
            connection.execute(
                "UPDATE spj SET status='selesai', completed_at=? WHERE spj_id=?",
                (now, spj_id))
            if checked is not None:
                self._audit(connection, spj_id, "override", checked["actor"],
                            checked["reason"],
                            payload={"forced_stops": unevidenced})
            else:
                self._audit(connection, spj_id, "complete", row["created_by"])
        return self._mutate(spj_id, mutate)

    def cancel(self, spj_id: str) -> Spj:
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] not in ("draft", "aktif"):
                raise ValueError(f"cannot cancel SPJ in status '{row['status']}'")
            connection.execute("UPDATE spj SET status='batal' WHERE spj_id=?", (spj_id,))
            self._audit(connection, spj_id, "cancel", row["created_by"])
        return self._mutate(spj_id, mutate)

    def _load_fresh(self, spj_id: str) -> Spj:
        with closing(self._connect()) as connection:
            spj = self._load_spj(connection, spj_id)
        if spj is None:
            raise ValueError(f"SPJ {spj_id} not found")
        return spj

    def _commit(self, spj: Spj) -> Spj:
        """Write a record without invariant checks (legacy test fixtures).

        Only for reproducing pre-migration record shapes that no public
        transition can produce any more; never call this from request paths.
        """
        def mutate(connection):
            row = connection.execute(
                "SELECT status FROM spj WHERE spj_id=?",
                (spj.spj_id,)).fetchone()
            if row is None:
                raise ValueError(f"SPJ {spj.spj_id} not found")
            connection.execute(
                "UPDATE spj SET status=?, completed_at=? WHERE spj_id=?",
                (spj.status, spj.completed_at, spj.spj_id))
            for idx, stop in enumerate(spj.stops):
                connection.execute(
                    "UPDATE spj_stops SET status=?, completed_at=? "
                    "WHERE spj_id=? AND idx=?",
                    (stop.status, stop.completed_at, spj.spj_id, idx))
        with self._lock:
            connection = self._connect()
            connection.isolation_level = None
            try:
                with closing(connection):
                    connection.execute("BEGIN IMMEDIATE")
                    try:
                        mutate(connection)
                    except Exception:
                        connection.execute("ROLLBACK")
                        raise
                    else:
                        connection.execute("COMMIT")
            except sqlite3.OperationalError:
                raise
            fresh = self._load_fresh(spj.spj_id)
            self._spj[spj.spj_id] = fresh
            return fresh



def spj_polyline(spj: Spj) -> list[tuple[float, float]] | None:
    """Compliance polyline: the road-following geometry resolved at
    activation (#58), falling back to stop-to-stop straight segments only
    for legacy SPJs activated before road resolution existed.

    Returns None when the destination has no verified ground-truth
    coordinate (#59) — the caller falls back to the corridor instead of
    promoting a guessed point.
    """
    if getattr(spj, "route_geometry", None):
        return list(spj.route_geometry)
    dest = route_ground_truth(spj.destination)
    if dest is None:
        return None  # unverified destination (#59): never guess
    points: list[tuple[float, float]] = []
    for stop in spj.stops:
        pt = (stop.lat, stop.lng)
        if not points or points[-1] != pt:
            points.append(pt)
    if not points or points[-1] != dest:
        points.append(dest)
    return points


def active_path_for(truck_code: str) -> list[tuple[float, float]] | None:
    try:
        spj = SPJ_STORE.active_for_truck(truck_code)
        if spj is None:
            return None
        line = spj_polyline(spj)
        if line is None:
            logger.warning(
                "active SPJ %s for %s has no verified destination coordinate "
                "(%s); falling back to the corridor reference path",
                spj.spj_id, truck_code, spj.destination)
            return None
        if len(line) < 2:
            return None
        return line
    except Exception:  # noqa: BLE001
        logger.exception("active_path_for(%s) failed; using corridor fallback",
                         truck_code)
        return None


def destination_provenance(destination: str) -> dict:
    """Provenance record for one destination (surfaced by the API)."""
    return provenance_payload(destination)


def _maybe_seed(store: SpjStore) -> None:
    if len(store.list()) > 0 or os.getenv("JWIS_SPJ_SEED", "on") == "off":
        return
    seed = store.create(
        driver_name="Joko Wijaya", truck_code="T-088",
        destination="TPST Bantargebang", weigh_on_site=True,
        priority="normal", note="Seed demo SPJ", created_by="seed")
    for name, kec, addr, lat, lng in [
        ("APARTEMEN ICON - PPPSRS", "Kebayoran Lama",
         "Jl. Ciledug Raya No 35, Cipulir", -6.2379, 106.7826),
        ("APARTEMENT BONA VISTA - PPPSRS", "Cilandak",
         "Bona Vista Raya", -6.2917, 106.7975),
        ("APT PERMATA SURYA", "Kalideres",
         "Jl. Boulevard Raya, Taman Surya 5, Pegadungan", -6.1590, 106.7160),
    ]:
        store.add_stop(seed.spj_id, name=name, kecamatan=kec, address=addr,
                       lat=lat, lng=lng)
    store.activate(seed.spj_id)


def _init_store() -> SpjStore:
    store = SpjStore()
    _maybe_seed(store)
    return store


SPJ_STORE = _init_store()
