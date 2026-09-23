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

import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.facilities import DESTINATIONS, provenance_payload, route_ground_truth
from app.storage import RecordStore, default_records_db

logger = logging.getLogger(__name__)

MAX_EVIDENCE_PHOTO_CHARS = 7_000_000

TABLE = "jwis_spj"
LEGACY_JSON = "jwis_spj.json"


def _validate_evidence(evidence: dict) -> None:
    arrival = evidence.get("arrival") or {}
    if not arrival.get("photo_name"):
        raise ValueError("evidence.arrival.photo_name is required")
    photos = [arrival.get("photo_b64"), (evidence.get("officer") or {}).get("photo_b64")]
    photos += [w.get("photo_b64") for w in (evidence.get("weighing") or [])]
    for photo in photos:
        if photo and len(photo) > MAX_EVIDENCE_PHOTO_CHARS:
            raise ValueError("evidence photo_b64 exceeds 7,000,000 chars")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _number_prefix() -> str:
    return datetime.now(timezone.utc).strftime("DLH-DKI/SPJ/%d-%m-%Y/")


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


def spj_summary_payload(spj: "Spj") -> dict:
    """List representation: no base64 payloads, only evidence summaries.

    The list endpoint is polled by every dashboard client, so it must never
    carry photo blobs — neither from stop evidence nor from the receipt.
    """
    payload = asdict(spj)
    for stop in payload["stops"]:
        ev = stop.pop("evidence", None)
        if ev is None:
            stop["evidence_summary"] = None
            continue
        weighing = ev.get("weighing") or []
        stop["evidence_summary"] = {
            "has_evidence": True,
            "weighing_count": len(weighing),
            "total_weight_kg": round(
                sum(float(w.get("weight_kg") or 0) for w in weighing), 1),
        }
    if payload.get("receipt"):
        payload["receipt"] = {k: v for k, v in payload["receipt"].items()
                              if k != "photo_b64"}
    payload["receipt_history"] = [
        {k: v for k, v in entry.items() if k != "photo_b64"}
        for entry in payload.get("receipt_history") or []
    ]
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
    receipt: dict | None = None  # exactly one current receipt per SPJ
    receipt_history: list[dict] = field(default_factory=list)


def next_spj_number(store: "SpjStore") -> str:
    """Next daily sequence value without reserving it (display helper)."""
    prefix = _number_prefix()
    return f"{prefix}{store.peek_sequence(prefix):06d}"


