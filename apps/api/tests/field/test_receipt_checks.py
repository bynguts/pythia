"""Rule checks on a weighbridge receipt, the integrity route and the Needs-you item they raise."""

from __future__ import annotations

import base64
import json
import sqlite3
from contextlib import closing
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.core.auth import hash_password
from app.core.units import TRUCK_CAPACITY_TONS
from app.field import needs_you as feed
from app.field.receipt_checks import receipt_checks
from app.field.spj import SPJ_STORE

SPJ = SimpleNamespace(spj_id="spj-a", spj_number="SPJ/000001", truck_code="T-001")
SEALED = {
    "chain_ok": True,
    "sealed_entries": 6,
    "legacy_unsealed": 0,
    "receipt_photo_ok": True,
    "receipt_weights_ok": True,
    "receipt_photo_sha256": "sha256:" + "a" * 64,
    "problems": [],
}
CAPACITY_KG = TRUCK_CAPACITY_TONS * 1000


def _receipt(gross=15_000.0, tare=7_000.0, net=8_000.0, ocr_gross=None) -> dict:
    return {
        "total_weight_kg": gross,
        "gross_weight_kg": gross,
        "tare_weight_kg": tare,
        "net_weight_kg": net,
        "ocr": {"gross_kg": ocr_gross} if ocr_gross is not None else None,
    }


def _check(result: dict, check_id: str) -> dict:
    return next(c for c in result["checks"] if c["id"] == check_id)


def test_a_clean_sealed_receipt_is_ok_and_every_check_has_its_numbers():
    result = receipt_checks(SPJ, _receipt(ocr_gross=15_100.0), SEALED, {})
    assert result["overall"] == "ok"
    assert [c["id"] for c in result["checks"]] == [
        "ticket_document",
        "ocr_vs_entered",
        "ticket_arithmetic",
        "net_vs_capacity",
        "duplicate_ticket_no",
        "duplicate_ticket",
        "sealed",
        "plate_vs_truck",
    ]
    for check in result["checks"]:
        assert set(check) == {"id", "state", "detail", "uses_ocr", "numbers"} and check["detail"]
    assert "not AI" in result["basis"] and "MODEL OUTPUT" in result["basis"]
    # Checks that read the ticket OCR say so; the seal and capacity checks read recorded data only.
    assert _check(result, "ocr_vs_entered")["uses_ocr"] and not _check(result, "sealed")["uses_ocr"]
    assert result["integrity"]["chain_ok"] is True


def test_ocr_within_two_percent_or_200_kg_passes_and_beyond_fails():
    # 2 % of 15,000 kg is 300 kg: 290 kg apart passes, 310 kg apart fails.
    assert (
        _check(receipt_checks(SPJ, _receipt(ocr_gross=15_290.0), SEALED, {}), "ocr_vs_entered")["state"]
        == "pass"
    )
    over = receipt_checks(SPJ, _receipt(ocr_gross=15_310.0), SEALED, {})
    check = _check(over, "ocr_vs_entered")
    assert check["state"] == "fail" and over["overall"] == "review"
    assert check["numbers"]["tolerance_kg"] == 300.0 and check["numbers"]["difference_kg"] == 310.0
    # Below 10 t the 200 kg floor applies.
    light = _receipt(gross=5_000.0, tare=None, net=None, ocr_gross=5_190.0)
    assert _check(receipt_checks(SPJ, light, SEALED, {}), "ocr_vs_entered")["state"] == "pass"
    light["ocr"]["gross_kg"] = 5_210.0
    assert _check(receipt_checks(SPJ, light, SEALED, {}), "ocr_vs_entered")["state"] == "fail"


def test_ocr_check_is_unknown_without_an_ocr_reading():
    check = _check(receipt_checks(SPJ, _receipt(), SEALED, {}), "ocr_vs_entered")
    assert check["state"] == "unknown"


def test_net_above_the_truck_capacity_fails():
    over = CAPACITY_KG + 500
    result = receipt_checks(SPJ, _receipt(gross=over + 7_000, tare=7_000.0, net=over), SEALED, {})
    check = _check(result, "net_vs_capacity")
    assert check["state"] == "fail" and check["numbers"]["capacity_kg"] == CAPACITY_KG
    assert result["overall"] == "review"
    # The stored net agrees, but gross minus tare is also checked on its own.
    tampered = _receipt(gross=over + 7_000, tare=7_000.0, net=8_000.0)
    assert _check(receipt_checks(SPJ, tampered, SEALED, {}), "net_vs_capacity")["state"] == "fail"


