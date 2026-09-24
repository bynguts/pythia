# -*- coding: utf-8 -*-
"""Dispatch confirmation operation_id idempotency (#44).

A flush retry that replays the same operation_id must not write a second
history event, while a different operation_id for the same dispatch is a
normal new confirmation. Legacy clients without an operation_id keep working.
"""
def _dispatch(client, headers, truck: str) -> str:
    created = client.post("/api/dispatch", json={
        "truck_code": truck, "instruction": "e2e op-id", "manager_id": "e2e"},
        headers=headers)
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _events_for(client, headers, dispatch_id: str) -> list:
    events = client.get("/api/history", headers=headers).json()
    return [event for event in events
            if event.get("event_type") == "dispatch_confirmed"
            and (event.get("payload") or {}).get("dispatch_id") == dispatch_id]


def test_replayed_operation_id_is_not_a_second_event(api_client, auth_headers):
    headers = auth_headers("dispatcher")
    dispatch_id = _dispatch(api_client, headers, "T-301")
    payload = {"status": "READY", "note": "first", "operation_id": "op-44-retry-1"}
    first = api_client.post(f"/api/dispatch/{dispatch_id}/confirm", json=payload, headers=headers)
    assert first.status_code == 200, first.text
    replay = api_client.post(f"/api/dispatch/{dispatch_id}/confirm", json=payload, headers=headers)
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()

    status = api_client.get(f"/api/dispatch/{dispatch_id}/status", headers=headers).json()
    assert status["field_status"] == "READY"
    assert len(_events_for(api_client, headers, dispatch_id)) == 1


def test_different_operation_id_is_a_new_confirmation(api_client, auth_headers):
    headers = auth_headers("dispatcher")
    dispatch_id = _dispatch(api_client, headers, "T-302")
    first = api_client.post(f"/api/dispatch/{dispatch_id}/confirm", json={
        "status": "READY", "note": "a", "operation_id": "op-44-first-01"}, headers=headers)
    assert first.status_code == 200, first.text
    second = api_client.post(f"/api/dispatch/{dispatch_id}/confirm", json={
        "status": "ISSUE", "note": "b", "operation_id": "op-44-second"}, headers=headers)
    assert second.status_code == 200, second.text
    status = api_client.get(f"/api/dispatch/{dispatch_id}/status", headers=headers).json()
    assert status["field_status"] == "ISSUE"
    assert len(_events_for(api_client, headers, dispatch_id)) == 2


def test_confirmation_without_operation_id_still_works(api_client, auth_headers):
    headers = auth_headers("dispatcher")
    dispatch_id = _dispatch(api_client, headers, "T-303")
    res = api_client.post(f"/api/dispatch/{dispatch_id}/confirm", json={
        "status": "SIAP", "note": "legacy"}, headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["field_status"] == "SIAP"


def test_replay_after_server_restart_returns_stored_confirmation(api_client, auth_headers):
    """The operation_id is durable (persisted column), so a flush retry that
    survives an app restart still deduplicates."""
    from app import storage as storage_module
    headers = auth_headers("dispatcher")
    dispatch_id = _dispatch(api_client, headers, "T-304")
    payload = {"status": "ISSUE", "note": "flaky net", "operation_id": "op-44-restart"}
    first = api_client.post(f"/api/dispatch/{dispatch_id}/confirm", json=payload, headers=headers)
    assert first.status_code == 200, first.text

    # New HistoryStore instance over the same DB file simulates a restart.
    fresh = storage_module.HistoryStore()
    prior = fresh.get_dispatch_operation(dispatch_id, "op-44-restart")
    assert prior is not None
    assert prior["field_status"] == "ISSUE"
    assert fresh.get_dispatch_operation(dispatch_id, "op-44-other") is None