class SpjStore:
    """Durable SPJ store. Every mutation commits before it returns.

    `_lock` serializes this worker's writers (SQLite serializes across
    workers); each mutation re-reads the record first, so a stale in-memory
    copy can never overwrite newer state written by another process.
    """

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._records = RecordStore(TABLE, db_path)
        if db_path is None:
            # Migration is an operational concern for the deployed store only:
            # a store built on an explicit path (tests, tools) must start empty.
            self._records.migrate_legacy_json(
                self._records.db_path.parent / LEGACY_JSON, "spj_id")

    # ── reads ────────────────────────────────────────────────────────────────
    def count(self) -> int:
        return self._records.count()

    def peek_sequence(self, prefix: str) -> int:
        return self._records.peek_sequence(f"spj_number:{prefix}")

    def get(self, spj_id: str) -> Spj | None:
        raw = self._records.get(spj_id)
        return self._to_spj(raw) if raw is not None else None

    def list(self, status: str | None = None) -> list[Spj]:
        items = [self._to_spj(raw) for raw in self._records.all()]
        if status is None:
            return items
        return [s for s in items if s.status == status]

    def active_for_truck(self, truck_code: str) -> Spj | None:
        for spj in self.list(status="aktif"):
            if spj.truck_code == truck_code:
                return spj
        return None

    # ── mutations ────────────────────────────────────────────────────────────
    def create(self, driver_name: str, truck_code: str, destination: str,
               weigh_on_site: bool, priority: str, note: str,
               created_by: str = "admin") -> Spj:
        if destination not in DESTINATIONS:
            raise ValueError(f"destination must be one of {DESTINATIONS}")
        if priority not in ("normal", "vip"):
            raise ValueError("priority must be 'normal' or 'vip'")
        prefix = _number_prefix()
        spj_id = uuid4().hex[:12]
        with self._records.transaction() as connection:
            sequence = self._records.allocate_sequence(
                f"spj_number:{prefix}", connection=connection)
            spj = Spj(spj_id=spj_id, spj_number=f"{prefix}{sequence:06d}",
                      date=_today(), driver_name=driver_name,
                      truck_code=truck_code, destination=destination,
                      weigh_on_site=weigh_on_site, priority=priority,
                      note=note, created_by=created_by,
                      created_at=_utc_now())
            self._records.write(spj_id, asdict(spj), connection=connection)
        return spj

    def add_stop(self, spj_id: str, name: str, kecamatan: str, address: str,
                 lat: float, lng: float,
                 location_type: str = "Pemukiman Kelas Menengah") -> Spj:
        def change(spj: Spj) -> None:
            if spj.status != "draft":
                raise ValueError("stops can only be added to a draft SPJ")
            spj.stops.append(SpjStop(name=name, kecamatan=kecamatan,
                                     address=address, lat=lat, lng=lng,
                                     location_type=location_type))
        return self._mutate(spj_id, change)

    def activate(self, spj_id: str) -> Spj:
        def change(spj: Spj) -> None:
            if spj.status != "draft":
                raise ValueError(f"cannot activate SPJ in status '{spj.status}'")
            if not spj.stops:
                raise ValueError("SPJ needs at least one stop before activation")
            for other in self.list(status="aktif"):
                if other.truck_code == spj.truck_code and other.spj_id != spj.spj_id:
                    raise ValueError(
                        f"truck {spj.truck_code} already has an active SPJ")
            spj.status = "aktif"
            spj.activated_at = _utc_now()
        return self._mutate(spj_id, change)

    def complete_stop(self, spj_id: str, index: int,
                      evidence: dict | None = None,
                      override: dict | None = None,
                      actor: str | None = None) -> Spj:
        """Close one stop in route order, with field evidence or an override.

        Normal completion requires evidence. The only way to close a stop
        without it is an explicit supervisor override carrying a reason and an
        authorizing actor; it is stored on the stop so the audit trail shows
        exactly which closures were exceptional.
        """
        def change(spj: Spj) -> None:
            if spj.status != "aktif":
                raise ValueError("stops can only be completed on an active SPJ")
            if not 0 <= index < len(spj.stops):
                raise ValueError(f"stop index {index} out of range")
            stop = spj.stops[index]
            if stop.status == "completed":
                return
            pending_before = [i for i, s in enumerate(spj.stops[:index])
                              if s.status != "completed"]
            if pending_before:
                raise ValueError(
                    f"stop {index} cannot complete before stops {pending_before} "
                    "in the planned route order")
            if evidence is not None:
                _validate_evidence(evidence)
                stop.evidence = evidence
            else:
                stop.override = _validate_override(override, actor)
            stop.status = "completed"
            stop.completed_at = _utc_now()
            self._finish_if_complete(spj)
        return self._mutate(spj_id, change)

    def complete(self, spj_id: str, override: dict | None = None,
                 actor: str | None = None) -> Spj:
        """Supervisor override: close the whole order without field evidence.

        Bulk completion is only reachable through the reasoned override path —
        a client cannot use it to skip the Driver workflow silently.
        """
        def change(spj: Spj) -> None:
            if spj.status != "aktif":
                raise ValueError(f"cannot complete SPJ in status '{spj.status}'")
            record = _validate_override(override, actor)
            completed_at = _utc_now()
            for stop in spj.stops:
                if stop.status != "completed":
                    stop.override = record
                    stop.status = "completed"
                    stop.completed_at = completed_at
            spj.status = "selesai"
            spj.completed_at = completed_at
        return self._mutate(spj_id, change)

    def cancel(self, spj_id: str) -> Spj:
        def change(spj: Spj) -> None:
            if spj.status not in ("draft", "aktif"):
                raise ValueError(f"cannot cancel SPJ in status '{spj.status}'")
            spj.status = "batal"
        return self._mutate(spj_id, change)

    def submit_receipt(self, spj_id: str, photo_name: str, photo_b64: str,
                       total_weight_kg: float | None, operation_id: str | None,
                       actor: str | None = None,
                       replace_reason: str | None = None) -> tuple[dict, bool]:
        """Record the single current receipt for an SPJ.

        Returns (receipt, created). Replaying the same operation ID returns the
        stored receipt unchanged; a different receipt is rejected unless the
        caller asks for an audited replacement.
        """
        photo_name = (photo_name or "").strip()
        photo_b64 = (photo_b64 or "").strip()
        if not photo_name or not photo_b64:
            raise ValueError("receipt photo_name and photo_b64 are required")
        if len(photo_b64) > MAX_EVIDENCE_PHOTO_CHARS:
            raise ValueError("receipt photo_b64 exceeds 7,000,000 chars")
        outcome: dict[str, Any] = {}

        def change(spj: Spj) -> None:
            if spj.status != "selesai":
                raise ValueError("receipt can only be submitted after the SPJ is selesai")
            current = spj.receipt
            if current is not None:
                if operation_id and current.get("operation_id") == operation_id:
                    outcome["receipt"], outcome["created"] = current, False
                    return
                if not replace_reason or len(str(replace_reason).strip()) < 10:
                    raise ValueError(
                        "SPJ already has a receipt; replacing it requires a reason "
                        "of at least 10 characters")
                superseded = dict(current)
                superseded["superseded_at"] = _utc_now()
                superseded["superseded_by"] = operation_id or uuid4().hex[:12]
                superseded["superseded_reason"] = str(replace_reason).strip()
                superseded["superseded_by_actor"] = actor or "unknown"
                spj.receipt_history.append(superseded)
                sequence = int(current.get("sequence") or 1) + 1
            else:
                sequence = 1
            receipt = {
                "operation_id": operation_id or uuid4().hex[:12],
                "photo_name": photo_name,
                "photo_b64": photo_b64,
                "total_weight_kg": total_weight_kg,
                "sequence": sequence,
                "submitted_at": _utc_now(),
                "submitted_by": actor or "unknown",
            }
            spj.receipt = receipt
            outcome["receipt"], outcome["created"] = receipt, True

        self._mutate(spj_id, change)
        return outcome["receipt"], outcome["created"]

    # ── internals ────────────────────────────────────────────────────────────
    def _commit(self, spj: Spj) -> None:
        """Persist a record without re-reading it.

        Only for writing data that no public transition could produce — the
        test fixtures that reproduce pre-migration record shapes.
        """
        self._records.write(spj.spj_id, asdict(spj))

    def _mutate(self, spj_id: str, change) -> Spj:
        """Apply `change` to the stored SPJ inside one exclusive transaction.

        The read, the invariant checks and the write share a single
        `BEGIN IMMEDIATE` transaction, so a second worker cannot interleave
        between them: whichever process starts second re-reads the state the
        first one committed and has its conflicting change refused.
        """
        with self._records.transaction() as connection:
            raw = self._records.get(spj_id, connection=connection)
            if raw is None:
                raise ValueError(f"SPJ {spj_id} not found")
            spj = self._to_spj(raw)
            change(spj)
            self._records.write(spj.spj_id, asdict(spj), connection=connection)
        return spj

    def _finish_if_complete(self, spj: Spj) -> None:
        if spj.stops and all(s.status == "completed" for s in spj.stops):
            spj.status = "selesai"
            spj.completed_at = _utc_now()

    def _to_spj(self, raw: dict) -> Spj:
        payload = {k: v for k, v in raw.items()
                   if k in Spj.__dataclass_fields__}
        payload["stops"] = [
            SpjStop(**{k: v for k, v in stop.items()
                       if k in SpjStop.__dataclass_fields__})
            for stop in raw.get("stops") or []
        ]
        return Spj(**payload)


def spj_polyline(spj: Spj) -> list[tuple[float, float]] | None:
    """Stops in order + the verified destination, as a straight-segment polyline.

    Returns None when the destination has no verified coordinate: an unverified
    point must never become the reference path that deviation scoring measures
    against. Straight segments are sufficient for the 500 m detector — SPJ stops
    in Jakarta are typically >1 km apart and deviation is measured to the
    nearest segment. Road-following OSRM geometry is the Fase 4 path.
    """
    destination = route_ground_truth(spj.destination)
    if destination is None:
        return None
    points: list[tuple[float, float]] = []
    for stop in spj.stops:
        pt = (stop.lat, stop.lng)
        if not points or points[-1] != pt:
            points.append(pt)
    if not points or points[-1] != destination:
        points.append(destination)
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
    if store.count() > 0 or os.getenv("JWIS_SPJ_SEED", "on") == "off":
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
