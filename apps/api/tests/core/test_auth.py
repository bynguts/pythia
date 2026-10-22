"""Tests for role-aware authentication (Task 8)."""

import hashlib
import time
import unittest
from unittest.mock import patch

from app.core import auth as auth_module
from app.core.auth import ROLES, authenticate, has_permission, role_for_token


class AuthTests(unittest.TestCase):
    def test_known_roles_exist(self):
        for role in ("executive", "dispatcher", "supervisor", "driver", "auditor", "administrator"):
            self.assertIn(role, ROLES)

    def test_authenticate_valid_user(self):
        principal = authenticate("dispatcher", "dispatcher-demo-pass")
        self.assertIsNotNone(principal)
        self.assertEqual(principal["role"], "dispatcher")

    def test_authenticate_rejects_bad_password(self):
        self.assertIsNone(authenticate("dispatcher", "wrong"))

    def test_authenticate_rejects_unknown_user(self):
        self.assertIsNone(authenticate("ghost", "x"))

    def test_administrator_can_approve_plans(self):
        self.assertTrue(has_permission("administrator", "operations:approve"))

    def test_driver_cannot_approve_plans(self):
        self.assertFalse(has_permission("driver", "operations:approve"))

    def test_auditor_can_read_history(self):
        self.assertTrue(has_permission("auditor", "history:read"))


class RbacEnforcementTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient

        from app.main import app

        self.client = TestClient(app, raise_server_exceptions=False)

    def _token(self, role):
        r = self.client.post("/api/auth/login", json={"username": role, "password": f"{role}-demo-pass"})
        return r.json()["token"]

    def test_approve_requires_permission(self):
        # First create a plan (dispatcher allowed to plan).
        plan = self.client.post(
            "/api/operations/plan",
            headers={"Authorization": f"Bearer {self._token('dispatcher')}"},
            params={"rainfall_mm": 42, "event_attendance": 85000, "is_weekend": True},
        )
        self.assertEqual(plan.status_code, 200)
        plan_id = plan.json()["plan_id"]
        # Driver must NOT be able to approve.
        denied = self.client.post(
            f"/api/operations/{plan_id}/approve", headers={"Authorization": f"Bearer {self._token('driver')}"}
        )
        self.assertEqual(denied.status_code, 403)
        # Supervisor CAN approve.
        ok = self.client.post(
            f"/api/operations/{plan_id}/approve",
            headers={"Authorization": f"Bearer {self._token('supervisor')}"},
        )
        self.assertEqual(ok.status_code, 200)

    def test_each_login_gets_a_distinct_random_token(self):
        first = self._token("dispatcher")
        second = self._token("dispatcher")
        self.assertNotEqual(first, second)
        # Neither equals the old deterministic sha256("username:role") value.
        legacy = hashlib.sha256(b"dispatcher:dispatcher").hexdigest()
        self.assertNotIn(legacy, (first, second))
        self.assertGreaterEqual(len(first), 32)
        # Both sessions stay valid concurrently.
        self.assertEqual(role_for_token(first), "dispatcher")
        self.assertEqual(role_for_token(second), "dispatcher")
        for tok in (first, second):
            res = self.client.get("/api/whatsapp/status", headers={"Authorization": f"Bearer {tok}"})
            self.assertEqual(res.status_code, 200)

    def test_login_response_shape_is_unchanged(self):
        r = self.client.post("/api/auth/login", json={"username": "driver", "password": "driver-demo-pass"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.json()), {"username", "role", "permissions", "token"})
        self.assertIsInstance(r.json()["token"], str)

    def test_expired_token_is_rejected_and_pruned(self):
        tok = self._token("supervisor")
        role, issued_at = auth_module._TOKEN_REGISTRY[tok]
        auth_module._TOKEN_REGISTRY[tok] = (role, issued_at - auth_module._TOKEN_TTL_SECONDS - 1)
        self.assertIsNone(role_for_token(tok))
        self.assertNotIn(tok, auth_module._TOKEN_REGISTRY)
        res = self.client.get("/api/whatsapp/status", headers={"Authorization": f"Bearer {tok}"})
        self.assertEqual(res.status_code, 401)

    def test_issuing_a_token_prunes_expired_entries(self):
        stale = self._token("dispatcher")
        role, issued_at = auth_module._TOKEN_REGISTRY[stale]
        auth_module._TOKEN_REGISTRY[stale] = (role, issued_at - auth_module._TOKEN_TTL_SECONDS - 1)
        # Pruning runs at most once per interval: within it the stale entry survives
        # (it is still rejected on use), after it the next login sweeps it.
        auth_module._last_prune = time.monotonic()
        self._token("dispatcher")
        self.assertIn(stale, auth_module._TOKEN_REGISTRY)
        self.assertIsNone(role_for_token(stale))
        auth_module._TOKEN_REGISTRY[stale] = (role, issued_at - auth_module._TOKEN_TTL_SECONDS - 1)
        auth_module._last_prune -= auth_module._PRUNE_INTERVAL_SECONDS
        fresh = self._token("dispatcher")
        self.assertNotIn(stale, auth_module._TOKEN_REGISTRY)
        self.assertEqual(role_for_token(fresh), "dispatcher")

    def test_token_registry_is_capped_and_evicts_the_oldest(self):
        with (
            patch.object(auth_module, "_TOKEN_REGISTRY", {}),
            patch.object(auth_module, "_MAX_TOKENS", 2),
        ):
            first = self._token("driver")
            second = self._token("driver")
            third = self._token("driver")
            self.assertEqual(len(auth_module._TOKEN_REGISTRY), 2)
            self.assertIsNone(role_for_token(first))
            self.assertEqual(role_for_token(second), "driver")
            self.assertEqual(role_for_token(third), "driver")

    def test_missing_token_rejected_on_protected_route(self):
        plan = self.client.post(
            "/api/operations/plan",
            headers={"Authorization": f"Bearer {self._token('dispatcher')}"},
            params={"rainfall_mm": 0, "event_attendance": 0, "is_weekend": False},
        )
        plan_id = plan.json()["plan_id"]
        denied = self.client.post(f"/api/operations/{plan_id}/approve")
        self.assertEqual(denied.status_code, 401)


if __name__ == "__main__":
    unittest.main()
