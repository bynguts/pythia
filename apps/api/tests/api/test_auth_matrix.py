"""RBAC matrix for every mutating endpoint (issue #5).

Unauthenticated callers get 401, a role without the permission gets 403, and
an authorized role reaches the handler (2xx/4xx — a 404/409 on a fixture id
still proves auth passed).
"""

import pytest

CREATE_ENDPOINTS = [
    ("post", "/api/alert/follow-up", {"alert_id": "a1", "status": "OPEN", "operator": "op"}),
    ("post", "/api/whatsapp/contacts", {"drivers": {"X": "6281234567890@c.us"}}),
    ("post", "/api/whatsapp/logout", None),
    (
        "post",
        "/api/whatsapp/alert",
        {"truck_code": "T-001", "issue": "i", "route_name": "r", "recommendation": "r"},
    ),
    (
        "post",
        "/api/whatsapp/alert/simulate",
        {"truck_code": "T-001", "issue": "i", "route_name": "r", "recommendation": "r"},
    ),
    ("post", "/api/dispatch", {"truck_code": "T-001", "instruction": "x"}),
    ("post", "/api/dispatch/nonexistent/confirm", {"status": "READY"}),
    ("post", "/api/operations/plan", None),
    (
        "post",
        "/api/events/permits",
        {
            "name": "Uji Acara",
            "location_name": "Monas",
            "date": "2026-09-23",
            "start_hour": 10,
            "end_hour": 12,
            "expected_attendance": 1000,
            "lat": -6.17,
            "lng": 106.82,
        },
    ),
    ("post", "/api/simulator/stagger?active_trucks=2", None),
    ("post", "/api/fleet/astar-simulate-jam?active=false", None),
    ("post", "/api/spj", {"driver_name": "D", "truck_code": "T-001", "destination": "TPA"}),
    (
        "post",
        "/api/spj/none/stops",
        {"name": "S", "kecamatan": "GAMBIR", "address": "a", "lat": -6.1, "lng": 106.8},
    ),
    ("post", "/api/spj/none/activate", None),
    ("post", "/api/spj/none/complete", None),
    ("post", "/api/spj/none/cancel", None),
    ("post", "/api/spj/none/stops/0/complete", None),
    (
        "post",
        "/api/spj/none/receipt",
        {"photo_name": "p.jpg", "photo_b64": "", "total_weight_kg": 1, "weight_source": "manual"},
    ),
    ("post", "/api/pretrip", {"truck_code": "T-001", "driver_name": "D", "items": {"Rem": True}}),
    ("post", "/api/damage-reports", {"truck_code": "T-001", "driver_name": "D", "description": "x"}),
    ("post", "/api/damage-reports/none/resolve", None),
    (
        "post",
        "/api/service-records",
        {"truck_code": "T-001", "service_date": "2026-09-22", "component": "Oli"},
    ),
    ("post", "/api/ocr/timbangan", {"photo_b64": ""}),
    ("post", "/api/assistant/query", {"question": "status?"}),
]


