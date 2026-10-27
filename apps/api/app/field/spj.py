"""SPJ (Surat Perintah Jalan) engine — work orders as route ground truth.

An active SPJ becomes the truck's assigned reference path: the existing
deviation detector (rule 500m + IsolationForest + hysteresis) then measures
compliance against the SPJ stops without any change to detection logic.

Records live in the shared durable store (SQLite, see app.core.storage), so several
API workers read one consistent state and a mutation is only acknowledged once
it has committed. Field evidence is a precondition of normal completion; the
exceptional supervisor path is explicit, permission-gated, reasoned and
audited.
"""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import threading
from contextlib import closing
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from uuid import uuid4

from app.core.env import getenv, local_today
from app.core.errors import CodedError
from app.fleet.facilities import provenance_payload, route_ground_truth
from app.fleet.osrm import road_route

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
# gsc P0-3: a DEMO stop is placed at the operator's own phone position so a
# stop can be completed live wherever the demo runs. It is stored with this
# location_type and a DEMO-prefixed name, so it is never mistaken for an
# operational TPS; only its arrival geotag is exempt from the Jakarta range.
DEMO_LOCATION_TYPE = "DEMO"
WORLD_LAT_RANGE = (-90.0, 90.0)
WORLD_LNG_RANGE = (-180.0, 180.0)

# The weighbridge-ticket OCR runs on the reviewer's side: its reading is a
# labelled suggestion beside the receipt and never becomes a recorded weight
# until a dispatcher or supervisor confirms or corrects it.
RECEIPT_OCR_CLASSIFICATION = "MODEL_OUTPUT"
RECEIPT_OCR_LABEL = "MODEL OUTPUT: weighbridge-ticket OCR suggestion, not a recorded weight"
RECEIPT_OCR_REVIEWED = ("confirmed", "corrected")
RECEIPT_OCR_TICKET_FIELDS = ("ticket_no", "plate", "weighed_in_at", "weighed_out_at", "site", "document")


def receipt_ocr_record(status: str, reason: str | None = None, result: dict | None = None) -> dict:
    """The stored OCR block: status pending | unavailable | unreviewed (| confirmed | corrected).

    ``result`` is the timbangan OCR answer. Every ticket field it could not read
    stays null rather than being guessed; ``gross_kg`` falls back to the older
    single ``weight_kg`` reading. ``document`` says what the photo showed
    (weighbridge_ticket | scale_display | not_a_ticket | unreadable).
    """
    result = result or {}
    gross = result.get("gross_kg")
    return {
        "gross_kg": gross if gross is not None else result.get("weight_kg"),
        "tare_kg": result.get("tare_kg"),
        "net_kg": result.get("net_kg"),
        **{key: result.get(key) for key in RECEIPT_OCR_TICKET_FIELDS},
        "confidence": result.get("confidence"),
        "source": result.get("source"),
        "classification": RECEIPT_OCR_CLASSIFICATION,
        "label": RECEIPT_OCR_LABEL,
        "status": status,
        "reason": reason,
        "read_at": _utc_now() if result else None,
        "reviewed_by": None,
        "reviewed_at": None,
    }


def normalize_ticket_no(value) -> str | None:
    """A weighbridge ticket number compared on letters and digits only, upper-cased."""
    if not isinstance(value, str | int):
        return None
    return "".join(ch for ch in str(value).upper() if ch.isalnum()) or None


def demo_stop_name(name: str) -> str:
    name = name.strip()
    return name if name.upper().startswith("DEMO") else f"DEMO · {name}"


def _reject_spoofed_demo(location_type, demo: bool, field: str) -> None:
    # The DEMO exemptions (world-wide geotag, straight-line activation, no
    # deviation alert) follow the stored location_type, so only demo=true may set it.
    if not demo and isinstance(location_type, str) and location_type.strip().upper() == DEMO_LOCATION_TYPE:
        raise ValueError(f"{field}='{DEMO_LOCATION_TYPE}' is reserved; send demo=true for a DEMO stop")


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
            f"evidence.{field}={number} is outside the Jakarta operational region [{rng[0]}, {rng[1]}]"
        )


TABLE = "pythia_spj"

# Gap 3: an arrival geotag farther than this from its stop is flagged for review.
GEOTAG_REVIEW_DISTANCE_M = 150.0
APPROX_GEOTAG_LABEL = "Approximate, not GPS"


def evidence_photo_slots(evidence: dict):
    """(slot, record) for every photo-bearing record in stop evidence."""
    arrival = evidence.get("arrival")
    if isinstance(arrival, dict):
        yield "arrival", arrival
    for i, entry in enumerate(evidence.get("weighing") or []):
        if isinstance(entry, dict):
            yield f"weighing-{i}", entry
    officer = evidence.get("officer")
    if isinstance(officer, dict):
        yield "officer", officer


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    from math import asin, cos, radians, sin, sqrt

    dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return 2 * 6_371_000.0 * asin(sqrt(a))


def arrival_geotag(stop) -> dict | None:
    """How trustworthy the arrival position is (gap 3, honesty label H1).

    ``status`` is ``gps`` for a device fix, ``approx`` when the phone had no fix and
    the app stored the stop's own coordinates (``approx: true``): such a position
    proves nothing and carries the label "Approximate, not GPS". ``distance_to_stop_m``
    is the straight-line distance from the stop; a GPS fix farther than
    GEOTAG_REVIEW_DISTANCE_M is ``flagged``.
    """
    arrival = (stop.evidence or {}).get("arrival")
    if not isinstance(arrival, dict):
        return None
    try:
        lat, lng = float(arrival.get("lat")), float(arrival.get("lng"))
    except (TypeError, ValueError):
        return {"status": "missing", "label": "No position recorded", "flagged": True}
    approx = bool(arrival.get("approx"))
    distance = round(_haversine_m(lat, lng, stop.lat, stop.lng), 1)
    accuracy = arrival.get("accuracy_m")
    return {
        "status": "approx" if approx else "gps",
        "label": APPROX_GEOTAG_LABEL if approx else "GPS",
        "lat": lat,
        "lng": lng,
        "accuracy_m": accuracy if isinstance(accuracy, (int, float)) else None,
        "distance_to_stop_m": distance,
        "source": arrival.get("source") or "camera",
        "flagged": approx or distance > GEOTAG_REVIEW_DISTANCE_M,
    }


def _validate_evidence(evidence: dict, demo: bool = False, weigh_on_site: bool = False) -> None:
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
    _require_coord(arrival.get("lat"), "arrival.lat", WORLD_LAT_RANGE if demo else JAKARTA_LAT_RANGE)
    _require_coord(arrival.get("lng"), "arrival.lng", WORLD_LNG_RANGE if demo else JAKARTA_LNG_RANGE)

    weighing = evidence.get("weighing")
    if weighing is None:
        weighing = []
    if not isinstance(weighing, list):
        raise ValueError("evidence.weighing must be a list")
    # Weighing is part of a stop only when the SPJ orders on-site weighing.
    if weigh_on_site and not weighing:
        raise ValueError(
            "evidence.weighing is required: this work order orders on-site weighing (weigh_on_site); "
            "add at least one weighing entry"
        )
    for i, entry in enumerate(weighing):
        if not isinstance(entry, dict):
            raise ValueError(f"evidence.weighing[{i}] must be an object")
        if entry.get("fraction") not in SUPPORTED_FRACTIONS:
            raise ValueError(f"evidence.weighing[{i}].fraction must be one of {SUPPORTED_FRACTIONS}")
        try:
            weight = float(entry.get("weight_kg"))
        except (TypeError, ValueError):
            raise ValueError(f"evidence.weighing[{i}].weight_kg is required") from None
        if not (0 < weight <= MAX_STOP_WEIGHT_KG):
            raise ValueError(
                f"evidence.weighing[{i}].weight_kg={weight} must be 0 < w <= {MAX_STOP_WEIGHT_KG}"
            )
        _require_photo(entry.get("photo_name"), f"weighing[{i}].photo_name")
        _require_photo(entry.get("photo_b64"), f"weighing[{i}].photo_b64")

    officer = evidence.get("officer") or {}
    if not isinstance(officer, dict):
        raise ValueError("evidence.officer is required")
    _require_text(officer.get("name"), "officer.name")
    _require_photo(officer.get("photo_name"), "officer.photo_name")
    _require_photo(officer.get("photo_b64"), "officer.photo_b64")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