def test_net_within_capacity_passes_and_no_tare_is_unknown():
    assert _check(receipt_checks(SPJ, _receipt(), SEALED, {}), "net_vs_capacity")["state"] == "pass"
    no_tare = _receipt(tare=None, net=None)
    assert _check(receipt_checks(SPJ, no_tare, SEALED, {}), "net_vs_capacity")["state"] == "unknown"


def test_a_ticket_photo_sealed_on_another_spj_fails_the_duplicate_check():
    others = {SEALED["receipt_photo_sha256"]: [{"spj_id": "spj-b", "spj_number": "SPJ/000002"}]}
    result = receipt_checks(SPJ, _receipt(), SEALED, others)
    check = _check(result, "duplicate_ticket")
    assert check["state"] == "fail" and "SPJ/000002" in check["detail"]
    assert result["overall"] == "review"
    assert _check(receipt_checks(SPJ, _receipt(), SEALED, {}), "duplicate_ticket")["state"] == "pass"


def test_a_broken_seal_fails_the_sealed_check():
    broken = {**SEALED, "chain_ok": False, "problems": ["entry_digest_mismatch"]}
    check = _check(receipt_checks(SPJ, _receipt(), broken, {}), "sealed")
    assert check["state"] == "fail" and "entry_digest_mismatch" in check["detail"]
    swapped = {**SEALED, "receipt_photo_ok": False, "problems": ["receipt_photo_changed"]}
    assert _check(receipt_checks(SPJ, _receipt(), swapped, {}), "sealed")["state"] == "fail"
    assert _check(receipt_checks(SPJ, _receipt(), SEALED, {}), "sealed")["state"] == "pass"


def test_a_receipt_recorded_before_sealing_is_unknown_not_ok():
    legacy = {
        **SEALED,
        "sealed_entries": 0,
        "receipt_photo_ok": None,
        "receipt_weights_ok": None,
        "receipt_photo_sha256": None,
    }
    result = receipt_checks(SPJ, _receipt(), legacy, {})
    assert _check(result, "sealed")["state"] == "unknown"
    assert _check(result, "duplicate_ticket")["state"] == "unknown"
    assert result["overall"] == "unknown"


def test_plate_check_is_unknown_without_an_ocr_plate_and_compares_it_when_read():
    check = _check(receipt_checks(SPJ, _receipt(), SEALED, {}), "plate_vs_truck")
    assert check["state"] == "unknown" and check["numbers"]["truck_code"] == "T-001"
    read = _receipt()
    read["ocr"] = {"plate": "b 1234-cd"}
    assert _check(receipt_checks(SPJ, read, SEALED, {}), "plate_vs_truck")["state"] == "unknown"
    assert _check(receipt_checks(SPJ, read, SEALED, {}, {}, "B 1234 CD"), "plate_vs_truck")["state"] == "pass"
    other = receipt_checks(SPJ, read, SEALED, {}, {}, "B 9999 ZZ")
    assert _check(other, "plate_vs_truck")["state"] == "fail" and other["overall"] == "review"


def _ticket(**ocr) -> dict:
    receipt = _receipt()
    receipt["ocr"] = ocr
    return receipt


def test_ticket_arithmetic_checks_gross_minus_tare_against_the_printed_net():
    good = _ticket(gross_kg=15_000.0, tare_kg=7_000.0, net_kg=8_010.0)
    assert _check(receipt_checks(SPJ, good, SEALED, {}), "ticket_arithmetic")["state"] == "pass"
    bad = receipt_checks(SPJ, _ticket(gross_kg=15_000.0, tare_kg=7_000.0, net_kg=9_000.0), SEALED, {})
    check = _check(bad, "ticket_arithmetic")
    assert check["state"] == "fail" and check["numbers"]["difference_kg"] == 1_000.0
    assert bad["overall"] == "review"
    partial = _ticket(gross_kg=15_000.0, tare_kg=None, net_kg=8_000.0)
    assert _check(receipt_checks(SPJ, partial, SEALED, {}), "ticket_arithmetic")["state"] == "unknown"


