"""Shared XR tabletop session: public scenario state with last-writer-wins and a 12 h TTL."""

import pytest
from starlette.requests import Request

from app.api import state
from app.api.routers import xr_session

BODY = {"city": "jakarta", "rainfall_mm": 40, "event_preset": "50k", "day": 2, "agreed": False}


@pytest.fixture()
def clock(monkeypatch):
    now = {"t": 1_800_000_000.0}
    monkeypatch.setattr(xr_session, "_clock", lambda: now["t"])
    with state._xr_sessions_lock:
        state._xr_sessions.clear()
        xr_session._buckets.clear()
    yield now
    with state._xr_sessions_lock:
        state._xr_sessions.clear()
        xr_session._buckets.clear()


def test_put_creates_a_session_that_get_returns_without_auth(api_client, clock):
    res = api_client.put("/api/xr/session/AB12CD", json=BODY)
    assert res.status_code == 200, res.text
    created = res.json()
    assert created["code"] == "AB12CD"
    assert created["classification"] == "SESSION_STATE"
    assert {k: created[k] for k in BODY} == {**BODY, "rainfall_mm": 40.0}
    assert created["updated_at"].endswith("+00:00")

    fetched = api_client.get("/api/xr/session/AB12CD")
    assert fetched.status_code == 200
    assert fetched.json() == created


def test_put_replaces_the_scenario_and_advances_updated_at(api_client, clock):
    first = api_client.put("/api/xr/session/ROOM1", json=BODY).json()
    # Same server millisecond: the stamp must still move forward.
    second = api_client.put("/api/xr/session/ROOM1", json={**BODY, "rainfall_mm": 120, "agreed": True}).json()
    assert second["rainfall_mm"] == 120.0
    assert second["agreed"] is True
    assert second["updated_at"] > first["updated_at"]
    assert api_client.get("/api/xr/session/ROOM1").json()["agreed"] is True


def test_unknown_code_is_404(api_client, clock):
    assert api_client.get("/api/xr/session/ZZZZ99").status_code == 404


@pytest.mark.parametrize("code", ["abc123", "AB1", "ABCDEFGHI", "AB-12"])
def test_codes_must_be_4_to_8_uppercase_alphanumerics(api_client, clock, code):
    assert api_client.get(f"/api/xr/session/{code}").status_code == 422
    assert api_client.put(f"/api/xr/session/{code}", json=BODY).status_code == 422


@pytest.mark.parametrize(
    "patch",
    [{"city": "paris"}, {"rainfall_mm": -1}, {"rainfall_mm": 301}, {"event_preset": "1m"}, {"day": 7}],
)
def test_scenario_body_is_validated(api_client, clock, patch):
    assert api_client.put("/api/xr/session/ROOM2", json={**BODY, **patch}).status_code == 422


def test_sessions_expire_after_twelve_idle_hours(api_client, clock):
    api_client.put("/api/xr/session/TTL1", json=BODY)
    clock["t"] += 12 * 3600 - 1
    assert api_client.get("/api/xr/session/TTL1").status_code == 200
    # A write refreshes the TTL; reads do not.
    api_client.put("/api/xr/session/TTL1", json=BODY)
    clock["t"] += 12 * 3600 - 1
    assert api_client.get("/api/xr/session/TTL1").status_code == 200
    clock["t"] += 1
    assert api_client.get("/api/xr/session/TTL1").status_code == 404


def test_store_is_bounded(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "MAX_SESSIONS", 2)
    for i, code in enumerate(["CAP1", "CAP2", "CAP3"]):
        clock["t"] += i
        api_client.put(f"/api/xr/session/{code}", json=BODY)
    assert api_client.get("/api/xr/session/CAP1").status_code == 404
    assert api_client.get("/api/xr/session/CAP3").status_code == 200


def test_updates_are_rate_limited_per_client(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "PUT_BUCKET", (3.0, 1.0))
    for _ in range(3):
        assert api_client.put("/api/xr/session/RATE1", json=BODY).status_code == 200
    limited = api_client.put("/api/xr/session/RATE1", json=BODY)
    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "1"
    clock["t"] += 1  # one token refills per second
    assert api_client.put("/api/xr/session/RATE1", json=BODY).status_code == 200
    assert api_client.put("/api/xr/session/RATE1", json=BODY).status_code == 429
    # A forwarded-for header cannot buy a fresh bucket: the test peer is not a private proxy.
    other = api_client.put("/api/xr/session/RATE1", json=BODY, headers={"X-Forwarded-For": "203.0.113.9"})
    assert other.status_code == 429


def test_new_session_codes_have_a_smaller_budget(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "NEW_SESSION_BUCKET", (2.0, 1 / 20))
    assert api_client.put("/api/xr/session/NEW1", json=BODY).status_code == 200
    assert api_client.put("/api/xr/session/NEW2", json=BODY).status_code == 200
    refused = api_client.put("/api/xr/session/NEW3", json=BODY)
    assert refused.status_code == 429 and refused.headers["Retry-After"] == "20"
    assert api_client.get("/api/xr/session/NEW3").status_code == 404
    # Updating an existing session is not a new code.
    assert api_client.put("/api/xr/session/NEW1", json={**BODY, "agreed": True}).status_code == 200
    clock["t"] += 20
    assert api_client.put("/api/xr/session/NEW3", json=BODY).status_code == 200


