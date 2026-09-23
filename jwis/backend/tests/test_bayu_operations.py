"""#32/#17: operations plans must be durable and approval idempotent.

#32 — plans live in the in-memory _OPERATIONS_PLANS dict, so a restart
       or a second worker loses the plan and breaks later approval.
       Plans must be persisted transactionally and survive a fresh
       store instance (process restart / other worker).
#17 — approving the same plan twice must not create a second set of
       dispatches; the second approval returns the existing result
       (at-most-once), including under concurrent requests.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest

from fastapi.testclient import TestClient

from app.main import app
from app.storage import HistoryStore


class OperationsPlanDurabilityTests(unittest.TestCase):
    """#32: plan state survives a fresh store instance."""

    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "dispatcher", "password": "dispatcher-demo-pass"})
        self.client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        sup = self.client.post("/api/auth/login", json={
            "username": "supervisor", "password": "supervisor-demo-pass"})
        self.sup_headers = {"Authorization": f"Bearer {sup.json()['token']}"}

    def test_created_plan_survives_store_reload(self):
        created = self.client.post("/api/operations/plan?top_n=2")
        self.assertEqual(created.status_code, 200)
        plan_id = created.json()["plan_id"]

        # Simulate a restart / other worker: reload plan state from
        # durable storage, then the plan must still be approvable.
        from app.main import _reload_operations_plans
        _reload_operations_plans()
        approved = self.client.post(f"/api/operations/{plan_id}/approve",
                                    headers=self.sup_headers)
        self.assertEqual(approved.status_code, 200,
                         "plan must survive a store reload and stay approvable")
        self.assertEqual(approved.json()["status"], "approved")

    def test_plan_visible_to_second_process(self):
        import os as _os
        import subprocess as _sp
        import tempfile as _tempfile
        # A separate process using the same JWIS_DB_PATH directory must
        # see the plan (multi-worker deployment shape).
        env = _os.environ.copy()
        env.setdefault("JWIS_DB_PATH",
                        _os.path.join(_tempfile.gettempdir(), "jwis_test.db"))
        db_dir = _os.path.dirname(env["JWIS_DB_PATH"])
        script = (
            "import os\n"
            "from contextlib import closing\n"
            f"db_dir = {db_dir!r}\n"
            "from app.operations_plans import OperationsPlanStore\n"
            "store = OperationsPlanStore(db_path=os.path.join(db_dir, 'jwis_operations.db'))\n"
            "with closing(store._connect()) as c:\n"
            "    rows = c.execute('SELECT COUNT(*) AS n FROM operations_plans').fetchone()\n"
            "print(rows['n'])\n"
        )
        backend_dir = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), ".."))
        # Create a plan first so the second process has something to see.
        created = self.client.post("/api/operations/plan?top_n=2")
        self.assertEqual(created.status_code, 200)
        out = _sp.run([sys.executable, "-c", script], capture_output=True,
                      text=True, cwd=backend_dir,
                      env={**env, "PYTHONPATH": backend_dir}, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertGreaterEqual(int(out.stdout.strip()), 1,
                                "second process must see the durable plan")


class OperationsApprovalIdempotencyTests(unittest.TestCase):
    """#17: approval is at-most-once."""

    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        login = self.client.post("/api/auth/login", json={
            "username": "dispatcher", "password": "dispatcher-demo-pass"})
        self.client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        sup = self.client.post("/api/auth/login", json={
            "username": "supervisor", "password": "supervisor-demo-pass"})
        self.sup_headers = {"Authorization": f"Bearer {sup.json()['token']}"}

    def _create(self):
        created = self.client.post("/api/operations/plan?top_n=2")
        self.assertEqual(created.status_code, 200)
        return created.json()["plan_id"]

    def test_second_approval_returns_existing_without_new_dispatches(self):
        plan_id = self._create()
        first = self.client.post(f"/api/operations/{plan_id}/approve",
                                 headers=self.sup_headers)
        self.assertEqual(first.status_code, 200)
        ids_first = first.json()["dispatch_ids"]
        self.assertTrue(ids_first)

        second = self.client.post(f"/api/operations/{plan_id}/approve",
                                  headers=self.sup_headers)
        self.assertEqual(second.status_code, 200)
        ids_second = second.json()["dispatch_ids"]
        self.assertEqual(ids_first, ids_second,
                         "retry approval must return the existing dispatch ids")

        # No duplicate rows: each dispatch id appears exactly once in the
        # dispatch table.
        rows = HistoryStore().list_dispatches()
        occurrences = [r["id"] for r in rows if r["id"] in ids_first]
        self.assertEqual(len(occurrences), len(ids_first),
                         "duplicate approval must not create new dispatch rows")

    def test_concurrent_duplicate_approval_single_dispatch_set(self):
        import concurrent.futures
        plan_id = self._create()

        def approve(_):
            c = self.client.post(f"/api/operations/{plan_id}/approve",
                                 headers=self.sup_headers)
            return c.status_code, c.json().get("dispatch_ids")

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            results = list(ex.map(approve, range(4)))
        for status, _ in results:
            self.assertEqual(status, 200)
        id_sets = {tuple(ids) for _, ids in results if ids}
        self.assertEqual(len(id_sets), 1,
                         "all concurrent approvals must observe one dispatch set")


if __name__ == "__main__":
    unittest.main()
