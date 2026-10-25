"""Shared fixtures: an authenticated client so RBAC-protected endpoints can be
tested without repeating login boilerplate.

Every durable store resolves its location from `PYTHIA_DB_PATH`, so pointing that
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

_SESSION_DIR = tempfile.mkdtemp(prefix="pythia-test-")
os.environ.setdefault("PYTHIA_AI_ENGINE", "off")
os.environ.setdefault("PYTHIA_SAFETY_GATE_TIMER", "off")
os.environ["PYTHIA_SPJ_SEED"] = "off"
os.environ["PYTHIA_DB_PATH"] = str(Path(_SESSION_DIR) / "pythia_history.db")

# Determinism (#58): tests that activate SPJs without mocking the router
# use the explicit straight-fallback (audited) instead of live OSRM, so
# CI never depends on an external routing service. Unit tests for the
# road contract mock road_route directly.
os.environ.setdefault("PYTHIA_SPJ_STRAIGHT_FALLBACK", "on")
# A recording shell's pinned date or saved weather must not leak into the suite;
# the tests that need them set them with monkeypatch.
os.environ.pop("PYTHIA_DEMO_DATE", None)
os.environ.pop("PYTHIA_WEATHER_SNAPSHOT", None)
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
    return {
        role: _token(api_client, role) for role in ("administrator", "dispatcher", "supervisor", "driver")
    }


@pytest.fixture()
def auth_headers(tokens: dict[str, str]):
    def _for(role: str = "dispatcher") -> dict[str, str]:
        return {"Authorization": f"Bearer {tokens[role]}"}

    return _for
