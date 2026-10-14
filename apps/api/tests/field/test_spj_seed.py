"""The demo SPJ seed must never stop the API from starting.

Activation needs road-following geometry from OSRM. When the routing service is
down the store (correctly) refuses to promote a straight line, and because the
seed runs while app.field.spj is imported, that refusal used to crash startup.
"""

import unittest
from unittest import mock

from spj_testutil import fresh_store_path

from app.field.spj import SpjStore, _maybe_seed

ROUTING_DOWN = ValueError(
    "cannot activate: road-following geometry could not be resolved (routing service unavailable)"
)


class SeedWithoutRoutingTests(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict("os.environ", {"PYTHIA_SPJ_SEED": "on"})
        env.start()
        self.addCleanup(env.stop)
        self.store = SpjStore(persist_path=fresh_store_path("spj_seed_routing_down.db"))

    def test_routing_outage_leaves_the_seed_as_a_draft(self):
        with (
            mock.patch.object(self.store, "activate", side_effect=ROUTING_DOWN),
            self.assertLogs("app.field.spj", level="WARNING") as logs,
        ):
            _maybe_seed(self.store)  # must not raise

        seeded = self.store.list()
        self.assertEqual(len(seeded), 1)
        self.assertEqual(seeded[0].status, "draft")
        self.assertEqual(len(seeded[0].stops), 3)
        self.assertIn("left as draft", "\n".join(logs.output))

    def test_seed_is_activated_when_routing_works(self):
        with mock.patch.object(self.store, "activate") as activate:
            _maybe_seed(self.store)
        activate.assert_called_once_with(self.store.list()[0].spj_id)


if __name__ == "__main__":
    unittest.main()
