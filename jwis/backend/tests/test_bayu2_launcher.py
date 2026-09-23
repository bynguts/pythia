"""#36: the documented launcher must start the intended AI engine, and
health must report the configured vs running engine state — not stay
silent while /api/ai/* returns empty.
"""

from __future__ import annotations

import os
import re
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent


class HealthEngineStateTests(unittest.TestCase):
    def test_health_reports_configured_and_running_engine_state(self):
        from app.main import app
        client = TestClient(app)
        res = client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        for key in ("ai_engine_configured", "ai_engine_running"):
            self.assertIn(key, body, f"/api/health must expose {key}")
        # In the test environment the engine is off, so both must be False
        # and honestly reported.
        self.assertIn(body["ai_engine_configured"], (True, False))
        self.assertIn(body["ai_engine_running"], (True, False))


class DocumentedLauncherTests(unittest.TestCase):
    def test_readme_primary_backend_command_sets_engine_mode(self):
        readme = (REPO / "README.md").read_text(encoding="utf-8")
        # The primary documented backend launch command must explicitly
        # set JWIS_AI_ENGINE so following the docs yields a working AI
        # outlook instead of silently empty endpoints.
        command_blocks = re.findall(
            r"JWIS_AI_ENGINE=(\w+)\s+python\s+-m\s+uvicorn\s+app\.main:app",
            readme)
        self.assertTrue(
            command_blocks,
            "README's documented backend command must set JWIS_AI_ENGINE "
            "explicitly (e.g. 'JWIS_AI_ENGINE=on python -m uvicorn ...')")
        self.assertEqual(
            set(command_blocks), {"on"},
            f"all documented launch commands must set 'on'; found {command_blocks}")

    def test_env_example_documents_engine_on(self):
        env_example = (REPO / ".env.example").read_text(encoding="utf-8")
        self.assertRegex(env_example, r"JWIS_AI_ENGINE=on")


if __name__ == "__main__":
    unittest.main()
