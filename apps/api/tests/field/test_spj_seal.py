"""The SPJ audit trail is a hash chain and the receipt is checked against it on every read."""

from __future__ import annotations

import base64
import sqlite3
from contextlib import closing

from spj_testutil import fresh_store_path

from app.field.spj import SEAL_SENTINEL, SpjStore, photo_sha256, receipt_ocr_record

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
OTHER_PHOTO = "data:image/png;base64," + base64.b64encode(b"another ticket photo").decode()
STOPS = [
    {"name": "TPS 1", "kecamatan": "Gambir", "address": "Jl. 1", "lat": -6.17, "lng": 106.82},
    {"name": "TPS 2", "kecamatan": "Gambir", "address": "Jl. 2", "lat": -6.18, "lng": 106.83},
]


def _evidence(stop: dict) -> dict:
    return {
        "arrival": {
            "photo_name": "a.png",
            "photo_b64": TINY_PNG,
            "lat": stop["lat"],
            "lng": stop["lng"],
            "approx": False,
        },
        "weighing": [],
        "officer": {"name": "Petugas Contoh", "photo_name": "o.png", "photo_b64": TINY_PNG},
    }


def _closed_spj(store: SpjStore, truck: str = "T-SEAL"):
    spj = store.create_with_stops(
        "Pengemudi Sim 05", truck, "TPST Bantargebang", False, "normal", "", STOPS, created_by="dispatcher"
    )
    store.activate(spj.spj_id, actor="dispatcher")
    for i, stop in enumerate(STOPS):
        store.complete_stop(spj.spj_id, i, evidence=_evidence(stop), actor="driver")
    assert store.get(spj.spj_id).status == "selesai"
    return spj


def _with_receipt(name: str):
    """A closed SPJ with a receipt, its OCR suggestion and a reviewer's correction."""
    store = SpjStore(fresh_store_path(name))
    spj = _closed_spj(store)
    store.record_receipt(spj.spj_id, "struk.png", TINY_PNG, 15_000.0, "manual", "driver", None, 7_000.0)
    store.set_receipt_ocr(
        spj.spj_id,
        receipt_ocr_record(
            "unreviewed", result={"weight_kg": 15_100.0, "confidence": "high", "source": "stub"}
        ),
    )
    store.review_receipt(spj.spj_id, "correct", "dispatcher", 15_050.0, 7_000.0)
    return store, spj


def _sql(store: SpjStore, statement: str, params: tuple = ()) -> None:
    with closing(sqlite3.connect(store._path)) as connection, connection:
        connection.execute(statement, params)


def _audit_rows(store: SpjStore, spj_id: str) -> list[sqlite3.Row]:
    with closing(store._connect()) as connection:
        return connection.execute(
            "SELECT id, action, prev_sha256, entry_sha256 FROM spj_audit WHERE spj_id=? ORDER BY id",
            (spj_id,),
        ).fetchall()


def test_a_full_lifecycle_is_one_unbroken_chain():
    store, spj = _with_receipt("pythia_spj_seal_chain.db")
    rows = _audit_rows(store, spj.spj_id)
    actions = [r["action"] for r in rows]
    assert {"activate", "complete_stop", "receipt", "receipt_ocr", "receipt_review"} <= set(actions)
    assert rows[0]["prev_sha256"] == SEAL_SENTINEL
    for before, after in zip(rows, rows[1:], strict=False):
        assert after["prev_sha256"] == before["entry_sha256"]
    assert all(r["entry_sha256"].startswith("sha256:") and len(r["entry_sha256"]) == 71 for r in rows)

    result = store.verify(spj.spj_id)
    assert result["chain_ok"] is True and result["problems"] == []
    assert result["sealed_entries"] == len(rows) and result["legacy_unsealed"] == 0
    assert result["receipt_photo_ok"] is True and result["receipt_weights_ok"] is True
    assert result["receipt_photo_sha256"] == photo_sha256(TINY_PNG)


def test_the_receipt_entry_seals_the_decoded_photo_hash():
    store, spj = _with_receipt("pythia_spj_seal_photo_hash.db")
    receipt = next(e for e in store.audit_log(spj.spj_id) if e["action"] == "receipt")
    assert receipt["payload"]["photo_sha256"] == photo_sha256(TINY_PNG)
    # The same bytes as a data URL or bare base64 hash alike; a non-base64 string hashes as text.
    assert photo_sha256(TINY_PNG) == photo_sha256(TINY_PNG.split(",", 1)[1])
    assert photo_sha256("not base64 at all!") == photo_sha256("not base64 at all!")
    assert photo_sha256("not base64 at all!") != photo_sha256(TINY_PNG)


def test_an_spj_without_receipt_verifies_with_null_receipt_fields():
    store = SpjStore(fresh_store_path("pythia_spj_seal_noreceipt.db"))
    spj = _closed_spj(store)
    result = store.verify(spj.spj_id)
    assert result["chain_ok"] is True
    assert result["receipt_photo_ok"] is None and result["receipt_weights_ok"] is None


def test_an_edited_audit_payload_breaks_the_chain():
    store, spj = _with_receipt("pythia_spj_seal_payload.db")
    middle = _audit_rows(store, spj.spj_id)[2]["id"]
    _sql(store, "UPDATE spj_audit SET payload='{\"stop_index\": 7}' WHERE id=?", (middle,))
    result = store.verify(spj.spj_id)
    assert result["chain_ok"] is False
    assert "entry_digest_mismatch" in result["problems"]
    # Nothing is hidden: the edited row is still in the log.
    assert len(store.audit_log(spj.spj_id)) == len(_audit_rows(store, spj.spj_id))


