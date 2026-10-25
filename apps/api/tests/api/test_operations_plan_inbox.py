"""A plan a dispatcher proposes reaches a supervisor in another browser.

The dispatcher may build plans (operations:plan) but not approve them; the
supervisor may approve (operations:approve). GET /api/operations/plans is the
approver's inbox, newest first, so separation of duties works across sessions.
"""

from __future__ import annotations


def _propose(api_client, auth_headers) -> dict:
    created = api_client.post("/api/operations/plan?top_n=2", headers=auth_headers("dispatcher"))
    assert created.status_code == 200, created.text
    return created.json()


def test_proposed_plan_is_listed_newest_first_with_its_proposer(api_client, auth_headers):
    older = _propose(api_client, auth_headers)
    newer = _propose(api_client, auth_headers)

    listed = api_client.get("/api/operations/plans?status=proposed", headers=auth_headers("supervisor"))
    assert listed.status_code == 200, listed.text
    plans = listed.json()
    ids = [plan["plan_id"] for plan in plans]
    assert newer["plan_id"] in ids and older["plan_id"] in ids
    assert ids.index(newer["plan_id"]) < ids.index(older["plan_id"])

    entry = next(plan for plan in plans if plan["plan_id"] == newer["plan_id"])
    assert entry["status"] == "proposed"
    assert entry["proposed_by"] == "dispatcher"
    assert entry["created_at"]
    assert entry["total_assigned_tons"] == newer["total_assigned_tons"]
    assert entry["assignments"] == newer["assignments"]


def test_dispatcher_can_list_but_not_approve(api_client, auth_headers):
    plan = _propose(api_client, auth_headers)
    listed = api_client.get("/api/operations/plans?status=proposed", headers=auth_headers("dispatcher"))
    assert listed.status_code == 200
    assert plan["plan_id"] in [p["plan_id"] for p in listed.json()]

    denied = api_client.post(f"/api/operations/{plan['plan_id']}/approve", headers=auth_headers("dispatcher"))
    assert denied.status_code == 403


def test_supervisor_approves_by_id_and_the_plan_leaves_the_inbox(api_client, auth_headers):
    plan = _propose(api_client, auth_headers)
    approved = api_client.post(
        f"/api/operations/{plan['plan_id']}/approve", headers=auth_headers("supervisor")
    )
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["status"] == "approved"
    assert body["approved_by"] == "supervisor"

    pending = api_client.get("/api/operations/plans?status=proposed", headers=auth_headers("supervisor"))
    assert plan["plan_id"] not in [p["plan_id"] for p in pending.json()]
    done = api_client.get("/api/operations/plans?status=approved", headers=auth_headers("supervisor"))
    assert plan["plan_id"] in [p["plan_id"] for p in done.json()]


def test_plan_inbox_requires_a_planning_permission(api_client, auth_headers):
    assert api_client.get("/api/operations/plans").status_code == 401
    assert api_client.get("/api/operations/plans", headers=auth_headers("driver")).status_code == 403
    bad = api_client.get("/api/operations/plans?status=rejected", headers=auth_headers("supervisor"))
    assert bad.status_code == 422
