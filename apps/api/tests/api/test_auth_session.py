"""gsc-2026 P0-2: the public driver/field surfaces validate a stored token.

Tokens live in memory and are lost on a backend restart, so the login gate
asks `/api/auth/session` whether the token it holds still works.
"""

from __future__ import annotations


def test_session_returns_role_and_permissions_for_a_valid_token(api_client, auth_headers):
    res = api_client.get("/api/auth/session", headers=auth_headers("driver"))
    assert res.status_code == 200
    body = res.json()
    assert body["role"] == "driver"
    assert "dispatch:confirm" in body["permissions"]


def test_session_rejects_missing_and_unknown_tokens(api_client):
    assert api_client.get("/api/auth/session").status_code == 401
    res = api_client.get("/api/auth/session", headers={"Authorization": "Bearer not-a-token"})
    assert res.status_code == 401