@pytest.mark.parametrize("method,path,body", CREATE_ENDPOINTS)
def test_unauthenticated_gets_401(api_client, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    res = getattr(api_client, method)(path, **kwargs)
    assert res.status_code == 401, f"{path} expected 401, got {res.status_code}: {res.text[:200]}"


@pytest.mark.parametrize("method,path,body", CREATE_ENDPOINTS)
def test_authorized_role_passes_auth(api_client, auth_headers, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    kwargs["headers"] = auth_headers("administrator")
    res = getattr(api_client, method)(path, **kwargs)
    assert res.status_code not in (401, 403), (
        f"{path} should pass auth, got {res.status_code}: {res.text[:200]}"
    )


def test_auditor_role_denied_dispatch(api_client):
    # auditor has neither dispatch:create nor dispatch:confirm
    res = api_client.post("/api/auth/login", json={"username": "auditor", "password": "auditor-demo-pass"})
    token = res.json()["token"]
    res = api_client.post(
        "/api/dispatch",
        json={"truck_code": "T-001", "instruction": "x"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


def test_driver_cannot_create_dispatch_but_can_confirm(api_client, auth_headers):
    res = api_client.post(
        "/api/dispatch", json={"truck_code": "T-001", "instruction": "x"}, headers=auth_headers("driver")
    )
    assert res.status_code == 403
    # confirm on a missing id → 404, which means auth passed
    res = api_client.post(
        "/api/dispatch/nonexistent/confirm", json={"status": "READY"}, headers=auth_headers("driver")
    )
    assert res.status_code == 404


@pytest.mark.parametrize("path", ["/api/whatsapp/qr", "/api/whatsapp/groups"])
def test_whatsapp_pairing_endpoints_are_administrator_only(api_client, auth_headers, path):
    assert api_client.get(path).status_code == 401
    assert api_client.get(path, headers=auth_headers("dispatcher")).status_code == 403
    assert api_client.get(path, headers=auth_headers("supervisor")).status_code == 403
    res = api_client.get(path, headers=auth_headers("administrator"))
    assert res.status_code == 200, res.text[:200]
    assert isinstance(res.json(), dict)


def test_whatsapp_status_requires_an_operator_session(api_client, auth_headers):
    assert api_client.get("/api/whatsapp/status").status_code == 401
    assert api_client.get("/api/whatsapp/status", headers=auth_headers("driver")).status_code == 403
    for role in ("dispatcher", "supervisor", "administrator"):
        res = api_client.get("/api/whatsapp/status", headers=auth_headers(role))
        assert res.status_code == 200, f"{role}: {res.text[:200]}"
        assert "connected" in res.json()


def test_contacts_refuses_to_shrink(api_client, auth_headers):
    res = api_client.post(
        "/api/whatsapp/contacts", json={"drivers": {}}, headers=auth_headers("administrator")
    )
    assert res.status_code == 409


# --- Gap 7: personal data is behind login ----------------------------------------

PERSONAL_DATA_READS = [
    "/api/spj",
    "/api/spj/none",
    "/api/spj/none/evidence-summary",
    "/api/spj/none/evidence/1",
    "/api/spj/none/evidence/1/thumb",
    "/api/spj/none/audit",
    "/api/history",
    "/api/alert/follow-ups",
    "/api/compliance/drivers",
    "/api/compliance/drivers/Pengemudi%20Sim%2001",
    "/api/dispatch/T-001",
    "/api/pretrip/today/T-001",
    "/api/damage-reports",
    "/api/service-records",
    "/api/service-records/due-soon",
]


@pytest.mark.parametrize("path", PERSONAL_DATA_READS)
def test_personal_data_reads_need_a_session(api_client, path):
    res = api_client.get(path)
    assert res.status_code == 401, f"{path} expected 401, got {res.status_code}: {res.text[:200]}"


@pytest.mark.parametrize("path", PERSONAL_DATA_READS)
def test_personal_data_reads_pass_for_an_operator(api_client, auth_headers, path):
    res = api_client.get(path, headers=auth_headers("administrator"))
    assert res.status_code not in (401, 403), f"{path}: {res.status_code} {res.text[:200]}"


@pytest.mark.parametrize(
    "path", ["/api/history", "/api/compliance/drivers", "/api/damage-reports", "/api/service-records"]
)
def test_driver_token_cannot_read_other_peoples_records(api_client, auth_headers, path):
    assert api_client.get(path, headers=auth_headers("driver")).status_code == 403


def _active_spj(api_client, headers, truck_code: str) -> str:
    created = api_client.post(
        "/api/spj",
        json={
            "driver_name": "Pengemudi Sim 07",
            "truck_code": truck_code,
            "destination": "TPST Bantargebang",
            "stops": [
                {"name": "TPS A", "kecamatan": "Gambir", "address": "Jl. A", "lat": -6.17, "lng": 106.82},
                {"name": "TPS B", "kecamatan": "Gambir", "address": "Jl. B", "lat": -6.18, "lng": 106.83},
            ],
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    spj_id = created.json()["spj_id"]
    activated = api_client.post(f"/api/spj/{spj_id}/activate", headers=headers)
    assert activated.status_code == 200, activated.text
    return spj_id


def test_shared_driver_token_reads_an_spj_without_photo_bytes(api_client, auth_headers):
    spj_id = _active_spj(api_client, auth_headers("dispatcher"), "T-AUTH-DRV")
    res = api_client.get(f"/api/spj/{spj_id}", headers=auth_headers("driver"))
    assert res.status_code == 200
    assert "photo_b64" not in res.text
    api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("dispatcher"))


# --- Gap 4: the per-stop override needs spj:override ---------------------------------


@pytest.mark.parametrize("role", ["driver", "dispatcher"])
def test_per_stop_override_is_forbidden_without_spj_override(api_client, auth_headers, role):
    spj_id = _active_spj(api_client, auth_headers("dispatcher"), f"T-AUTH-OVR-{role[:3].upper()}")
    res = api_client.post(
        f"/api/spj/{spj_id}/stops/1/complete",
        json={"override": {"reason": "Truk mogok, titik ditutup tanpa bukti"}},
        headers=auth_headers(role),
    )
    assert res.status_code == 403, res.text
    detail = api_client.get(f"/api/spj/{spj_id}", headers=auth_headers("dispatcher")).json()
    assert [s["status"] for s in detail["stops"]] == ["pending", "pending"]
    api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("dispatcher"))


def test_supervisor_per_stop_override_is_audited_with_the_actor(api_client, auth_headers):
    spj_id = _active_spj(api_client, auth_headers("dispatcher"), "T-AUTH-OVR-SUP")
    res = api_client.post(
        f"/api/spj/{spj_id}/stops/0/complete",
        json={"override": {"reason": "Akses jalan ditutup banjir, dicek pengawas"}},
        headers=auth_headers("supervisor"),
    )
    assert res.status_code == 200, res.text
    assert res.json()["stops"][0]["override"]["actor"] == "supervisor"
    audit = api_client.get(f"/api/spj/{spj_id}/audit", headers=auth_headers("supervisor")).json()["audit"]
    overrides = [entry for entry in audit if entry["action"] == "override"]
    assert overrides and overrides[-1]["actor"] == "supervisor"
    # Creation and activation are attributed to the dispatcher who did them, not "admin".
    assert {entry["actor"] for entry in audit if entry["action"] in ("activate", "straight_fallback")} == {
        "dispatcher"
    }
    api_client.post(f"/api/spj/{spj_id}/cancel", headers=auth_headers("dispatcher"))
