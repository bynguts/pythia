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
        xr_session._ask_cache.clear()
    yield now
    with state._xr_sessions_lock:
        state._xr_sessions.clear()
        xr_session._buckets.clear()
        xr_session._ask_cache.clear()


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


def test_session_carries_an_event_venue_and_validates_it(api_client, clock):
    res = api_client.put("/api/xr/session/VENUE1", json={**BODY, "venue_id": "jis"})
    assert res.status_code == 200
    assert api_client.get("/api/xr/session/VENUE1").json()["venue_id"] == "jis"
    # Older clients that send no venue keep their own.
    assert api_client.put("/api/xr/session/VENUE2", json=BODY).json()["venue_id"] is None
    assert api_client.put("/api/xr/session/VENUE3", json={**BODY, "venue_id": "J I S"}).status_code == 422


def test_session_carries_the_what_if_day(api_client, clock):
    assert (
        api_client.put("/api/xr/session/WDAY1", json={**BODY, "scenario_day": 3}).json()["scenario_day"] == 3
    )
    assert api_client.put("/api/xr/session/WDAY2", json=BODY).json()["scenario_day"] == 0
    assert api_client.put("/api/xr/session/WDAY3", json={**BODY, "scenario_day": 7}).status_code == 422


# gsc-2026 #7: Ask Pythia on the table. /xr has no login, so the ask runs the local
# parser and the read-only run_scenario tool behind the twin's Ask rail.
def test_ask_runs_the_twin_scenario_tool_without_login(api_client, clock, monkeypatch):
    recorded = []
    monkeypatch.setattr(state.history_store, "record_event", lambda *a, **k: recorded.append(a))
    res = api_client.post(
        "/api/xr/ask",
        json={"question": "what if 80 mm rain during the JIS concert tomorrow", "language": "en"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["provider"] == "local"
    scenario = body["scenario"]
    assert scenario["tool"] == "run_scenario"
    assert scenario["scenario"]["rainfall_mm"] == 80.0
    assert scenario["scenario"]["event_attendance"] == 50_000
    assert scenario["scenario"]["attendance_assumed"] is True
    assert scenario["scenario"]["venue_id"] == "jis"
    assert scenario["scenario"]["day"] == 1
    assert scenario["classification"] == "MODEL_OUTPUT"
    # The trace names the local parser first: never an LLM on this public route.
    assert scenario["trace"][0]["class"] == "LOCAL_PARSER"
    assert [step["step"] for step in scenario["trace"]][:2] == ["parse_scenario", "run_scenario"]
    assert "prakiraan model" in body["answer"] or "model forecast" in body["answer"]
    # The question is not stored.
    assert recorded == []


def test_ask_without_a_what_if_returns_no_scenario(api_client, clock):
    res = api_client.post("/api/xr/ask", json={"question": "hello", "language": "id"})
    assert res.status_code == 200
    assert res.json()["scenario"] is None


@pytest.mark.parametrize(
    "payload",
    [{"question": ""}, {"question": "x" * 501}, {"question": "what if 80 mm", "language": "fr"}],
)
def test_ask_body_is_validated(api_client, clock, payload):
    assert api_client.post("/api/xr/ask", json=payload).status_code == 422


def _stub_run_scenario(monkeypatch) -> list[dict]:
    """Count forecast runs without running one; the result carries what the answer reads."""
    runs: list[dict] = []

    def fake(parsed):
        runs.append(parsed)
        return _fake_result(parsed)

    monkeypatch.setattr(xr_session, "run_scenario", fake)
    monkeypatch.setattr(xr_session, "scenario_answer", lambda result, language: "MODEL OUTPUT")
    return runs


def _fake_result(parsed):
    return {
        "tool": "run_scenario",
        "classification": "MODEL_OUTPUT",
        "city": parsed["city"],
        "scenario": {"requested": {"rainfall_mm": parsed["rainfall_mm"]}, "day": parsed["day"]},
        "trace": [],
    }


# gsc v3 N10: judges on one venue NAT share an address. Only a fresh forecast run
# spends tokens; repeated asks come from the cache; a table code gets its own bucket.
def test_ask_is_rate_limited_per_client_on_forecast_runs(api_client, clock, monkeypatch):
    runs = _stub_run_scenario(monkeypatch)
    monkeypatch.setattr(xr_session, "ASK_BUCKET", (2.0, 0.1))
    asks = [{"question": f"what if {mm} mm rain tomorrow", "language": "en"} for mm in (10, 20, 30, 40)]
    assert api_client.post("/api/xr/ask", json=asks[0]).status_code == 200
    assert api_client.post("/api/xr/ask", json=asks[1]).status_code == 200
    limited = api_client.post("/api/xr/ask", json=asks[2])
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    clock["t"] += 10
    assert api_client.post("/api/xr/ask", json=asks[3]).status_code == 200
    assert len(runs) == 3


def test_non_scenario_questions_never_spend_tokens(api_client, clock, monkeypatch):
    monkeypatch.setattr(xr_session, "ASK_BUCKET", (1.0, 0.0001))
    for _ in range(5):
        assert api_client.post("/api/xr/ask", json={"question": "hello", "language": "en"}).status_code == 200


def test_repeated_asks_come_from_the_cache_without_spending(api_client, clock, monkeypatch):
    runs = _stub_run_scenario(monkeypatch)
    monkeypatch.setattr(xr_session, "ASK_BUCKET", (1.0, 0.0001))
    first = api_client.post("/api/xr/ask", json={"question": "what if 40 mm rain tomorrow", "language": "en"})
    assert first.status_code == 200
    # Same question, other wording that parses to the same parameters, other language.
    for question, language in (
        ("what if 40 mm rain tomorrow", "en"),
        ("What if 40mm rain tomorrow?", "en"),
        ("what if 40 mm rain tomorrow", "id"),
    ):
        res = api_client.post("/api/xr/ask", json={"question": question, "language": language})
        assert res.status_code == 200, (question, res.text)
        assert res.json()["scenario"] == first.json()["scenario"]
    assert len(runs) == 1
    # Different parameters are a new run, and the bucket is empty.
    assert api_client.post("/api/xr/ask", json={"question": "what if 45 mm rain tomorrow"}).status_code == 429


def test_ask_cache_expires_and_is_bounded(api_client, clock, monkeypatch):
    runs = _stub_run_scenario(monkeypatch)
    monkeypatch.setattr(xr_session, "ASK_CACHE_SIZE", 2)
    ask = {"question": "what if 40 mm rain tomorrow", "language": "en"}
    api_client.post("/api/xr/ask", json=ask)
    clock["t"] += xr_session.ASK_CACHE_TTL_S + 1
    api_client.post("/api/xr/ask", json=ask)
    assert len(runs) == 2
    for mm in (10, 20, 30):
        api_client.post("/api/xr/ask", json={"question": f"what if {mm} mm rain tomorrow"})
    assert len(xr_session._ask_cache) == 2


def test_ask_cache_key_includes_the_forecast_date(api_client, clock, monkeypatch):
    from datetime import date

    runs = _stub_run_scenario(monkeypatch)
    ask = {"question": "what if 40 mm rain tomorrow", "language": "en"}
    monkeypatch.setattr(xr_session, "today", lambda: date(2026, 10, 24))
    api_client.post("/api/xr/ask", json=ask)
    monkeypatch.setattr(xr_session, "today", lambda: date(2026, 10, 25))
    api_client.post("/api/xr/ask", json=ask)
    assert len(runs) == 2


def test_ask_limit_is_per_live_session_code(api_client, clock, monkeypatch):
    _stub_run_scenario(monkeypatch)
    monkeypatch.setattr(xr_session, "ASK_BUCKET", (1.0, 0.0001))
    assert api_client.put("/api/xr/session/TABLE1", json=BODY).status_code == 200
    assert api_client.put("/api/xr/session/TABLE2", json=BODY).status_code == 200

    def ask(mm: int, session: str | None = None) -> int:
        body = {"question": f"what if {mm} mm rain tomorrow", "language": "en"}
        if session:
            body["session"] = session
        return api_client.post("/api/xr/ask", json=body).status_code

    # Same address (the test client), separate buckets per table.
    assert ask(10, "TABLE1") == 200
    assert ask(15, "TABLE1") == 429
    assert ask(20, "TABLE2") == 200
    assert ask(25) == 200  # the address's own bucket is still full
    assert ask(30) == 429
    # An unknown code cannot mint a bucket: it falls back to the address (now empty).
    assert ask(35, "NOSUCH") == 429


def test_ask_global_cap_holds_across_sessions(api_client, clock, monkeypatch):
    _stub_run_scenario(monkeypatch)
    monkeypatch.setattr(xr_session, "ASK_GLOBAL_BUCKET", (2.0, 0.0001))
    for code in ("ROOMA", "ROOMB", "ROOMC"):
        assert api_client.put(f"/api/xr/session/{code}", json=BODY).status_code == 200
    statuses = [
        api_client.post(
            "/api/xr/ask", json={"question": f"what if {mm} mm rain tomorrow", "session": code}
        ).status_code
        for mm, code in ((10, "ROOMA"), (20, "ROOMB"), (30, "ROOMC"))
    ]
    assert statuses == [200, 200, 429]


def test_ask_session_code_is_validated(api_client, clock):
    res = api_client.post("/api/xr/ask", json={"question": "hello", "session": "lower-case!"})
    assert res.status_code == 422


# Decision room: "Sepakati rencana" on a briefing scenario becomes a session note
# Rencana can read, with the server-counted devices; never an official approval.
@pytest.fixture()
def no_agreements():
    with xr_session.AGREEMENTS.transaction() as connection:
        connection.execute(f"DELETE FROM {xr_session.AGREEMENTS.table}")
    yield
    with xr_session.AGREEMENTS.transaction() as connection:
        connection.execute(f"DELETE FROM {xr_session.AGREEMENTS.table}")


def test_agreeing_on_a_briefing_scenario_records_a_note_for_the_plan(
    api_client, clock, no_agreements, auth_headers
):
    briefing = {**BODY, "rainfall_mm": 50, "event_preset": "none", "day": 0, "scenario_id": "heavy_rain"}
    api_client.put("/api/xr/session/AGREE1", json=briefing)
    _beat(api_client, "AGREE1", "deviceAAAA")
    _beat(api_client, "AGREE1", "deviceBBBB")
    assert api_client.put("/api/xr/session/AGREE1", json={**briefing, "agreed": True}).status_code == 200

    res = api_client.get("/api/twin/agreements?scenario=heavy_rain", headers=auth_headers("dispatcher"))
    assert res.status_code == 200
    [note] = res.json()["agreements"]
    assert note["scenario_id"] == "heavy_rain"
    assert note["session_code"] == "AGREE1"
    assert note["participants"] == 2
    assert note["official"] is False
    assert note["classification"] == "SESSION_NOTE"
    assert note["date"] == api_client.get("/api/twin/scenarios").json()["date"]
    # The same date filter Rencana uses; another scenario has no note.
    dated = api_client.get(f"/api/twin/agreements?date={note['date']}", headers=auth_headers("dispatcher"))
    assert [n["session_code"] for n in dated.json()["agreements"]] == ["AGREE1"]
    other = api_client.get("/api/twin/agreements?scenario=gbk_event", headers=auth_headers("dispatcher"))
    assert other.json()["agreements"] == []

    # Re-sending the same agreed state does not re-stamp it; withdrawing removes it.
    stamp = note["agreed_at"]
    clock["t"] += 5
    api_client.put("/api/xr/session/AGREE1", json={**briefing, "agreed": True})
    again = api_client.get("/api/twin/agreements", headers=auth_headers("dispatcher")).json()["agreements"]
    assert [n["agreed_at"] for n in again] == [stamp]
    api_client.put("/api/xr/session/AGREE1", json={**briefing, "agreed": False})
    assert (
        api_client.get("/api/twin/agreements", headers=auth_headers("dispatcher")).json()["agreements"] == []
    )


def test_free_what_ifs_and_unknown_scenarios_leave_no_note(api_client, clock, no_agreements, auth_headers):
    api_client.put("/api/xr/session/AGREE2", json={**BODY, "agreed": True})
    api_client.put("/api/xr/session/AGREE3", json={**BODY, "agreed": True, "scenario_id": "not_a_scenario"})
    api_client.put(
        "/api/xr/session/AGREE4", json={**BODY, "city": "hcmc", "agreed": True, "scenario_id": "heavy_rain"}
    )
    assert (
        api_client.get("/api/twin/agreements", headers=auth_headers("dispatcher")).json()["agreements"] == []
    )
    assert (
        api_client.put("/api/xr/session/AGREE5", json={**BODY, "scenario_id": "Heavy Rain"}).status_code
        == 422
    )


def test_agreement_notes_need_a_command_center_login(api_client, clock, no_agreements, auth_headers):
    assert api_client.get("/api/twin/agreements").status_code == 401
    assert api_client.get("/api/twin/agreements", headers=auth_headers("driver")).status_code == 403
