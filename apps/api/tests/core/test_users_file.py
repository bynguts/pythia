"""Gap 6: personal accounts from PYTHIA_USERS_FILE, and empty role passwords."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.auth import authenticate, hash_password, load_users, verify_password

API_DIR = Path(__file__).resolve().parents[2]
FAST = 1_000  # PBKDF2 iterations for tests only; real hashes use PBKDF2_ITERATIONS


@pytest.fixture()
def users_file(tmp_path, monkeypatch):
    path = tmp_path / "users.json"
    path.write_text(
        json.dumps(
            {
                "users": [
                    {
                        "username": "Sopir.Uji01",
                        "password_hash": hash_password("rahasia-uji-1", iterations=FAST),
                        "role": "driver",
                        "truck_code": "T-USR1",
                        "display_name": "Pengemudi Uji 01",
                    },
                    {
                        "username": "pengawas.uji",
                        "password_hash": hash_password("rahasia-uji-2", iterations=FAST),
                        "role": "supervisor",
                    },
                    {"username": "tanpa.hash", "role": "driver"},
                    {"username": "peran.asing", "password_hash": "x", "role": "pilot"},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHIA_USERS_FILE", str(path))
    return path


def test_password_hash_round_trip():
    encoded = hash_password("benar", iterations=FAST)
    assert encoded.startswith("pbkdf2_sha256$1000$")
    assert verify_password("benar", encoded)
    assert not verify_password("salah", encoded)
    assert not verify_password("benar", "md5$1$abc$def")


def test_users_file_accounts_carry_identity_and_truck(users_file):
    principal = authenticate("sopir.uji01", "rahasia-uji-1")
    assert principal == {
        "username": "sopir.uji01",
        "role": "driver",
        "truck_code": "T-USR1",
        "display_name": "Pengemudi Uji 01",
        "shared_account": False,
    }
    assert authenticate("sopir.uji01", "salah") is None
    # Entries without a hash or with an unknown role are never loaded.
    assert set(load_users()) == {"sopir.uji01", "pengawas.uji"}


def test_shared_role_accounts_remain_as_demo_mode(users_file):
    principal = authenticate("driver", "driver-demo-pass")
    assert principal["shared_account"] is True
    assert principal["truck_code"] is None


def test_empty_role_password_counts_as_unset(monkeypatch):
    # `cp .env.example .env` leaves PYTHIA_PW_DRIVER= empty: the default must still work,
    # and an empty password must never be accepted.
    monkeypatch.setenv("PYTHIA_PW_DRIVER", "")
    assert authenticate("driver", "driver-demo-pass") is not None
    assert authenticate("driver", "") is None


def test_unreadable_users_file_does_not_fall_open(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHIA_USERS_FILE", str(tmp_path / "missing.json"))
    assert load_users() == {}
    assert authenticate("sopir.uji01", "rahasia-uji-1") is None


def test_example_users_file_has_placeholders_only():
    example = json.loads((API_DIR / "users.example.json").read_text(encoding="utf-8"))
    for user in example["users"]:
        assert "Contoh" in user["display_name"]
        assert user["password_hash"].startswith("pbkdf2_sha256$")


def _login(api_client, username, password):
    res = api_client.post("/api/auth/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def test_audit_trail_records_the_person_and_a_bound_driver_sees_only_its_truck(
    api_client, auth_headers, users_file
):
    supervisor = _login(api_client, "pengawas.uji", "rahasia-uji-2")
    driver = _login(api_client, "sopir.uji01", "rahasia-uji-1")
    session = api_client.get("/api/driver/session", headers=driver).json()
    assert session["truck_code"] == "T-USR1" and session["shared_account"] is False

    def make(truck):
        created = api_client.post(
            "/api/spj",
            json={
                "driver_name": "Pengemudi Uji 01",
                "truck_code": truck,
                "destination": "TPST Bantargebang",
                "stops": [
                    {"name": "TPS U", "kecamatan": "Gambir", "address": "Jl. U", "lat": -6.17, "lng": 106.82}
                ],
            },
            headers=supervisor,
        )
        assert created.status_code == 201, created.text
        return created.json()

    mine, other = make("T-USR1"), make("T-USR2")
    assert mine["created_by"] == "pengawas.uji"
    assert api_client.post(f"/api/spj/{mine['spj_id']}/activate", headers=supervisor).status_code == 200
    audit = api_client.get(f"/api/spj/{mine['spj_id']}/audit", headers=supervisor).json()["audit"]
    assert "admin" not in {entry["actor"] for entry in audit}
    assert any(entry["action"] == "activate" and entry["actor"] == "pengawas.uji" for entry in audit)

    # The bound driver reads its own SPJ, never another truck's.
    assert api_client.get(f"/api/spj/{mine['spj_id']}", headers=driver).status_code == 200
    assert api_client.get(f"/api/spj/{other['spj_id']}", headers=driver).status_code == 403
    assert api_client.get("/api/spj?truck_code=T-USR2", headers=driver).status_code == 403
    listed = api_client.get("/api/spj", headers=driver).json()["spj"]
    assert {s["truck_code"] for s in listed} == {"T-USR1"}
    assert api_client.get("/api/dispatch/T-USR2", headers=driver).status_code == 403
    assert api_client.get("/api/pretrip/today/T-USR1", headers=driver).status_code == 200

    for spj in (mine, other):
        api_client.post(f"/api/spj/{spj['spj_id']}/cancel", headers=supervisor)
