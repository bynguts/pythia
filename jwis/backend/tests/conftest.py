"""Shared fixtures: an authenticated client so RBAC-protected endpoints can be
tested without repeating login boilerplate.

Every durable store resolves its location from `JWIS_DB_PATH`, so pointing that
at a fresh session directory gives the suite its own SPJ/permit/history state.
Without it the endpoint tests would inherit whatever a previous run left behind
(a truck still holding an active SPJ makes the next run fail on activation).
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_SESSION_DIR = tempfile.mkdtemp(prefix="jwis-test-")
os.environ.setdefault("JWIS_AI_ENGINE", "off")
os.environ["JWIS_SPJ_SEED"] = "off"
os.environ["JWIS_DB_PATH"] = str(Path(_SESSION_DIR) / "jwis_history.db")

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