def test_an_edited_actor_breaks_the_chain():
    store, spj = _with_receipt("pythia_spj_seal_actor.db")
    first = _audit_rows(store, spj.spj_id)[0]["id"]
    _sql(store, "UPDATE spj_audit SET actor='someone.else' WHERE id=?", (first,))
    assert store.verify(spj.spj_id)["chain_ok"] is False


def test_a_deleted_middle_row_breaks_the_chain():
    store, spj = _with_receipt("pythia_spj_seal_delete.db")
    middle = _audit_rows(store, spj.spj_id)[1]["id"]
    _sql(store, "DELETE FROM spj_audit WHERE id=?", (middle,))
    result = store.verify(spj.spj_id)
    assert result["chain_ok"] is False and "chain_broken" in result["problems"]


def test_wiping_the_seal_of_new_rows_does_not_pass_as_legacy():
    store, spj = _with_receipt("pythia_spj_seal_wipe.db")
    _sql(store, "UPDATE spj_audit SET prev_sha256=NULL, entry_sha256=NULL WHERE spj_id=?", (spj.spj_id,))
    result = store.verify(spj.spj_id)
    assert result["chain_ok"] is False and "unsealed_entry" in result["problems"]


def test_an_edited_receipt_weight_fails_the_weight_check():
    store, spj = _with_receipt("pythia_spj_seal_weight.db")
    _sql(store, "UPDATE spj_receipts SET net_weight_kg=net_weight_kg + 500 WHERE spj_id=?", (spj.spj_id,))
    result = store.verify(spj.spj_id)
    assert result["chain_ok"] is True  # the trail itself is intact; the receipt no longer matches it
    assert result["receipt_weights_ok"] is False and result["receipt_photo_ok"] is True
    assert result["problems"] == ["receipt_weights_changed"]


def test_the_latest_review_is_the_sealed_weight_reference():
    store, spj = _with_receipt("pythia_spj_seal_review_ref.db")
    # Rolling the weights back to the driver's first entry no longer matches the reviewed seal.
    _sql(
        store,
        "UPDATE spj_receipts SET gross_weight_kg=15000, total_weight_kg=15000 WHERE spj_id=?",
        (spj.spj_id,),
    )
    assert store.verify(spj.spj_id)["receipt_weights_ok"] is False


def test_a_swapped_receipt_photo_fails_the_photo_check():
    store, spj = _with_receipt("pythia_spj_seal_swap.db")
    _sql(store, "UPDATE spj_receipts SET photo_b64=? WHERE spj_id=?", (OTHER_PHOTO, spj.spj_id))
    result = store.verify(spj.spj_id)
    assert result["receipt_photo_ok"] is False and "receipt_photo_changed" in result["problems"]


def _make_legacy(path: str) -> None:
    """Rewrite spj_audit to the schema used before sealing, keeping its rows."""
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("DROP TABLE spj_audit_seal")
        connection.execute("ALTER TABLE spj_audit RENAME TO spj_audit_sealed")
        connection.execute(
            """
            CREATE TABLE spj_audit (
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
        connection.execute(
            "INSERT INTO spj_audit (id, spj_id, action, actor, reason, payload, created_at) "
            "SELECT id, spj_id, action, actor, reason, payload, created_at FROM spj_audit_sealed"
        )
        connection.execute("DROP TABLE spj_audit_sealed")


def test_a_legacy_database_with_unsealed_rows_still_verifies_and_seals_from_then_on():
    path = fresh_store_path("pythia_spj_seal_legacy.db")
    store = SpjStore(path)
    spj = store.create_with_stops(
        "Pengemudi Sim 05", "T-LEG", "TPST Bantargebang", False, "normal", "", STOPS, created_by="dispatcher"
    )
    store.activate(spj.spj_id, actor="dispatcher")
    store.complete_stop(spj.spj_id, 0, evidence=_evidence(STOPS[0]), actor="driver")
    legacy_rows = len(store.audit_log(spj.spj_id))
    _make_legacy(path)

    reopened = SpjStore(path)  # migrates: the old rows stay unsealed
    result = reopened.verify(spj.spj_id)
    assert result["chain_ok"] is True and result["problems"] == []
    assert result["legacy_unsealed"] == legacy_rows and result["sealed_entries"] == 0

    reopened.complete_stop(spj.spj_id, 1, evidence=_evidence(STOPS[1]), actor="driver")
    sealed = [r for r in _audit_rows(reopened, spj.spj_id) if r["entry_sha256"]]
    assert sealed and sealed[0]["prev_sha256"] == SEAL_SENTINEL
    result = reopened.verify(spj.spj_id)
    assert result["chain_ok"] is True and result["sealed_entries"] == len(sealed)
    assert result["legacy_unsealed"] == legacy_rows


def test_a_legacy_receipt_has_unknown_receipt_seal_results():
    path = fresh_store_path("pythia_spj_seal_legacy_receipt.db")
    store = SpjStore(path)
    spj = _closed_spj(store, "T-LEG-R")
    store.record_receipt(spj.spj_id, "struk.png", TINY_PNG, 15_000.0, "manual", "driver")
    _make_legacy(path)
    result = SpjStore(path).verify(spj.spj_id)
    assert result["chain_ok"] is True
    assert result["receipt_photo_ok"] is None and result["receipt_weights_ok"] is None
    assert result["receipt_photo_sha256"] is None
