"""GET /api/operations/plans/{plan_id}: one plan by id, for the dispatcher's live approval poll.

The dispatcher proposes a plan, a supervisor approves it in another browser,
and the dispatcher's page learns of it by polling this endpoint.
"""

from __future__ import annotations


def _propose(api_client, auth_headers) -> dict:
    created = api_client.post("/api/operations/plan?top_n=2", headers=auth_headers("dispatcher"))
    assert created.status_code == 200, created.text
    return created.json()


def test_proposed_plan_reads_back_with_the_list_shape_and_no_drafts(api_client, auth_headers):
    plan = _propose(api_client, auth_headers)
    res = api_client.get(f"/api/operations/plans/{plan['plan_id']}", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    body = res.json()

    listed = api_client.get(
        "/api/operations/plans?status=proposed", headers=auth_headers("dispatcher")
    ).json()
    entry = next(p for p in listed if p["plan_id"] == plan["plan_id"])
    assert {k: v for k, v in body.items() if k != "spj_drafts"} == entry
    assert body["status"] == "proposed"
    assert body["spj_drafts"] == []


def test_the_poll_sees_the_approval_with_approver_and_time(api_client, auth_headers):
    plan = _propose(api_client, auth_headers)
    approved = api_client.post(
        f"/api/operations/{plan['plan_id']}/approve", headers=auth_headers("supervisor")
    )
    assert approved.status_code == 200, approved.text

    body = api_client.get(
        f"/api/operations/plans/{plan['plan_id']}", headers=auth_headers("dispatcher")
    ).json()
    assert body["status"] == "approved"
    assert body["approved_by"] == "supervisor"
    assert body["approved_at"]
    assert isinstance(body["spj_drafts"], list)


def test_unknown_plan_is_404(api_client, auth_headers):
    res = api_client.get("/api/operations/plans/PLAN-DOES-NOT-EXIST", headers=auth_headers("supervisor"))
    assert res.status_code == 404


def test_plan_by_id_requires_a_planning_permission(api_client, auth_headers):
    plan = _propose(api_client, auth_headers)
    url = f"/api/operations/plans/{plan['plan_id']}"
    assert api_client.get(url).status_code == 401
    assert api_client.get(url, headers=auth_headers("driver")).status_code == 403
    assert api_client.get(url, headers=auth_headers("supervisor")).status_code == 200
