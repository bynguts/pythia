"""Reviewer-side receipt OCR: a labelled suggestion that a dispatcher or supervisor signs off.

The OCR call is stubbed throughout; no test reaches a vision service.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing

import pytest
from spj_testutil import fresh_store_path

from app.field import timbangan_ocr
from app.field.spj import RECEIPT_OCR_CLASSIFICATION, SpjStore, receipt_ocr_record

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _evidence(lat: float, lng: float) -> dict:
    return {
        "arrival": {"photo_name": "a.png", "photo_b64": TINY_PNG, "lat": lat, "lng": lng, "approx": False},
        "weighing": [],
        "officer": {"name": "Petugas Contoh", "photo_name": "o.png", "photo_b64": TINY_PNG},
    }


STOPS = [
    {"name": "TPS 1", "kecamatan": "Gambir", "address": "Jl. 1", "lat": -6.17, "lng": 106.82},
    {"name": "TPS 2", "kecamatan": "Gambir", "address": "Jl. 2", "lat": -6.18, "lng": 106.83},
]


def _finished_spj(api_client, auth_headers, truck: str) -> str:
    admin, driver = auth_headers("administrator"), auth_headers("driver")
    created = api_client.post(
        "/api/spj",
        json={
            "driver_name": "Pengemudi Sim 07",
            "truck_code": truck,
            "destination": "TPST Bantargebang",
            "stops": STOPS,
        },
        headers=admin,
    )
    assert created.status_code == 201, created.text
    spj_id = created.json()["spj_id"]
    assert api_client.post(f"/api/spj/{spj_id}/activate", headers=admin).status_code == 200
    for i, stop in enumerate(STOPS):
        res = api_client.post(
            f"/api/spj/{spj_id}/stops/{i}/complete",
            json={"evidence": _evidence(stop["lat"], stop["lng"])},
            headers=driver,
        )
        assert res.status_code == 200, res.text
    return spj_id


@pytest.fixture()
def ocr_reads(monkeypatch):
    """OCR engine configured; each read returns the stubbed answer and is recorded."""
    calls: list[str] = []
    answer = {
        "weight_kg": 15_200.0,
        "raw_text": '{"weight_kg": 15200}',
        "confidence": "high",
        "source": "stub",
    }

    def read(photo_b64, http_post=None):
        calls.append(photo_b64)
        return dict(answer)

    monkeypatch.setattr(timbangan_ocr, "is_configured", lambda: True)
    monkeypatch.setattr(timbangan_ocr, "read_weight_from_photo", read)
    return calls


def _receipt(api_client, auth_headers, spj_id: str) -> dict:
    return api_client.get(f"/api/spj/{spj_id}", headers=auth_headers("administrator")).json()["receipt"]


def test_ocr_reading_is_stored_as_a_suggestion_and_not_applied(api_client, auth_headers, ocr_reads):
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-SUG")
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={"photo_name": "struk.png", "photo_b64": TINY_PNG},
        headers=auth_headers("driver"),
    )
    assert res.status_code == 201, res.text
    # The POST answers before the OCR runs.
    assert res.json()["receipt"]["ocr"]["status"] == "pending"
    assert ocr_reads == [TINY_PNG]

    receipt = _receipt(api_client, auth_headers, spj_id)
    ocr = receipt["ocr"]
    assert ocr["status"] == "unreviewed"
    assert ocr["gross_kg"] == 15_200.0 and ocr["tare_kg"] is None and ocr["net_kg"] is None
    assert ocr["classification"] == RECEIPT_OCR_CLASSIFICATION == "MODEL_OUTPUT"
    assert "MODEL OUTPUT" in ocr["label"]
    assert ocr["reviewed_by"] is None and ocr["confidence"] == "high"
    # No typed weight: the recorded weights stay null until a reviewer confirms.
    assert receipt["gross_weight_kg"] is None and receipt["net_weight_kg"] is None
    assert "raw_text" not in ocr
    # The list projection carries the suggestion too (the dashboard reads it from there).
    listed = api_client.get("/api/spj?truck_code=T-OCR-SUG", headers=auth_headers("dispatcher")).json()
    assert listed["spj"][0]["receipt"]["ocr"]["status"] == "unreviewed"


def test_confirm_copies_the_ocr_gross_and_keeps_the_suggestion(api_client, auth_headers, ocr_reads):
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-OK")
    api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={"photo_name": "struk.png", "photo_b64": TINY_PNG},
        headers=auth_headers("driver"),
    )
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}, headers=auth_headers("dispatcher")
    )
    assert res.status_code == 200, res.text
    receipt = res.json()["receipt"]
    assert receipt["gross_weight_kg"] == 15_200.0 and receipt["total_weight_kg"] == 15_200.0
    assert receipt["net_weight_kg"] is None  # no tare was recorded
    assert receipt["weight_source"] == "ocr_confirmed"
    assert receipt["ocr"]["status"] == "confirmed" and receipt["ocr"]["reviewed_by"] == "dispatcher"
    assert receipt["ocr"]["reviewed_at"] and receipt["ocr"]["gross_kg"] == 15_200.0

    audit = api_client.get(f"/api/spj/{spj_id}/audit", headers=auth_headers("administrator")).json()["audit"]
    review = [e for e in audit if e["action"] == "receipt_review"]
    assert len(review) == 1 and review[0]["actor"] == "dispatcher"
    assert review[0]["payload"]["previous"]["gross_weight_kg"] is None
    assert review[0]["payload"]["ocr_suggestion"]["gross_kg"] == 15_200.0

    again = api_client.post(
        f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}, headers=auth_headers("supervisor")
    )
    assert again.status_code == 409


def test_correct_records_the_typed_weights_and_ocr_never_overwrites_driver_weights(
    api_client, auth_headers, ocr_reads
):
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-FIX")
    api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={
            "photo_name": "struk.png",
            "photo_b64": TINY_PNG,
            "total_weight_kg": 15_000,
            "tare_weight_kg": 9_000,
            "weight_source": "manual",
        },
        headers=auth_headers("driver"),
    )
    before = _receipt(api_client, auth_headers, spj_id)
    assert before["ocr"]["gross_kg"] == 15_200.0
    assert (before["gross_weight_kg"], before["tare_weight_kg"], before["net_weight_kg"]) == (
        15_000,
        9_000,
        6_000,
    )

    bad = api_client.post(
        f"/api/spj/{spj_id}/receipt/review",
        json={"action": "correct", "gross_weight_kg": 9_000, "tare_weight_kg": 9_500},
        headers=auth_headers("supervisor"),
    )
    assert bad.status_code == 409
    assert (
        api_client.post(
            f"/api/spj/{spj_id}/receipt/review",
            json={"action": "correct"},
            headers=auth_headers("supervisor"),
        ).status_code
        == 409
    )

    res = api_client.post(
        f"/api/spj/{spj_id}/receipt/review",
        json={"action": "correct", "gross_weight_kg": 15_100, "tare_weight_kg": 9_100},
        headers=auth_headers("supervisor"),
    )
    assert res.status_code == 200, res.text
    receipt = res.json()["receipt"]
    assert (receipt["gross_weight_kg"], receipt["tare_weight_kg"], receipt["net_weight_kg"]) == (
        15_100,
        9_100,
        6_000,
    )
    assert receipt["weight_source"] == "reviewer_corrected"
    assert receipt["ocr"]["status"] == "corrected" and receipt["ocr"]["reviewed_by"] == "supervisor"
    assert receipt["ocr"]["gross_kg"] == 15_200.0  # the suggestion stays for audit


def test_review_needs_dispatch_create(api_client, auth_headers, ocr_reads):
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-403")
    api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={"photo_name": "struk.png", "photo_b64": TINY_PNG},
        headers=auth_headers("driver"),
    )
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}, headers=auth_headers("driver")
    )
    assert res.status_code == 403
    assert api_client.post(f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}).status_code == 401
    assert _receipt(api_client, auth_headers, spj_id)["ocr"]["status"] == "unreviewed"


def test_review_without_a_receipt_is_404(api_client, auth_headers):
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-NONE")
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}, headers=auth_headers("dispatcher")
    )
    assert res.status_code == 404


def test_unconfigured_ocr_is_unavailable_and_never_fails_the_post(api_client, auth_headers, monkeypatch):
    def must_not_run(*_args, **_kwargs):
        raise AssertionError("OCR must not be called without an engine")

    monkeypatch.setattr(timbangan_ocr, "is_configured", lambda: False)
    monkeypatch.setattr(timbangan_ocr, "read_weight_from_photo", must_not_run)
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-OFF")
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={"photo_name": "struk.png", "photo_b64": TINY_PNG},
        headers=auth_headers("driver"),
    )
    assert res.status_code == 201, res.text
    ocr = res.json()["receipt"]["ocr"]
    assert ocr["status"] == "unavailable" and "GUTS_API_KEY" in ocr["reason"]
    assert ocr["gross_kg"] is None

    # Nothing to confirm; the reviewer reads the photo and corrects instead.
    headers = auth_headers("dispatcher")
    confirm = api_client.post(
        f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}, headers=headers
    )
    assert confirm.status_code == 409
    fixed = api_client.post(
        f"/api/spj/{spj_id}/receipt/review",
        json={"action": "correct", "gross_weight_kg": 14_000},
        headers=headers,
    )
    assert fixed.status_code == 200 and fixed.json()["receipt"]["gross_weight_kg"] == 14_000


def test_an_ocr_crash_is_filed_as_unavailable(api_client, auth_headers, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("vision service exploded")

    monkeypatch.setattr(timbangan_ocr, "is_configured", lambda: True)
    monkeypatch.setattr(timbangan_ocr, "read_weight_from_photo", broken)
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-ERR")
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={"photo_name": "struk.png", "photo_b64": TINY_PNG},
        headers=auth_headers("driver"),
    )
    assert res.status_code == 201, res.text
    ocr = _receipt(api_client, auth_headers, spj_id)["ocr"]
    assert ocr["status"] == "unavailable" and ocr["reason"]


def test_an_unreadable_ticket_is_unavailable_not_a_number(api_client, auth_headers, monkeypatch):
    monkeypatch.setattr(timbangan_ocr, "is_configured", lambda: True)
    monkeypatch.setattr(
        timbangan_ocr,
        "read_weight_from_photo",
        lambda *_a, **_k: {"weight_kg": None, "raw_text": "blurry", "confidence": "low", "source": "stub"},
    )
    spj_id = _finished_spj(api_client, auth_headers, "T-OCR-LOW")
    api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={"photo_name": "struk.png", "photo_b64": TINY_PNG},
        headers=auth_headers("driver"),
    )
    ocr = _receipt(api_client, auth_headers, spj_id)["ocr"]
    assert ocr["status"] == "unavailable" and ocr["gross_kg"] is None and ocr["confidence"] == "low"


def test_a_late_ocr_result_keeps_an_earlier_correction():
    store = SpjStore(fresh_store_path("pythia_spj_ocr_late.db"))
    spj = store.create_with_stops(
        "Pengemudi Sim 07", "T-OCR-LATE", "TPST Bantargebang", False, "normal", "", STOPS, created_by="d"
    )
    store.activate(spj.spj_id, actor="d")
    for i, stop in enumerate(STOPS):
        store.complete_stop(spj.spj_id, i, evidence=_evidence(stop["lat"], stop["lng"]))
    store.record_receipt(
        spj.spj_id, "s.png", TINY_PNG, None, "unspecified", ocr=receipt_ocr_record("pending")
    )
    store.review_receipt(spj.spj_id, "correct", "supervisor", gross_weight_kg=12_000.0)
    late = store.set_receipt_ocr(
        spj.spj_id,
        receipt_ocr_record(
            "unreviewed", result={"weight_kg": 12_500.0, "confidence": "high", "source": "stub"}
        ),
    )
    assert late.receipt["ocr"]["status"] == "corrected" and late.receipt["ocr"]["reviewed_by"] == "supervisor"
    assert late.receipt["ocr"]["gross_kg"] == 12_500.0
    assert late.receipt["gross_weight_kg"] == 12_000.0


# --- migration ------------------------------------------------------------------

_OLD_RECEIPT_COLUMNS = (
    "spj_id, photo_name, photo_b64, total_weight_kg, weight_source, submitted_by, operation_id, recorded_at"
)


def test_an_old_database_gains_the_ocr_column_and_its_receipts_stay_reviewable():
    path = fresh_store_path("pythia_spj_ocr_migrate.db")
    store = SpjStore(path)
    spj = store.create_with_stops(
        "Pengemudi Sim 07", "T-OCR-OLD", "TPST Bantargebang", False, "normal", "", STOPS, created_by="d"
    )
    store.activate(spj.spj_id, actor="d")
    for i, stop in enumerate(STOPS):
        store.complete_stop(spj.spj_id, i, evidence=_evidence(stop["lat"], stop["lng"]))
    store.record_receipt(spj.spj_id, "s.png", TINY_PNG, 13_000.0, "manual")
    # Rebuild spj_receipts in its pre-H10, pre-OCR shape.
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(f"CREATE TABLE old_receipts AS SELECT {_OLD_RECEIPT_COLUMNS} FROM spj_receipts")
        connection.execute("DROP TABLE spj_receipts")
        connection.execute("ALTER TABLE old_receipts RENAME TO spj_receipts")

    migrated = SpjStore(path)
    SpjStore(path)  # a second opener finds the columns already there
    with closing(sqlite3.connect(path)) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(spj_receipts)")}
    assert {"ocr", "gross_weight_kg", "tare_weight_kg", "net_weight_kg"} <= columns
    receipt = migrated.get(spj.spj_id).receipt
    assert receipt["ocr"] is None and receipt["total_weight_kg"] == 13_000.0

    with pytest.raises(ValueError, match="no OCR weight"):
        migrated.review_receipt(spj.spj_id, "confirm", "dispatcher")
    done = migrated.review_receipt(spj.spj_id, "correct", "dispatcher", gross_weight_kg=13_100.0)
    assert done.receipt["gross_weight_kg"] == 13_100.0 and done.receipt["ocr"]["status"] == "corrected"


class _StaleColumns:
    """A connection whose PRAGMA still shows the old columns: another worker migrated meanwhile."""

    def __init__(self, connection: sqlite3.Connection, stale_rows: list) -> None:
        self._connection = connection
        self._stale_rows = stale_rows

    def execute(self, sql: str, *args):
        if sql.startswith("PRAGMA table_info(spj_receipts)"):
            return self._stale_rows
        return self._connection.execute(sql, *args)


def test_two_workers_migrating_the_same_old_database_do_not_fail():
    path = fresh_store_path("pythia_spj_ocr_race.db")
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(
            "CREATE TABLE spj_receipts (spj_id TEXT PRIMARY KEY, photo_name TEXT NOT NULL, photo_b64 TEXT NOT NULL, "
            "total_weight_kg REAL, weight_source TEXT NOT NULL, submitted_by TEXT NOT NULL, "
            "operation_id TEXT, recorded_at TEXT NOT NULL)"
        )
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.row_factory = sqlite3.Row
        stale = connection.execute("PRAGMA table_info(spj_receipts)").fetchall()
        # The other worker gets there first.
        SpjStore._migrate_receipt_columns(connection)
        SpjStore._migrate_receipt_columns(_StaleColumns(connection, stale))
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(spj_receipts)")}
    assert {"ocr", "gross_weight_kg", "tare_weight_kg", "net_weight_kg"} <= columns
