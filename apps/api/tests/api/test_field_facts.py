"""/api/field-facts: the dispatcher's manual facts, stored as entered and honest about their use."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.field.field_facts import unavailable_trucks


@pytest.fixture()
def day() -> str:
    return f"{2200 + uuid4().int % 700}-03-1{uuid4().int % 9}"


def _post(api_client, auth_headers, role="dispatcher", **body):
    return api_client.post("/api/field-facts", json=body, headers=auth_headers(role))


def test_read_needs_dashboard_and_write_needs_operations_plan(api_client, auth_headers, day):
    assert api_client.get("/api/field-facts").status_code == 401
    assert api_client.get("/api/field-facts", headers=auth_headers("driver")).status_code == 403
    assert api_client.get("/api/field-facts", headers=auth_headers("supervisor")).status_code == 200
    body = {"date": day, "text": "Gate lane 3 closed", "source": "tpa_notice"}
    assert api_client.post("/api/field-facts", json=body).status_code == 401
    assert _post(api_client, auth_headers, "supervisor", **body).status_code == 403
    assert _post(api_client, auth_headers, "driver", **body).status_code == 403
    assert _post(api_client, auth_headers, "dispatcher", **body).status_code == 201


def test_a_fact_round_trips_and_says_whether_the_plan_uses_it(api_client, auth_headers, day):
    lane = _post(
        api_client,
        auth_headers,
        date=day,
        text="Gate lane 3 closed 08:00-10:00",
        source="tpa_notice",
        effect={"kind": "gate_lane_closed", "from": "08:00", "to": "10:00"},
    ).json()
    truck = _post(
        api_client,
        auth_headers,
        date=day,
        text="T-112 stays in the workshop",
        source="workshop",
        effect={"kind": "truck_unavailable", "truck_code": "T-112"},
    ).json()
    plain = _post(api_client, auth_headers, date=day, text="Clean-up day in Kembangan").json()
    assert lane["applied"] is False and "not modelled" in lane["applied_note"]
    assert truck["applied"] is True and truck["effect"] == {
        "kind": "truck_unavailable",
        "truck_code": "T-112",
    }
    assert plain["source"] == "other" and plain["effect"] is None and plain["applied"] is False
    assert truck["created_by"] == "dispatcher" and truck["classification"] == "FIELD"

    listed = api_client.get(f"/api/field-facts?date={day}", headers=auth_headers("dispatcher")).json()
    assert [f["id"] for f in listed["facts"]] == [lane["id"], truck["id"], plain["id"]]
    assert listed["count"] == 3
    assert unavailable_trucks(day) == {"T-112": truck["id"]}


def test_delete_hides_the_fact_and_keeps_the_record(api_client, auth_headers, day):
    fact = _post(
        api_client,
        auth_headers,
        date=day,
        text="T-031 out",
        source="workshop",
        effect={"kind": "truck_unavailable", "truck_code": "T-031"},
    ).json()
    assert (
        api_client.delete(f"/api/field-facts/{fact['id']}", headers=auth_headers("supervisor")).status_code
        == 403
    )
    res = api_client.delete(f"/api/field-facts/{fact['id']}", headers=auth_headers("dispatcher"))
    assert res.status_code == 200 and res.json()["deleted_at"] and res.json()["deleted_by"] == "dispatcher"
    listed = api_client.get(f"/api/field-facts?date={day}", headers=auth_headers("dispatcher")).json()
    assert listed["facts"] == []
    assert unavailable_trucks(day) == {}
    assert (
        api_client.delete("/api/field-facts/fact-none", headers=auth_headers("dispatcher")).status_code == 404
    )


@pytest.mark.parametrize(
    "body",
    [
        {"text": "", "source": "other"},
        {"text": "x", "source": "rumour"},
        {"text": "x", "effect": {"kind": "rain"}},
        {"text": "x", "effect": {"kind": "truck_unavailable"}},
    ],
)
def test_invalid_facts_are_refused(api_client, auth_headers, day, body):
    assert _post(api_client, auth_headers, date=day, **body).status_code == 422