# The audit trail is an append-only hash chain per SPJ: each row carries the
# previous row's digest (``prev_sha256``; the first sealed row uses this all-zero
# sentinel) and its own (``entry_sha256``, over the canonical JSON of the row's
# fields plus ``prev_sha256``). Editing or deleting a row in the middle breaks the
# chain, which SpjStore.verify reports instead of hiding.
SEAL_SENTINEL = "sha256:" + "0" * 64


def _sha256_field(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _canonical(entry: dict) -> bytes:
    """Sorted keys, no whitespace, no NaN: the bytes ``entry_sha256`` is taken over."""
    return json.dumps(
        entry, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def audit_entry_digest(
    spj_id: str, action: str, actor: str, reason: str, payload: str, created_at: str, prev_sha256: str
) -> str:
    """Digest of one audit row; ``payload`` is the JSON text exactly as stored."""
    return _sha256_field(
        _canonical(
            {
                "spj_id": spj_id,
                "action": action,
                "actor": actor,
                "reason": reason,
                "payload": payload,
                "created_at": created_at,
                "prev_sha256": prev_sha256,
            }
        )
    )


# Problems that mean the chain itself does not verify (the receipt ones compare data to it).
_CHAIN_PROBLEMS = ("unsealed_entry", "chain_broken", "entry_digest_mismatch", "payload_unreadable")


def _same_weight(stored, sealed) -> bool:
    if stored is None or sealed is None:
        return stored is None and sealed is None
    return abs(float(stored) - float(sealed)) < 1e-6


def photo_sha256(photo_b64: str) -> str:
    """Digest of the decoded photo bytes (a data URL or bare base64); the raw string if not base64."""
    _header, sep, data = photo_b64.partition(",")
    data = (data if sep else photo_b64).strip()
    try:
        raw = base64.b64decode(data + "=" * (-len(data) % 4), validate=True)
    except (binascii.Error, ValueError):
        raw = photo_b64.encode("utf-8")
    return _sha256_field(raw)


def _today() -> str:
    """The SPJ working day: Asia/Jakarta (or PYTHIA_DEMO_DATE), never the UTC date."""
    return local_today().isoformat()


def _validate_override(override: dict | None, actor: str | None) -> dict:
    """An override must name who authorized it and why — never a bare bypass."""
    if not isinstance(override, dict):
        raise ValueError(
            "closing a stop without field evidence requires a supervisor override object with a reason"
        )
    reason = str(override.get("reason") or "").strip()
    if len(reason) < 10:
        raise ValueError(
            "a supervisor override without field evidence requires a reason of at least 10 characters"
        )
    who = str(override.get("actor") or actor or "").strip()
    if not who:
        raise ValueError("supervisor override requires the authorizing actor")
    return {"reason": reason, "actor": who, "at": _utc_now(), "documents": override.get("documents") or None}


def spj_summary_payload(spj: Spj) -> dict:
    """List projection: stop evidence, the receipt photo and the route geometry stay out.

    Receipt metadata is small and drives the driver's pending-receipt task.
    The road geometry is hundreds of points per SPJ; clients that draw it read
    /api/spj/active-path/{truck_code}. ``route_point_count`` says how many there are.
    """
    payload = {key: value for key, value in vars(spj).items() if key not in ("stops", "route_geometry")}
    payload["route_point_count"] = len(spj.route_geometry or [])
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
                "total_weight_kg": round(sum(float(w.get("weight_kg") or 0) for w in weighing), 1),
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
    status: str = "pending"  # pending | completed | skipped (dispatch decided not to collect)
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
    route_source: str | None = None  # LIVE_EXTERNAL | FALLBACK_DEGRADED
    route_resolved_at: str | None = None
    receipt: dict | None = None


def next_spj_number(store: SpjStore, day: str | None = None) -> str:
    """Next daily sequence number, read from the database (not the cache).

    Reading from SQLite is what makes the number multi-process safe: every
    worker sees committed numbers from other workers. ``day`` (ISO date) is the
    SPJ's working day; it defaults to today (WIB).
    """
    prefix = (date.fromisoformat(day) if day else local_today()).strftime("DLH-DKI/SPJ/%d-%m-%Y/")
    with closing(store._connect()) as connection:
        row = connection.execute(
            "SELECT MAX(CAST(SUBSTR(spj_number, ?) AS INTEGER)) AS max_seq FROM spj WHERE spj_number LIKE ?",
            (len(prefix) + 1, prefix + "%"),
        ).fetchone()
    max_seq = row["max_seq"] or 0
    return f"{prefix}{max_seq + 1:06d}"


def _default_persist_path() -> str:
    db_path = getenv("DB_PATH")
    if db_path:
        return os.path.join(os.path.dirname(db_path), "pythia_spj.db")
    return os.path.join(tempfile.gettempdir(), "pythia_spj.db")


class SpjStore:
    """SQLite-backed SPJ store, safe across worker processes.

    Every mutation runs inside one SQLite transaction (BEGIN IMMEDIATE),
    so concurrent workers serialize on the database itself rather than an
    in-process lock. The daily spj_number is allocated inside the same
    transaction as the INSERT, guarded by a UNIQUE constraint; a conflict
    retries with a fresh number.
    """

    _BUSY_TIMEOUT_MS = 10_000

    def __init__(self, persist_path: str | None = None, db_path: str | None = None) -> None:
        # db_path is the PR #90 keyword alias for the same path.
        self._path = persist_path or db_path or _default_persist_path()
        self._spj: dict[str, Spj] = {}  # read cache; SQLite is the source of truth
        self._lock = threading.RLock()
        self._init_schema()
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
                columns = {r["name"] for r in connection.execute("PRAGMA table_info(spj)").fetchall()}
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
                stop_columns = {
                    r["name"] for r in connection.execute("PRAGMA table_info(spj_stops)").fetchall()
                }
                if "override" not in stop_columns:
                    connection.execute("ALTER TABLE spj_stops ADD COLUMN override TEXT")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS spj_receipts (
                        spj_id TEXT PRIMARY KEY REFERENCES spj(spj_id) ON DELETE CASCADE,
                        photo_name TEXT NOT NULL,
                        photo_b64 TEXT NOT NULL,
                        total_weight_kg REAL,
                        gross_weight_kg REAL,
                        tare_weight_kg REAL,
                        net_weight_kg REAL,
                        weight_source TEXT NOT NULL,
                        submitted_by TEXT NOT NULL,
                        operation_id TEXT,
                        recorded_at TEXT NOT NULL,
                        ocr TEXT
                    )
                    """
                )
                # Gap 8: evidence photos live in their own table, numbered per SPJ
                # (n = 1, 2, ...), so the SPJ cache and every JSON read stay small.
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS spj_evidence_photos (
                        spj_id TEXT NOT NULL REFERENCES spj(spj_id) ON DELETE CASCADE,
                        n INTEGER NOT NULL,
                        stop_idx INTEGER NOT NULL,
                        slot TEXT NOT NULL,
                        photo_name TEXT NOT NULL,
                        photo_b64 TEXT NOT NULL,
                        recorded_at TEXT NOT NULL,
                        PRIMARY KEY (spj_id, n)
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
                        created_at TEXT NOT NULL,
                        prev_sha256 TEXT,
                        entry_sha256 TEXT
                    )
                    """
                )
                self._migrate_audit_seal(connection)
                self._migrate_receipt_columns(connection)
                self._migrate_inline_photos(connection)

    @staticmethod
    def _migrate_audit_seal(connection: sqlite3.Connection) -> None:
        """Existing databases gain the seal columns; rows written before stay unsealed (legacy).

        ``spj_audit_seal`` remembers the first audit id written with sealing on, so
        a row from then on with its digests wiped cannot pass as a legacy row.
        """
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(spj_audit)")}
        for col in ("prev_sha256", "entry_sha256"):
            if col not in columns:
                try:
                    connection.execute(f"ALTER TABLE spj_audit ADD COLUMN {col} TEXT")
                except sqlite3.OperationalError as exc:
                    # Another worker opening the same old database added it first.
                    if "duplicate column" not in str(exc):
                        raise
        connection.execute("CREATE TABLE IF NOT EXISTS spj_audit_seal (sealed_from_id INTEGER NOT NULL)")
        connection.execute(
            "INSERT INTO spj_audit_seal (sealed_from_id) SELECT COALESCE(MAX(id), 0) + 1 FROM spj_audit "
            "WHERE NOT EXISTS (SELECT 1 FROM spj_audit_seal)"
        )

    @staticmethod
    def _migrate_receipt_columns(connection: sqlite3.Connection) -> None:
        """Add columns introduced after a database was first created."""
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(spj_receipts)")}
        if columns and "operation_id" not in columns:
            connection.execute("ALTER TABLE spj_receipts ADD COLUMN operation_id TEXT")
        # H10: the weighbridge weighs the loaded truck (gross); net = gross - tare.
        # ocr: the reviewer-side OCR suggestion (JSON), kept apart from the weights.
        for col, kind in (
            ("gross_weight_kg", "REAL"),
            ("tare_weight_kg", "REAL"),
            ("net_weight_kg", "REAL"),
            ("ocr", "TEXT"),
        ):
            if columns and col not in columns:
                try:
                    connection.execute(f"ALTER TABLE spj_receipts ADD COLUMN {col} {kind}")
                except sqlite3.OperationalError as exc:
                    # Another worker opening the same old database added it first.
                    if "duplicate column" not in str(exc):
                        raise

    @classmethod
    def _migrate_inline_photos(cls, connection: sqlite3.Connection) -> None:
        """Move base64 photos still embedded in stop evidence into spj_evidence_photos.

        Databases written before gap 8 kept every photo inside spj_stops.evidence;
        after this runs once, no evidence row carries photo bytes.
        """
        rows = connection.execute(
            "SELECT spj_id, idx, evidence FROM spj_stops WHERE evidence LIKE '%photo_b64%' ORDER BY spj_id, idx"
        ).fetchall()
        for row in rows:
            try:
                evidence = json.loads(row["evidence"])
            except (TypeError, ValueError):
                continue
            stored = cls._store_photos(connection, row["spj_id"], row["idx"], evidence)
            connection.execute(
                "UPDATE spj_stops SET evidence=? WHERE spj_id=? AND idx=?",
                (json.dumps(stored), row["spj_id"], row["idx"]),
            )

    @staticmethod
    def _store_photos(connection: sqlite3.Connection, spj_id: str, stop_idx: int, evidence: dict) -> dict:
        """Insert each evidence photo into spj_evidence_photos; return the evidence without bytes.

        Every photo record keeps its photo_name and gains ``photo_ref`` (the per-SPJ
        number n served by GET /api/spj/{id}/evidence/{n}).
        """
        stored = copy.deepcopy(evidence)
        next_n = connection.execute(
            "SELECT COALESCE(MAX(n), 0) + 1 FROM spj_evidence_photos WHERE spj_id=?", (spj_id,)
        ).fetchone()[0]
        for slot, record in evidence_photo_slots(stored):
            photo = record.pop("photo_b64", None)
            if not isinstance(photo, str) or not photo.strip():
                continue
            connection.execute(
                "INSERT INTO spj_evidence_photos (spj_id, n, stop_idx, slot, photo_name, photo_b64, "
                "recorded_at) VALUES (?,?,?,?,?,?,?)",
                (spj_id, next_n, stop_idx, slot, str(record.get("photo_name") or ""), photo, _utc_now()),
            )
            record["photo_ref"] = next_n
            next_n += 1
        return stored

    def evidence_photo(self, spj_id: str, n: int) -> dict | None:
        """One stored evidence photo (bytes as stored: a data URL or bare base64)."""
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT n, stop_idx, slot, photo_name, photo_b64 FROM spj_evidence_photos "
                "WHERE spj_id=? AND n=?",
                (spj_id, n),
            ).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        spj_id: str,
        action: str,
        actor: str,
        reason: str = "",
        payload: dict | None = None,
    ) -> None:
        # Runs inside the mutation's BEGIN IMMEDIATE, so no other writer can slip
        # a row between reading the last digest and appending this one.
        last = connection.execute(
            "SELECT entry_sha256 FROM spj_audit WHERE spj_id=? AND entry_sha256 IS NOT NULL "
            "ORDER BY id DESC LIMIT 1",
            (spj_id,),
        ).fetchone()
        prev = last["entry_sha256"] if last else SEAL_SENTINEL
        stored = json.dumps(payload or {})
        created_at = _utc_now()
        connection.execute(
            "INSERT INTO spj_audit (spj_id, action, actor, reason, payload, created_at, prev_sha256, "
            "entry_sha256) VALUES (?,?,?,?,?,?,?,?)",
            (
                spj_id,
                action,
                actor,
                reason,
                stored,
                created_at,
                prev,
                audit_entry_digest(spj_id, action, actor, reason, stored, created_at, prev),
            ),
        )

    def audit_log(self, spj_id: str) -> list[dict]:
        """Audit entries for one SPJ, oldest first."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT action, actor, reason, payload, created_at FROM spj_audit WHERE spj_id=? ORDER BY id",
                (spj_id,),
            ).fetchall()
        return [
            {
                "action": r["action"],
                "actor": r["actor"],
                "reason": r["reason"],
                "payload": json.loads(r["payload"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def verify(self, spj_id: str) -> dict:
        """Re-verify the sealed audit chain of one SPJ and its receipt against it.

        Nothing is hidden: every row is checked and each failure adds a short code
        to ``problems``. Rows without digests (``legacy_unsealed``) are accepted
        only when written before sealing existed and before the first sealed row.
        ``receipt_photo_ok`` / ``receipt_weights_ok`` compare the stored receipt
        with the latest sealed ``receipt`` / ``receipt_review`` entry; null when
        there is no receipt or it was recorded before sealing.
        """
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT id, spj_id, action, actor, reason, payload, created_at, prev_sha256, entry_sha256 "
                "FROM spj_audit WHERE spj_id=? ORDER BY id",
                (spj_id,),
            ).fetchall()
            sealed_from = connection.execute("SELECT MIN(sealed_from_id) FROM spj_audit_seal").fetchone()[0]
            receipt = connection.execute(
                "SELECT photo_b64, total_weight_kg, gross_weight_kg, tare_weight_kg, net_weight_kg "
                "FROM spj_receipts WHERE spj_id=?",
                (spj_id,),
            ).fetchone()
        problems: list[str] = []
        prev = SEAL_SENTINEL
        sealed = legacy = 0
        sealed_photo = sealed_weights = None
        legacy_receipt = False
        for row in rows:
            if row["entry_sha256"] is None and row["prev_sha256"] is None:
                legacy += 1
                if sealed or sealed_from is None or row["id"] >= sealed_from:
                    problems.append("unsealed_entry")
                legacy_receipt = legacy_receipt or row["action"] == "receipt"
                continue
            sealed += 1
            if row["prev_sha256"] != prev:
                problems.append("chain_broken")
            expected = audit_entry_digest(
                row["spj_id"],
                row["action"],
                row["actor"],
                row["reason"],
                row["payload"],
                row["created_at"],
                row["prev_sha256"] or "",
            )
            if expected != row["entry_sha256"]:
                problems.append("entry_digest_mismatch")
            prev = row["entry_sha256"]
            if row["action"] not in ("receipt", "receipt_review"):
                continue
            try:
                payload = json.loads(row["payload"])
            except (TypeError, ValueError):
                problems.append("payload_unreadable")
                continue
            if row["action"] == "receipt":
                sealed_photo = payload.get("photo_sha256")
                gross = payload.get("total_weight_kg")
                sealed_weights = (gross, payload.get("tare_weight_kg"), payload.get("net_weight_kg"))
            else:
                recorded = payload.get("recorded") or {}
                sealed_weights = (
                    recorded.get("gross_weight_kg"),
                    recorded.get("tare_weight_kg"),
                    recorded.get("net_weight_kg"),
                )
        photo_ok = weights_ok = None
        if receipt is not None:
            if sealed_photo is not None:
                photo_ok = photo_sha256(receipt["photo_b64"] or "") == sealed_photo
            elif not legacy_receipt:
                photo_ok = False  # a receipt the sealed trail never recorded
            if sealed_weights is not None:
                gross, tare, net = sealed_weights
                weights_ok = all(
                    _same_weight(stored, sealed)
                    for stored, sealed in (
                        (receipt["total_weight_kg"], gross),
                        (receipt["gross_weight_kg"], gross),
                        (receipt["tare_weight_kg"], tare),
                        (receipt["net_weight_kg"], net),
                    )
                )
            elif not legacy_receipt:
                weights_ok = False
            if photo_ok is False:
                problems.append("receipt_photo_changed")
            if weights_ok is False:
                problems.append("receipt_weights_changed")
        return {
            "spj_id": spj_id,
            "chain_ok": not any(p in problems for p in _CHAIN_PROBLEMS),
            "sealed_entries": sealed,
            "legacy_unsealed": legacy,
            "receipt_photo_ok": photo_ok,
            "receipt_weights_ok": weights_ok,
            "receipt_photo_sha256": sealed_photo,
            # The newest sealed digest: it commits to every sealed row before it.
            "head_sha256": prev if sealed else None,
            "problems": list(dict.fromkeys(problems)),
        }

    def sealed_receipt_photos(self) -> dict[str, list[dict]]:
        """photo_sha256 -> the SPJs whose sealed ``receipt`` entry carries it."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT a.spj_id, s.spj_number, a.payload FROM spj_audit a JOIN spj s ON s.spj_id = a.spj_id "
                "WHERE a.action='receipt' AND a.entry_sha256 IS NOT NULL ORDER BY a.id"
            ).fetchall()
        photos: dict[str, list[dict]] = {}
        for row in rows:
            try:
                digest = json.loads(row["payload"]).get("photo_sha256")
            except (TypeError, ValueError, AttributeError):
                continue
            if digest:
                photos.setdefault(digest, []).append(
                    {"spj_id": row["spj_id"], "spj_number": row["spj_number"]}
                )
        return photos

    def receipt_ticket_numbers(self) -> dict[str, list[dict]]:
        """Ticket number as the receipt OCR read it (MODEL OUTPUT) -> the SPJs whose receipt carries it.

        Numbers are compared on letters and digits only, upper-cased.
        """
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT r.spj_id, s.spj_number, r.ocr FROM spj_receipts r JOIN spj s ON s.spj_id = r.spj_id "
                "WHERE r.ocr IS NOT NULL"
            ).fetchall()
        tickets: dict[str, list[dict]] = {}
        for row in rows:
            try:
                ticket = normalize_ticket_no(json.loads(row["ocr"]).get("ticket_no"))
            except (TypeError, ValueError, AttributeError):
                continue
            if ticket:
                tickets.setdefault(ticket, []).append(
                    {"spj_id": row["spj_id"], "spj_number": row["spj_number"]}
                )
        return tickets

    @staticmethod
    def _row_to_spj(spj_row: sqlite3.Row, stop_rows: list, receipt_row: sqlite3.Row | None = None) -> Spj:
        route_geometry = None
        if spj_row["route_geometry"] if "route_geometry" in spj_row.keys() else None:
            try:
                route_geometry = [tuple(p) for p in json.loads(spj_row["route_geometry"])]
            except (ValueError, TypeError):
                route_geometry = None
        return Spj(
            spj_id=spj_row["spj_id"],
            spj_number=spj_row["spj_number"],
            date=spj_row["date"],
            driver_name=spj_row["driver_name"],
            truck_code=spj_row["truck_code"],
            destination=spj_row["destination"],
            weigh_on_site=bool(spj_row["weigh_on_site"]),
            priority=spj_row["priority"],
            note=spj_row["note"],
            stops=[
                SpjStop(
                    name=r["name"],
                    kecamatan=r["kecamatan"],
                    address=r["address"],
                    lat=r["lat"],
                    lng=r["lng"],
                    location_type=r["location_type"],
                    status=r["status"],
                    completed_at=r["completed_at"],
                    evidence=json.loads(r["evidence"]) if r["evidence"] else None,
                    override=json.loads(r["override"]) if r["override"] else None,
                )
                for r in sorted(stop_rows, key=lambda r: r["idx"])
            ],
            status=spj_row["status"],
            created_by=spj_row["created_by"],
            created_at=spj_row["created_at"],
            activated_at=spj_row["activated_at"],
            completed_at=spj_row["completed_at"],
            route_geometry=route_geometry or [],
            route_source=spj_row["route_source"] if "route_source" in spj_row.keys() else None,
            route_resolved_at=spj_row["route_resolved_at"] if "route_resolved_at" in spj_row.keys() else None,
            receipt=(
                {
                    **{
                        key: receipt_row[key]
                        for key in (
                            "photo_name",
                            "total_weight_kg",
                            "gross_weight_kg",
                            "tare_weight_kg",
                            "net_weight_kg",
                            "weight_source",
                            "submitted_by",
                            "recorded_at",
                        )
                    },
                    "has_photo": bool(receipt_row["has_photo"]),
                    "ocr": json.loads(receipt_row["ocr"]) if receipt_row["ocr"] else None,
                }
                if receipt_row is not None
                else None
            ),
        )

    def _load_spj(self, connection: sqlite3.Connection, spj_id: str) -> Spj | None:
        row = connection.execute("SELECT * FROM spj WHERE spj_id=?", (spj_id,)).fetchone()
        if row is None:
            return None
        stops = connection.execute(
            "SELECT * FROM spj_stops WHERE spj_id=? ORDER BY idx", (spj_id,)
        ).fetchall()
        receipt = connection.execute(
            "SELECT photo_name, total_weight_kg, gross_weight_kg, tare_weight_kg, net_weight_kg, "
            "weight_source, submitted_by, ocr, "
            "recorded_at, (photo_b64 IS NOT NULL AND photo_b64 != '') AS has_photo "
            "FROM spj_receipts WHERE spj_id=?",
            (spj_id,),
        ).fetchone()
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
        for key in ("name", "kecamatan", "address"):
            value = stop.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"stops[{position}].{key} is required")
        for coord in ("lat", "lng"):
            try:
                number = float(stop.get(coord))
            except (TypeError, ValueError):
                raise ValueError(f"stops[{position}].{coord} must be a number") from None
            if not (-90.0 <= number <= 90.0 if coord == "lat" else -180.0 <= number <= 180.0):
                raise ValueError(f"stops[{position}].{coord}={number} out of range")
        _reject_spoofed_demo(
            stop.get("location_type"), bool(stop.get("demo")), f"stops[{position}].location_type"
        )

    def create_with_stops(
        self,
        driver_name: str,
        truck_code: str,
        destination: str,
        weigh_on_site: bool,
        priority: str,
        note: str,
        stops: list[dict],
        created_by: str = "admin",
        date: str | None = None,
    ) -> Spj:
        """Create a draft SPJ and ALL of its stops in ONE transaction (#60).

        Either the SPJ exists with every stop in exact order, or nothing
        is persisted — a failing stop rolls the whole draft back. ``date``
        (ISO) sets both the SPJ day and its number prefix; it defaults to today.
        """
        day = date or _today()
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
                raise ValueError(f"stops[{position}].name '{name}' duplicates an earlier stop")
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
                        number = next_spj_number(self, day)
                        try:
                            connection.execute(
                                "INSERT INTO spj (spj_id, spj_number, date, driver_name, "
                                "truck_code, destination, weigh_on_site, priority, note, "
                                "status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                (
                                    spj_id,
                                    number,
                                    day,
                                    driver_name,
                                    truck_code,
                                    destination,
                                    int(bool(weigh_on_site)),
                                    priority,
                                    note,
                                    "draft",
                                    created_by,
                                    now,
                                ),
                            )
                            for idx, stop in enumerate(stops):
                                demo = bool(stop.get("demo"))
                                connection.execute(
                                    "INSERT INTO spj_stops (spj_id, idx, name, kecamatan, "
                                    "address, lat, lng, location_type, status) "
                                    "VALUES (?,?,?,?,?,?,?,?,?)",
                                    (
                                        spj_id,
                                        idx,
                                        demo_stop_name(stop["name"]) if demo else stop["name"].strip(),
                                        stop["kecamatan"].strip(),
                                        stop["address"].strip(),
                                        float(stop["lat"]),
                                        float(stop["lng"]),
                                        DEMO_LOCATION_TYPE
                                        if demo
                                        else stop.get("location_type", "Pemukiman Kelas Menengah"),
                                        "pending",
                                    ),
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

    def create(
        self,
        driver_name: str,
        truck_code: str,
        destination: str,
        weigh_on_site: bool,
        priority: str,
        note: str,
        created_by: str = "admin",
    ) -> Spj:
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
                                (
                                    spj_id,
                                    number,
                                    _today(),
                                    driver_name,
                                    truck_code,
                                    destination,
                                    int(bool(weigh_on_site)),
                                    priority,
                                    note,
                                    "draft",
                                    created_by,
                                    now,
                                ),
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

    def list(
        self, status: str | None = None, truck_code: str | None = None, limit: int | None = None
    ) -> list[Spj]:
        """Newest first, so a client can rely on position instead of guessing.

        Ordering by created_at descending is part of the contract: the driver
        app picks the newest receipt-pending SPJ from this response. ``limit``
        keeps the newest N after the status/truck filters.
        """
        with self._lock:
            items = list(self._spj.values())
        items.sort(key=lambda s: (s.created_at, s.spj_number), reverse=True)
        if status is not None:
            items = [s for s in items if s.status == status]
        if truck_code is not None:
            items = [s for s in items if s.truck_code == truck_code]
        return items if limit is None else items[: max(0, limit)]

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
            raise ValueError(f"Work order {spj_id} not found")
        return row

    def add_stop(
        self,
        spj_id: str,
        name: str,
        kecamatan: str,
        address: str,
        lat: float,
        lng: float,
        location_type: str = "Pemukiman Kelas Menengah",
        demo: bool = False,
    ) -> Spj:
        _reject_spoofed_demo(location_type, demo, "location_type")
        if demo:
            name = demo_stop_name(name)
            location_type = DEMO_LOCATION_TYPE

        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "draft":
                raise ValueError("stops can only be added to a draft work order")
            idx = connection.execute(
                "SELECT COALESCE(MAX(idx)+1, 0) FROM spj_stops WHERE spj_id=?", (spj_id,)
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO spj_stops (spj_id, idx, name, kecamatan, address, "
                "lat, lng, location_type, status) VALUES (?,?,?,?,?,?,?,?,?)",
                (spj_id, idx, name, kecamatan, address, lat, lng, location_type, "pending"),
            )

        return self._mutate(spj_id, mutate)

    def activate(self, spj_id: str, actor: str | None = None) -> Spj:
        """Activate after resolving road-following compliance geometry (#58).

        Every leg (stops in order + destination) is resolved via OSRM
        BEFORE the status flips. A degraded (straight-line) result FAILS
        activation visibly — it is never silently promoted as ground
        truth — unless PYTHIA_SPJ_STRAIGHT_FALLBACK=on, in which case the
        fallback is recorded in the audit trail.
        """

        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "draft":
                raise CodedError(
                    "spj_not_draft",
                    f"cannot activate a work order in status '{row['status']}'",
                    status=row["status"],
                )
            # A trip worked today on tomorrow's SPJ would count for tomorrow: the day
            # recap, the KPIs and readiness read the SPJ date, so it is refused.
            if row["date"] > _today():
                raise ValueError(
                    f"cannot activate: this work order is for {row['date']} and today is {_today()}; "
                    "activate it on that day so its trips and tonnes count for the right day"
                )
            stop_count = connection.execute(
                "SELECT COUNT(*) FROM spj_stops WHERE spj_id=?", (spj_id,)
            ).fetchone()[0]
            if stop_count < 1:
                raise CodedError("spj_no_stops", "The work order needs at least one stop before activation")
            active = connection.execute(
                "SELECT spj_id FROM spj WHERE truck_code=? AND status='aktif'", (row["truck_code"],)
            ).fetchone()
            if active is not None:
                raise CodedError(
                    "spj_truck_busy",
                    f"truck {row['truck_code']} already has an active work order",
                    truck=row["truck_code"],
                )

            # #58: resolve road-following geometry for the whole path.
            stops = connection.execute(
                "SELECT lat, lng, location_type FROM spj_stops WHERE spj_id=? ORDER BY idx", (spj_id,)
            ).fetchall()
            waypoints = [(s["lat"], s["lng"]) for s in stops]
            demo_points = [s["location_type"] == DEMO_LOCATION_TYPE for s in stops]
            dest = route_ground_truth(row["destination"])
            if dest is None:
                raise ValueError(
                    f"cannot activate: destination '{row['destination']}' has "
                    "no verified ground-truth coordinate (#59); refusing to "
                    "route compliance through a guessed point"
                )
            if not waypoints or waypoints[-1] != dest:
                waypoints.append(dest)
                demo_points.append(False)
            route = (
                road_route(waypoints)
                if len(waypoints) >= 2
                else {
                    "geometry": [{"lat": la, "lng": ln} for la, ln in waypoints],
                    "source": "LIVE_EXTERNAL",
                    "distance_km": 0.0,
                    "duration_min": 0,
                }
            )
            source = route.get("source", "FALLBACK_DEGRADED")
            # gsc P0-3: a DEMO stop may sit where no road links it to the
            # Jakarta destination, so only legs touching a DEMO stop are exempt:
            # every other leg must still resolve on the road network.
            legs = (
                [road_route([waypoints[i], waypoints[i + 1]]) for i in range(len(waypoints) - 1)]
                if source == "FALLBACK_DEGRADED" and any(demo_points)
                else []
            )
            demo_exempt = bool(legs) and all(
                leg.get("source") != "FALLBACK_DEGRADED"
                for i, leg in enumerate(legs)
                if not (demo_points[i] or demo_points[i + 1])
            )
            if demo_exempt:
                # gsc #6: stitch the geometry leg by leg, so a leg that does
                # resolve (stop 1 → a DEMO stop near it) keeps its road
                # geometry for the AR street path, and only the unresolved
                # legs are straight stop-to-stop segments. The SPJ as a whole
                # stays labelled FALLBACK_DEGRADED and the audit trail names
                # the DEMO cause and how many legs follow roads.
                stitched: list[dict] = []
                for leg in legs:
                    for point in leg.get("geometry", []):
                        if not stitched or stitched[-1] != point:
                            stitched.append(point)
                route = {**route, "geometry": stitched}
                road_legs = sum(1 for leg in legs if leg.get("source") != "FALLBACK_DEGRADED")
                self._audit(
                    connection,
                    spj_id,
                    "demo_straight_fallback",
                    actor or row["created_by"],
                    reason="DEMO stop: activated with unresolved road geometry",
                    payload={"source": source, "road_legs": road_legs, "legs": len(legs)},
                )
            elif source == "FALLBACK_DEGRADED":
                if getenv("SPJ_STRAIGHT_FALLBACK", "off").lower() != "on":
                    raise ValueError(
                        "cannot activate: road-following geometry could not be "
                        "resolved (routing service unavailable); refusing to "
                        "promote a straight-line path as ground truth"
                    )
                self._audit(
                    connection,
                    spj_id,
                    "straight_fallback",
                    actor or row["created_by"],
                    reason="PYTHIA_SPJ_STRAIGHT_FALLBACK=on: activated with unresolved road geometry",
                    payload={"source": source},
                )
            geometry = [(p["lat"], p["lng"]) for p in route.get("geometry", [])]
            now = _utc_now()
            connection.execute(
                "UPDATE spj SET status='aktif', activated_at=?, route_geometry=?, "
                "route_source=?, route_resolved_at=? WHERE spj_id=?",
                (now, json.dumps(geometry), source, now, spj_id),
            )
            self._audit(
                connection,
                spj_id,
                "activate",
                actor or row["created_by"],
                payload={"route_source": source, "route_points": len(geometry)},
            )

        return self._mutate(spj_id, mutate)

    def complete_stop(
        self,
        spj_id: str,
        index: int,
        evidence: dict | None = None,
        override: dict | None = None,
        actor: str | None = None,
    ) -> Spj:
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "aktif":
                raise ValueError("stops can only be completed on an active work order")
            # Gap 6: the audit names who did it; legacy callers without an actor
            # fall back to the SPJ's creator as before.
            who = actor or row["created_by"]
            stops = connection.execute(
                "SELECT idx, status, location_type FROM spj_stops WHERE spj_id=? ORDER BY idx", (spj_id,)
            ).fetchall()
            if not 0 <= index < len(stops):
                raise ValueError(f"stop index {index} out of range")
            if stops[index]["status"] == "completed":
                return  # idempotent
            if stops[index]["status"] == "skipped":
                raise ValueError(f"stop {index} was skipped by dispatch; it is not collected")
            # #55 (PR #90): route order is a server-side invariant — a
            # stop cannot complete while an earlier stop is still open.
            earlier_open = [s["idx"] for s in stops[:index] if s["status"] not in ("completed", "skipped")]
            if earlier_open and override is None:
                raise ValueError(
                    f"stop {index} cannot complete before earlier stop(s) "
                    f"{earlier_open}; route order is a server-side invariant"
                )
            if evidence is None:
                if override is None:
                    raise ValueError("stop completion requires field evidence (arrival, weighing, officer)")
                # Audited supervisor override closing this stop without
                # evidence (PR #90 #63): reason >= 10 chars, actor named.
                checked = _validate_override(override, who)
                connection.execute(
                    "UPDATE spj_stops SET status='completed', completed_at=?, "
                    "override=? WHERE spj_id=? AND idx=?",
                    (_utc_now(), json.dumps(checked), spj_id, index),
                )
                self._audit(
                    connection,
                    spj_id,
                    "override",
                    checked["actor"],
                    checked["reason"],
                    payload={"stop_index": index},
                )
            else:
                _validate_evidence(
                    evidence,
                    demo=stops[index]["location_type"] == DEMO_LOCATION_TYPE,
                    weigh_on_site=bool(row["weigh_on_site"]),
                )
                stored = self._store_photos(connection, spj_id, index, evidence)
                connection.execute(
                    "UPDATE spj_stops SET status='completed', completed_at=?, "
                    "evidence=? WHERE spj_id=? AND idx=?",
                    (_utc_now(), json.dumps(stored), spj_id, index),
                )
                self._audit(connection, spj_id, "complete_stop", who, payload={"stop_index": index})
            self._close_when_no_stop_is_open(connection, spj_id)

        return self._mutate(spj_id, mutate)

    @staticmethod
    def _close_when_no_stop_is_open(connection: sqlite3.Connection, spj_id: str) -> None:
        pending = connection.execute(
            "SELECT COUNT(*) FROM spj_stops WHERE spj_id=? AND status NOT IN ('completed', 'skipped')",
            (spj_id,),
        ).fetchone()[0]
        if pending == 0:
            connection.execute(
                "UPDATE spj SET status='selesai', completed_at=? WHERE spj_id=?", (_utc_now(), spj_id)
            )

    def skip_stop(self, spj_id: str, index: int, reason: str, actor: str) -> Spj:
        """Dispatch decides a stop of an active SPJ is not collected (e.g. the TPS was empty).

        The stop becomes ``skipped``: never completed, never counted as collected
        or as missing proof. Audited as ``skip_stop`` with the reason; skipping it
        again is a no-op; a completed stop cannot be skipped. When no open stop is
        left the SPJ closes as it does after the last completed stop.
        """
        if len(reason.strip()) < 3:
            raise ValueError("a skip needs a reason")

        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "aktif":
                raise ValueError("stops can only be skipped on an active work order")
            stops = connection.execute(
                "SELECT idx, status FROM spj_stops WHERE spj_id=? ORDER BY idx", (spj_id,)
            ).fetchall()
            if not 0 <= index < len(stops):
                raise ValueError(f"stop index {index} out of range")
            if stops[index]["status"] == "skipped":
                return  # idempotent
            if stops[index]["status"] == "completed":
                raise ValueError(f"stop {index} is already completed")
            connection.execute(
                "UPDATE spj_stops SET status='skipped' WHERE spj_id=? AND idx=?", (spj_id, index)
            )
            self._audit(connection, spj_id, "skip_stop", actor, reason.strip(), payload={"stop_index": index})
            self._close_when_no_stop_is_open(connection, spj_id)

        return self._mutate(spj_id, mutate)

    def record_receipt(
        self,
        spj_id: str,
        photo_name: str,
        photo_b64: str,
        total_weight_kg: float | None,
        weight_source: str,
        submitted_by: str = "driver",
        operation_id: str | None = None,
        tare_weight_kg: float | None = None,
        ocr: dict | None = None,
    ) -> Spj:
        """Attach the weighbridge receipt exactly once.

        ``ocr`` is the initial reviewer-side OCR block (``receipt_ocr_record``);
        it is stored beside the weights and never changes them.

        ``total_weight_kg`` is what the weighbridge shows for the loaded truck: the
        GROSS weight (H10). With ``tare_weight_kg`` the receipt also stores
        ``net_weight_kg = gross - tare``, the waste actually delivered; without a
        tare the net stays null rather than being guessed.

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
                raise ValueError("receipt can only be submitted after the work order is completed")
            if not photo_name.strip() or not photo_b64.strip():
                raise ValueError("receipt photo_name and photo_b64 are required")
            if total_weight_kg is not None and not (0 < total_weight_kg <= MAX_STOP_WEIGHT_KG):
                raise ValueError(f"total_weight_kg must be 0 < w <= {MAX_STOP_WEIGHT_KG}")
            net_weight_kg = None
            if tare_weight_kg is not None:
                if total_weight_kg is None:
                    raise ValueError("tare_weight_kg needs the gross weight (total_weight_kg)")
                if not (0 < tare_weight_kg < total_weight_kg):
                    raise ValueError("tare_weight_kg must be 0 < tare < gross (total_weight_kg)")
                net_weight_kg = round(total_weight_kg - tare_weight_kg, 1)
            existing = connection.execute("SELECT * FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone()
            if existing is not None:
                if operation_id and existing["operation_id"] == operation_id:
                    return  # client retry of an accepted submission
                raise ValueError("receipt already submitted")
            connection.execute(
                "INSERT INTO spj_receipts (spj_id, photo_name, photo_b64, "
                "total_weight_kg, gross_weight_kg, tare_weight_kg, net_weight_kg, "
                "weight_source, submitted_by, operation_id, "
                "recorded_at, ocr) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    spj_id,
                    photo_name,
                    photo_b64,
                    total_weight_kg,
                    total_weight_kg,
                    tare_weight_kg,
                    net_weight_kg,
                    weight_source,
                    submitted_by,
                    operation_id,
                    _utc_now(),
                    json.dumps(ocr) if ocr is not None else None,
                ),
            )
            self._audit(
                connection,
                spj_id,
                "receipt",
                submitted_by,
                payload={
                    "total_weight_kg": total_weight_kg,
                    "tare_weight_kg": tare_weight_kg,
                    "net_weight_kg": net_weight_kg,
                    "weight_source": weight_source,
                    "photo_name": photo_name,
                    "photo_sha256": photo_sha256(photo_b64),
                    "operation_id": operation_id,
                },
            )

        return self._mutate(spj_id, mutate)

    def receipt_photo(self, spj_id: str) -> str | None:
        """Receipt image bytes, read only when a detail view asks for them."""
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT photo_b64 FROM spj_receipts WHERE spj_id=?", (spj_id,)
            ).fetchone()
        return row["photo_b64"] if row else None

    def set_receipt_ocr(self, spj_id: str, ocr: dict) -> Spj:
        """Store the OCR outcome beside the receipt; the recorded weights stay untouched.

        A reviewer may already have corrected the receipt while the OCR ran: the
        suggestion is then filed for audit and the review status is kept.
        """

        def mutate(connection):
            row = connection.execute("SELECT ocr FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone()
            if row is None:
                raise ValueError("no receipt recorded for this work order")
            current = json.loads(row["ocr"]) if row["ocr"] else {}
            stored = dict(ocr)
            if current.get("status") in RECEIPT_OCR_REVIEWED:
                for key in ("status", "reviewed_by", "reviewed_at"):
                    stored[key] = current.get(key)
            connection.execute("UPDATE spj_receipts SET ocr=? WHERE spj_id=?", (json.dumps(stored), spj_id))
            self._audit(
                connection,
                spj_id,
                "receipt_ocr",
                "system:ocr",
                payload={
                    key: stored.get(key)
                    for key in (
                        "status",
                        "gross_kg",
                        "tare_kg",
                        "net_kg",
                        *RECEIPT_OCR_TICKET_FIELDS,
                        "confidence",
                        "source",
                        "reason",
                    )
                },
            )

        return self._mutate(spj_id, mutate)

    def review_receipt(
        self,
        spj_id: str,
        action: str,
        actor: str,
        gross_weight_kg: float | None = None,
        tare_weight_kg: float | None = None,
    ) -> Spj:
        """A reviewer confirms the OCR suggestion or corrects the recorded weights, once.

        ``confirm`` copies the OCR gross into the recorded gross (the recorded tare
        is kept); ``correct`` records the weights the reviewer typed. The OCR
        suggestion stays on the receipt and the previous weights go to the audit.
        """

        def mutate(connection):
            row = connection.execute("SELECT * FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone()
            if row is None:
                raise ValueError("no receipt recorded for this work order")
            ocr = (
                json.loads(row["ocr"])
                if row["ocr"]
                else receipt_ocr_record("unavailable", "no OCR ran for this receipt")
            )
            if ocr.get("status") in RECEIPT_OCR_REVIEWED:
                raise ValueError(f"receipt already reviewed ({ocr['status']})")
            if action == "confirm":
                gross = ocr.get("gross_kg")
                if ocr.get("status") != "unreviewed" or gross is None:
                    raise ValueError(
                        "there is no OCR weight to confirm; correct it with the ticket's weights"
                    )
                tare = row["tare_weight_kg"]
                source, status = "ocr_confirmed", "confirmed"
            elif action == "correct":
                gross, tare = gross_weight_kg, tare_weight_kg
                if gross is None:
                    raise ValueError("a correction needs gross_weight_kg")
                source, status = "reviewer_corrected", "corrected"
            else:
                raise ValueError("action must be confirm or correct")
            if not (0 < gross <= MAX_STOP_WEIGHT_KG):
                raise ValueError(f"gross_weight_kg must be 0 < w <= {MAX_STOP_WEIGHT_KG}")
            if tare is not None and not (0 < tare < gross):
                raise ValueError("tare_weight_kg must be 0 < tare < gross")
            net = round(gross - tare, 1) if tare is not None else None
            reviewed = {**ocr, "status": status, "reviewed_by": actor, "reviewed_at": _utc_now()}
            connection.execute(
                "UPDATE spj_receipts SET total_weight_kg=?, gross_weight_kg=?, tare_weight_kg=?, "
                "net_weight_kg=?, weight_source=?, ocr=? WHERE spj_id=?",
                (gross, gross, tare, net, source, json.dumps(reviewed), spj_id),
            )
            self._audit(
                connection,
                spj_id,
                "receipt_review",
                actor,
                payload={
                    "action": action,
                    "previous": {
                        "gross_weight_kg": row["gross_weight_kg"],
                        "tare_weight_kg": row["tare_weight_kg"],
                        "net_weight_kg": row["net_weight_kg"],
                        "weight_source": row["weight_source"],
                    },
                    "recorded": {
                        "gross_weight_kg": gross,
                        "tare_weight_kg": tare,
                        "net_weight_kg": net,
                        "weight_source": source,
                    },
                    "ocr_suggestion": {key: ocr.get(key) for key in ("gross_kg", "confidence", "source")},
                },
            )

        return self._mutate(spj_id, mutate)

    def complete(self, spj_id: str, override: dict | None = None, actor: str | None = None) -> Spj:
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
                raise ValueError(f"cannot complete a work order in status '{row['status']}'")
            # A skipped stop was decided by dispatch: it needs no evidence and stays skipped.
            unevidenced = connection.execute(
                "SELECT COUNT(*) FROM spj_stops WHERE spj_id=? AND status != 'skipped' "
                "AND (status != 'completed' OR evidence IS NULL)",
                (spj_id,),
            ).fetchone()[0]
            checked = None
            if unevidenced:
                if override is None:
                    raise ValueError(
                        f"cannot complete: {unevidenced} stop(s) lack field evidence; "
                        "a supervisor override with a reason is required"
                    )
                checked = _validate_override(override, actor or row["created_by"])
            now = _utc_now()
            if checked is not None:
                # Mark the forced stops so compliance reports (not charges)
                # them as supervisor decisions.
                connection.execute(
                    "UPDATE spj_stops SET override=? WHERE spj_id=? AND evidence IS NULL "
                    "AND status != 'skipped'",
                    (json.dumps(checked), spj_id),
                )
            connection.execute(
                "UPDATE spj_stops SET status='completed', completed_at=? "
                "WHERE spj_id=? AND status NOT IN ('completed', 'skipped')",
                (now, spj_id),
            )
            connection.execute(
                "UPDATE spj SET status='selesai', completed_at=? WHERE spj_id=?", (now, spj_id)
            )
            if checked is not None:
                self._audit(
                    connection,
                    spj_id,
                    "override",
                    checked["actor"],
                    checked["reason"],
                    payload={"forced_stops": unevidenced},
                )
            else:
                self._audit(connection, spj_id, "complete", actor or row["created_by"])

        return self._mutate(spj_id, mutate)

    def reassign_draft(self, spj_id: str, truck_code: str, driver_name: str, actor: str, reason: str) -> Spj:
        """Move a draft SPJ to another truck and driver (audit action ``reassign``).

        Only a draft moves: an active SPJ is already the reference path of the
        truck on the road, so it must be cancelled and recreated instead.
        """

        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] != "draft":
                raise ValueError(f"cannot reassign a work order in status '{row['status']}'")
            connection.execute(
                "UPDATE spj SET truck_code=?, driver_name=? WHERE spj_id=?",
                (truck_code, driver_name, spj_id),
            )
            self._audit(
                connection,
                spj_id,
                "reassign",
                actor,
                reason,
                {
                    "from_truck": row["truck_code"],
                    "to_truck": truck_code,
                    "from_driver": row["driver_name"],
                    "to_driver": driver_name,
                },
            )

        return self._mutate(spj_id, mutate)

    def cancel(self, spj_id: str, actor: str | None = None) -> Spj:
        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] not in ("draft", "aktif"):
                raise ValueError(f"cannot cancel a work order in status '{row['status']}'")
            connection.execute("UPDATE spj SET status='batal' WHERE spj_id=?", (spj_id,))
            self._audit(connection, spj_id, "cancel", actor or row["created_by"])

        return self._mutate(spj_id, mutate)

    # -- driver safety: gate-arrival event (app.field.safety) -----------------

    def record_gate_arrival(self, spj_id: str, actor: str, arrived_at: str) -> Spj:
        """Record once that the truck reached the disposal gate (audit action ``gate_arrival``).

        The gate wait runs from this event to the weighbridge receipt. A repeat is
        a no-op, so an offline replay never moves the first arrival. ``arrived_at``
        is an ISO timestamp already bounds-checked by the caller.
        """

        def mutate(connection):
            row = self._fetch_status(connection, spj_id)
            if row["status"] not in ("aktif", "selesai"):
                raise ValueError(f"cannot record a gate arrival for a work order in status '{row['status']}'")
            if connection.execute(
                "SELECT 1 FROM spj_audit WHERE spj_id=? AND action='gate_arrival'", (spj_id,)
            ).fetchone():
                return
            if connection.execute("SELECT 1 FROM spj_receipts WHERE spj_id=?", (spj_id,)).fetchone():
                raise ValueError("the weighbridge receipt is already recorded; the gate wait is closed")
            self._audit(connection, spj_id, "gate_arrival", actor, payload={"arrived_at": arrived_at})

        return self._mutate(spj_id, mutate)

    def _load_fresh(self, spj_id: str) -> Spj:
        with closing(self._connect()) as connection:
            spj = self._load_spj(connection, spj_id)
        if spj is None:
            raise ValueError(f"Work order {spj_id} not found")
        return spj

    def _commit(self, spj: Spj) -> Spj:
        """Write a record without invariant checks (legacy test fixtures).

        Only for reproducing pre-migration record shapes that no public
        transition can produce any more; never call this from request paths.
        """

        def mutate(connection):
            row = connection.execute("SELECT status FROM spj WHERE spj_id=?", (spj.spj_id,)).fetchone()
            if row is None:
                raise ValueError(f"Work order {spj.spj_id} not found")
            connection.execute(
                "UPDATE spj SET status=?, completed_at=? WHERE spj_id=?",
                (spj.status, spj.completed_at, spj.spj_id),
            )
            for idx, stop in enumerate(spj.stops):
                connection.execute(
                    "UPDATE spj_stops SET status=?, completed_at=? WHERE spj_id=? AND idx=?",
                    (stop.status, stop.completed_at, spj.spj_id, idx),
                )

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
                spj.spj_id,
                truck_code,
                spj.destination,
            )
            return None
        if len(line) < 2:
            return None
        return line
    except Exception:  # noqa: BLE001
        logger.exception("active_path_for(%s) failed; using corridor fallback", truck_code)
        return None


def active_spj_is_demo(truck_code: str) -> bool | None:
    """True when the truck's active SPJ has a DEMO stop (placed at an operator's phone).

    Such a path is not an operational route: the simulated truck is nowhere
    near it, so deviation detection must not measure against it (gsc C1).
    None when the lookup failed: callers must then neither suppress deviation
    nor trust an SPJ path, and fall back to the corridor reference.
    """
    try:
        spj = SPJ_STORE.active_for_truck(truck_code)
    except Exception:  # noqa: BLE001
        logger.exception("active_spj_is_demo(%s) failed", truck_code)
        return None
    return spj is not None and any(stop.location_type == DEMO_LOCATION_TYPE for stop in spj.stops)


def active_spj_has_position(truck_code: str) -> bool | None:
    """Whether a GPS position has been recorded on the truck's active SPJ.

    The map position is the simulated feed, which never drives an SPJ path, so
    until a stop is checked in with a device fix there is nothing real to
    measure the SPJ corridor against. None when there is no active SPJ or the
    lookup failed.
    """
    try:
        spj = SPJ_STORE.active_for_truck(truck_code)
    except Exception:  # noqa: BLE001
        logger.exception("active_spj_has_position(%s) failed", truck_code)
        return None
    if spj is None:
        return None
    return any((arrival_geotag(stop) or {}).get("status") == "gps" for stop in spj.stops)


def destination_provenance(destination: str) -> dict:
    """Provenance record for one destination (surfaced by the API)."""
    return provenance_payload(destination)


def _maybe_seed(store: SpjStore) -> None:
    if len(store.list()) > 0 or getenv("SPJ_SEED", "on") == "off":
        return
    seed = store.create(
        driver_name="Pengemudi Sim 03",
        truck_code="T-088",
        destination="TPST Bantargebang",
        weigh_on_site=True,
        priority="normal",
        note="Seed demo SPJ",
        created_by="seed",
    )
    for name, kec, addr, lat, lng in [
        ("APARTEMEN ICON - PPPSRS", "Kebayoran Lama", "Jl. Ciledug Raya No 35, Cipulir", -6.2379, 106.7826),
        ("APARTEMENT BONA VISTA - PPPSRS", "Cilandak", "Bona Vista Raya", -6.2917, 106.7975),
        (
            "APT PERMATA SURYA",
            "Kalideres",
            "Jl. Boulevard Raya, Taman Surya 5, Pegadungan",
            -6.1590,
            106.7160,
        ),
    ]:
        store.add_stop(seed.spj_id, name=name, kecamatan=kec, address=addr, lat=lat, lng=lng)
    try:
        store.activate(seed.spj_id)
    except ValueError as exc:
        # Runs at import time: a routing outage must not stop the API from
        # starting. The seed stays a draft that can be activated from the UI.
        logger.warning("demo SPJ %s left as draft: %s", seed.spj_number, exc)


def _init_store() -> SpjStore:
    store = SpjStore()
    _maybe_seed(store)
    return store


SPJ_STORE = _init_store()
