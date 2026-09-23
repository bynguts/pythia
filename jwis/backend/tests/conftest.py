"""Shared fixtures: an authenticated client so RBAC-protected endpoints can be
tested without repeating login boilerplate."""
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("JWIS_AI_ENGINE", "off")

# Determinism (#58): tests that activate SPJs without mocking the router
# use the explicit straight-fallback (audited) instead of live OSRM, so
# CI never depends on an external routing service. Unit tests for the
# road contract mock road_route directly.
os.environ.setdefault("JWIS_SPJ_STRAIGHT_FALLBACK", "on")
from app.main import app  # noqa: E402
@pytest.fixture(scope="session")
def api_client() -> TestClient:
    return TestClient(app)


def _token(client: TestClient, role: str) -> str:
    res = client.post("/api/auth/login", json={"username": role, "password": f"{role}-demo-pass"})
    assert res.status_code == 200, res.text
    return res.json()["token"]


@pytest.fixture(scope="session")
def tokens(api_client: TestClient) -> dict[str, str]:
    return {role: _token(api_client, role) for role in ("administrator", "dispatcher", "supervisor", "driver")}


@pytest.fixture()
def auth_headers(tokens: dict[str, str]):
    def _for(role: str = "dispatcher") -> dict[str, str]:
        return {"Authorization": f"Bearer {tokens[role]}"}
    return _for