def test_the_same_ticket_number_on_another_spj_fails():
    receipt = _ticket(ticket_no="tb-00042")
    others = {"TB00042": [{"spj_id": "spj-b", "spj_number": "SPJ/000002"}]}
    check = _check(receipt_checks(SPJ, receipt, SEALED, {}, others), "duplicate_ticket_no")
    assert check["state"] == "fail" and "SPJ/000002" in check["detail"]
    assert _check(receipt_checks(SPJ, receipt, SEALED, {}, {}), "duplicate_ticket_no")["state"] == "pass"
    assert _check(receipt_checks(SPJ, _receipt(), SEALED, {}), "duplicate_ticket_no")["state"] == "unknown"


def test_a_photo_that_is_not_a_ticket_fails_and_a_scale_display_is_unknown():
    result = receipt_checks(SPJ, _ticket(document="not_a_ticket"), SEALED, {})
    assert _check(result, "ticket_document")["state"] == "fail" and result["overall"] == "review"
    ticket = _ticket(document="weighbridge_ticket")
    assert _check(receipt_checks(SPJ, ticket, SEALED, {}), "ticket_document")["state"] == "pass"
    for document in ("scale_display", "unreadable", None):
        receipt = _ticket(document=document)
        assert _check(receipt_checks(SPJ, receipt, SEALED, {}), "ticket_document")["state"] == "unknown"


# -- through the API ---------------------------------------------------------

STOPS = [{"name": "TPS Segel", "kecamatan": "Gambir", "address": "Jl. Segel", "lat": -6.17, "lng": 106.82}]
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _unique_photo() -> str:
    return "data:image/png;base64," + base64.b64encode(f"ticket {uuid4().hex}".encode()).decode()


def _closed_spj(api_client, auth_headers, truck: str) -> str:
    admin = auth_headers("administrator")
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
    evidence = {
        "arrival": {
            "photo_name": "a.png",
            "photo_b64": TINY_PNG,
            "lat": -6.17,
            "lng": 106.82,
            "approx": False,
        },
        "weighing": [],
        "officer": {"name": "Petugas Contoh", "photo_name": "o.png", "photo_b64": TINY_PNG},
    }
    res = api_client.post(
        f"/api/spj/{spj_id}/stops/0/complete", json={"evidence": evidence}, headers=auth_headers("driver")
    )
    assert res.status_code == 200, res.text
    return spj_id


def _submit(api_client, auth_headers, spj_id: str, photo: str, gross=15_000.0, tare=7_000.0) -> dict:
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={
            "photo_name": "struk.png",
            "photo_b64": photo,
            "total_weight_kg": gross,
            "tare_weight_kg": tare,
            "weight_source": "manual",
        },
        headers=auth_headers("driver"),
    )
    assert res.status_code == 201, res.text
    return res.json()["receipt"]


@pytest.fixture()
def truck() -> str:
    return f"RC-{uuid4().hex[:6]}"


@pytest.fixture()
def _no_gate_board(monkeypatch):
    monkeypatch.setattr(feed, "_gate_peaks", lambda day, follow_ups: [])


def test_the_receipt_payload_carries_its_checks(api_client, auth_headers, truck):
    spj_id = _closed_spj(api_client, auth_headers, truck)
    receipt = _submit(api_client, auth_headers, spj_id, _unique_photo())
    assert receipt["checks"]["overall"] == "ok"
    detail = api_client.get(f"/api/spj/{spj_id}", headers=auth_headers("dispatcher")).json()["receipt"]
    assert _check(detail["checks"], "sealed")["state"] == "pass"
    summary = api_client.get(f"/api/spj/{spj_id}/evidence-summary", headers=auth_headers("dispatcher")).json()
    assert summary["receipt"]["checks"]["overall"] == "ok"


def test_the_same_ticket_on_two_spjs_is_flagged_on_both_and_raised_in_needs_you(
    api_client, auth_headers, truck, _no_gate_board
):
    photo = _unique_photo()
    first = _closed_spj(api_client, auth_headers, truck)
    second = _closed_spj(api_client, auth_headers, truck)
    _submit(api_client, auth_headers, first, photo)
    receipt = _submit(api_client, auth_headers, second, photo)
    check = _check(receipt["checks"], "duplicate_ticket")
    assert check["state"] == "fail" and receipt["checks"]["overall"] == "review"
    assert [o["spj_id"] for o in check["numbers"]["other_spj"]] == [first]
    again = api_client.get(f"/api/spj/{first}", headers=auth_headers("dispatcher")).json()["receipt"]
    assert _check(again["checks"], "duplicate_ticket")["state"] == "fail"

    body = api_client.get("/api/ops/needs-you", headers=auth_headers("dispatcher")).json()
    mine = [i for i in body["items"] if i["truck_code"] == truck]
    assert {i["id"] for i in mine} == {f"receipt-check:{first}", f"receipt-check:{second}"}
    item = next(i for i in mine if i["spj_id"] == second)
    assert item["kind"] == "receipt_check" and item["category"] == "gate"
    assert item["classification"] == "FIELD" and item["severity"] == "normal"
    assert item["actions"] == ["mark_handled"]
    assert [f["id"] for f in item["facts"]["failed"]] == ["duplicate_ticket"]
    assert item["facts"]["spj_number"] and "not AI" in item["facts"]["basis"]

    res = api_client.post(
        "/api/alert/follow-up",
        json={"alert_id": item["id"], "status": "RESOLVED"},
        headers=auth_headers("dispatcher"),
    )
    assert res.status_code == 200
    body = api_client.get("/api/ops/needs-you", headers=auth_headers("dispatcher")).json()
    assert [i["spj_id"] for i in body["items"] if i["truck_code"] == truck] == [first]