def _request(peer, forwarded=None):
    headers = [(b"x-forwarded-for", forwarded.encode())] if forwarded else []
    return Request({"type": "http", "client": (peer, 5000), "headers": headers})


def test_client_address_trusts_forwarded_for_only_from_a_private_proxy():
    # Local preview proxy / tunnel: the last hop the proxy chain appended is the client.
    assert xr_session._client(_request("127.0.0.1", "198.51.100.7, 203.0.113.9")) == "203.0.113.9"
    assert xr_session._client(_request("172.18.0.3", "203.0.113.9")) == "203.0.113.9"
    assert xr_session._client(_request("127.0.0.1")) == "127.0.0.1"
    # A public peer cannot pick its own bucket.
    assert xr_session._client(_request("8.8.8.8", "10.0.0.1")) == "8.8.8.8"


def test_rate_limit_table_is_bounded(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "MAX_CLIENTS", 2)
    with state._xr_sessions_lock:
        for client in ("10.0.0.1", "10.0.0.2", "10.0.0.3"):
            xr_session._take("put", client, xr_session.PUT_BUCKET, clock["t"])
        assert len(xr_session._buckets) == 2
        assert ("put", "10.0.0.1") not in xr_session._buckets


def test_selected_district_is_shared_state_and_validated(api_client, clock):
    created = api_client.put("/api/xr/session/SEL1", json=BODY).json()
    assert created["selected_id"] is None
    picked = api_client.put("/api/xr/session/SEL1", json={**BODY, "selected_id": "kebon_jeruk"}).json()
    assert picked["selected_id"] == "kebon_jeruk"
    assert api_client.get("/api/xr/session/SEL1").json()["selected_id"] == "kebon_jeruk"
    for bad in ["", "a b", "x" * 65, "<script>"]:
        assert api_client.put("/api/xr/session/SEL1", json={**BODY, "selected_id": bad}).status_code == 422


def _beat(api_client, code, pid):
    return api_client.post(f"/api/xr/session/{code}/presence", json={"participant_id": pid})


def test_presence_counts_devices_with_a_ten_second_ttl(api_client, clock):
    api_client.put("/api/xr/session/HERE1", json=BODY)
    assert api_client.get("/api/xr/session/HERE1").json()["participants"] == 0
    first = _beat(api_client, "HERE1", "deviceAAAA")
    assert first.status_code == 200
    assert first.json()["participants"] == 1
    # The heartbeat returns the scenario too, and never moves updated_at.
    assert first.json()["rainfall_mm"] == 40.0
    stamp = first.json()["updated_at"]
    clock["t"] += 4
    assert _beat(api_client, "HERE1", "deviceBBBB").json()["participants"] == 2
    # A repeat heartbeat from one device is still one device.
    assert _beat(api_client, "HERE1", "deviceBBBB").json()["participants"] == 2
    assert api_client.get("/api/xr/session/HERE1").json()["updated_at"] == stamp
    clock["t"] += 6  # A's last heartbeat is now 10 s old: gone
    assert api_client.get("/api/xr/session/HERE1").json()["participants"] == 1
    clock["t"] += 4
    assert api_client.get("/api/xr/session/HERE1").json()["participants"] == 0


def test_presence_survives_scenario_writes(api_client, clock):
    api_client.put("/api/xr/session/HERE2", json=BODY)
    _beat(api_client, "HERE2", "deviceAAAA")
    _beat(api_client, "HERE2", "deviceBBBB")
    assert api_client.put("/api/xr/session/HERE2", json={**BODY, "day": 3}).json()["participants"] == 2


def test_presence_needs_a_known_session_and_a_valid_id(api_client, clock):
    assert _beat(api_client, "NOPE99", "deviceAAAA").status_code == 404
    api_client.put("/api/xr/session/HERE3", json=BODY)
    for bad in ["short", "has space1", "x" * 33, "dev-ice-01"]:
        assert _beat(api_client, "HERE3", bad).status_code == 422


def test_presence_table_is_bounded(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "MAX_PARTICIPANTS", 2)
    api_client.put("/api/xr/session/HERE4", json=BODY)
    for i, pid in enumerate(["deviceAAAA", "deviceBBBB", "deviceCCCC"]):
        clock["t"] += 0.1 * i
        assert _beat(api_client, "HERE4", pid).json()["participants"] <= 2
    with state._xr_sessions_lock:
        assert set(state._xr_sessions["HERE4"]["participants"]) == {"deviceBBBB", "deviceCCCC"}


def test_heartbeats_spend_the_same_rate_limit_as_writes(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "PUT_BUCKET", (3.0, 1.0))
    assert api_client.put("/api/xr/session/HERE5", json=BODY).status_code == 200
    assert _beat(api_client, "HERE5", "deviceAAAA").status_code == 200
    assert _beat(api_client, "HERE5", "deviceAAAA").status_code == 200
    limited = _beat(api_client, "HERE5", "deviceAAAA")
    assert limited.status_code == 429
    assert api_client.put("/api/xr/session/HERE5", json=BODY).status_code == 429