def test_a_tampered_receipt_is_an_urgent_needs_you_item(api_client, auth_headers, truck, _no_gate_board):
    spj_id = _closed_spj(api_client, auth_headers, truck)
    _submit(api_client, auth_headers, spj_id, _unique_photo())
    with closing(sqlite3.connect(SPJ_STORE._path)) as connection, connection:
        connection.execute("UPDATE spj_receipts SET net_weight_kg=1 WHERE spj_id=?", (spj_id,))
    body = api_client.get("/api/ops/needs-you", headers=auth_headers("dispatcher")).json()
    [item] = [i for i in body["items"] if i["truck_code"] == truck]
    assert item["severity"] == "urgent"
    assert [f["id"] for f in item["facts"]["failed"]] == ["sealed"]


def test_the_integrity_route_reports_the_seal(api_client, auth_headers, truck):
    spj_id = _closed_spj(api_client, auth_headers, truck)
    _submit(api_client, auth_headers, spj_id, _unique_photo())
    res = api_client.get(f"/api/spj/{spj_id}/integrity", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["chain_ok"] is True and body["problems"] == []
    assert body["receipt_photo_ok"] is True and body["receipt_weights_ok"] is True
    assert body["head_sha256"].startswith("sha256:") and len(body["head_sha256"]) == 71

    with closing(sqlite3.connect(SPJ_STORE._path)) as connection, connection:
        row = connection.execute(
            "SELECT id, payload FROM spj_audit WHERE spj_id=? AND action='receipt'", (spj_id,)
        ).fetchone()
        payload = json.loads(row[1])
        payload["total_weight_kg"] = 9_999.0
        connection.execute("UPDATE spj_audit SET payload=? WHERE id=?", (json.dumps(payload), row[0]))
    body = api_client.get(f"/api/spj/{spj_id}/integrity", headers=auth_headers("administrator")).json()
    assert body["chain_ok"] is False and "entry_digest_mismatch" in body["problems"]


def test_the_integrity_route_needs_a_session_and_the_truck(
    api_client, auth_headers, truck, tmp_path, monkeypatch
):
    spj_id = _closed_spj(api_client, auth_headers, truck)
    assert api_client.get(f"/api/spj/{spj_id}/integrity").status_code == 401
    assert (
        api_client.get("/api/spj/does-not-exist/integrity", headers=auth_headers("dispatcher")).status_code
        == 404
    )
    path = tmp_path / "users.json"
    path.write_text(
        json.dumps(
            {
                "users": [
                    {
                        "username": "sopir.segel",
                        "password_hash": hash_password("rahasia-segel-1", iterations=1_000),
                        "role": "driver",
                        "truck_code": f"{truck}-X",
                        "display_name": "Pengemudi Uji",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHIA_USERS_FILE", str(path))
    login = api_client.post(
        "/api/auth/login", json={"username": "sopir.segel", "password": "rahasia-segel-1"}
    )
    assert login.status_code == 200, login.text
    other_truck = {"Authorization": f"Bearer {login.json()['token']}"}
    assert api_client.get(f"/api/spj/{spj_id}/integrity", headers=other_truck).status_code == 403
    # The same read set as the audit route: a supervisor and the shared driver account may read it.
    assert (
        api_client.get(f"/api/spj/{spj_id}/integrity", headers=auth_headers("supervisor")).status_code == 200
    )
    assert api_client.get(f"/api/spj/{spj_id}/integrity", headers=auth_headers("driver")).status_code == 200


def _ocr_reads(monkeypatch, **reading):
    from app.field import timbangan_ocr

    result = {"weight_kg": None, "raw_text": "{}", "confidence": "high", "source": "stub", **reading}
    monkeypatch.setattr(timbangan_ocr, "is_configured", lambda: True)
    monkeypatch.setattr(timbangan_ocr, "read_weight_from_photo", lambda *_a, **_k: result)


def test_the_ticket_ocr_fields_are_stored_as_model_output_and_cross_checked(
    api_client, auth_headers, truck, monkeypatch
):
    _ocr_reads(
        monkeypatch,
        gross_kg=15_050.0,
        tare_kg=7_000.0,
        net_kg=9_050.0,
        ticket_no=f"TB-{uuid4().hex[:8]}",
        plate=None,
        weighed_in_at="2026-10-27T08:00:00+07:00",
        weighed_out_at="2026-10-27T08:20:00+07:00",
        site="TPST Bantargebang",
        document="weighbridge_ticket",
    )
    spj_id = _closed_spj(api_client, auth_headers, truck)
    _submit(api_client, auth_headers, spj_id, _unique_photo())
    receipt = api_client.get(f"/api/spj/{spj_id}", headers=auth_headers("dispatcher")).json()["receipt"]
    ocr = receipt["ocr"]
    assert ocr["status"] == "unreviewed" and ocr["classification"] == "MODEL_OUTPUT"
    assert ocr["gross_kg"] == 15_050.0 and ocr["tare_kg"] == 7_000.0 and ocr["net_kg"] == 9_050.0
    assert ocr["site"] == "TPST Bantargebang" and ocr["document"] == "weighbridge_ticket"
    # The OCR never becomes the recorded weight on its own.
    assert receipt["gross_weight_kg"] == 15_000.0
    checks = receipt["checks"]
    assert _check(checks, "ocr_vs_entered")["state"] == "pass"
    # 15,050 - 7,000 is 8,050, not the 9,050 printed: the ticket itself does not add up.
    assert _check(checks, "ticket_arithmetic")["state"] == "fail"
    assert _check(checks, "duplicate_ticket_no")["state"] == "pass"


def test_the_same_ocr_ticket_number_on_two_spjs_is_flagged(api_client, auth_headers, truck, monkeypatch):
    _ocr_reads(
        monkeypatch, gross_kg=15_000.0, ticket_no=f"TB-{uuid4().hex[:8]}", document="weighbridge_ticket"
    )
    first = _closed_spj(api_client, auth_headers, truck)
    second = _closed_spj(api_client, auth_headers, truck)
    _submit(api_client, auth_headers, first, _unique_photo())
    _submit(api_client, auth_headers, second, _unique_photo())
    receipt = api_client.get(f"/api/spj/{second}", headers=auth_headers("dispatcher")).json()["receipt"]
    check = _check(receipt["checks"], "duplicate_ticket_no")
    assert check["state"] == "fail" and [o["spj_id"] for o in check["numbers"]["other_spj"]] == [first]


def test_a_photo_the_ocr_calls_not_a_ticket_leaves_nothing_to_confirm(
    api_client, auth_headers, truck, monkeypatch
):
    _ocr_reads(monkeypatch, gross_kg=12_000.0, document="not_a_ticket")
    spj_id = _closed_spj(api_client, auth_headers, truck)
    _submit(api_client, auth_headers, spj_id, _unique_photo())
    receipt = api_client.get(f"/api/spj/{spj_id}", headers=auth_headers("dispatcher")).json()["receipt"]
    assert (
        receipt["ocr"]["status"] == "unavailable" and "not a weighbridge ticket" in receipt["ocr"]["reason"]
    )
    assert _check(receipt["checks"], "ticket_document")["state"] == "fail"
    confirm = api_client.post(
        f"/api/spj/{spj_id}/receipt/review", json={"action": "confirm"}, headers=auth_headers("dispatcher")
    )
    assert confirm.status_code == 409


def test_without_an_ocr_engine_the_reason_names_no_provider(api_client, auth_headers, truck, monkeypatch):
    from app.field import timbangan_ocr

    monkeypatch.setattr(timbangan_ocr, "is_configured", lambda: False)
    spj_id = _closed_spj(api_client, auth_headers, truck)
    ocr = _submit(api_client, auth_headers, spj_id, _unique_photo())["ocr"]
    assert ocr["status"] == "unavailable" and "not configured" not in ocr["reason"]
    assert "GUTS" not in ocr["reason"] and "OCR" in ocr["reason"]
