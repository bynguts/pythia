"""JWIS -> Pythia rebrand: deployments configured or populated under the old
name keep working (settings via JWIS_* env vars, records in jwis_*.db files).
"""
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from app.auth import authenticate
from app.env import getenv, legacy_dotenv_files
from app.operations_plans import OperationsPlanStore
from app.spj import DESTINATIONS, SpjStore, _legacy_json_path
from app.storage import HistoryStore, RecordStore, adopt_legacy_db


def _without(*names):
    return {k: v for k, v in os.environ.items() if k not in names}


class EnvFallbackTests(unittest.TestCase):
    def test_pythia_name_wins_over_legacy(self):
        with mock.patch.dict(os.environ, {"PYTHIA_GPS_SOURCE": "live",
                                          "JWIS_GPS_SOURCE": "simulated"}):
            self.assertEqual(getenv("GPS_SOURCE", "x"), "live")

    def test_legacy_name_used_when_new_absent(self):
        env = _without("PYTHIA_GPS_SOURCE")
        env["JWIS_GPS_SOURCE"] = "live"
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(getenv("GPS_SOURCE", "simulated"), "live")

    def test_default_when_neither_set(self):
        with mock.patch.dict(os.environ, _without("PYTHIA_GPS_SOURCE", "JWIS_GPS_SOURCE"),
                             clear=True):
            self.assertEqual(getenv("GPS_SOURCE", "simulated"), "simulated")

    def test_empty_new_value_is_respected(self):
        # An explicitly blank PYTHIA_ value is a decision, not "unset".
        with mock.patch.dict(os.environ, {"PYTHIA_DB_PATH": "",
                                          "JWIS_DB_PATH": "/legacy/x.db"}):
            self.assertEqual(getenv("DB_PATH"), "")

    def test_legacy_role_password_still_logs_in(self):
        env = _without("PYTHIA_PW_AUDITOR")
        env["JWIS_PW_AUDITOR"] = "legacy-secret"
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNotNone(authenticate("auditor", "legacy-secret"))
            self.assertIsNone(authenticate("auditor", "auditor-demo-pass"))


class LegacyDotenvTests(unittest.TestCase):
    def test_finds_env_files_stranded_in_jwis_folder_in_old_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "jwis" / "backend").mkdir(parents=True)
            (root / "jwis" / ".env").write_text("A=1\n")
            (root / "jwis" / "backend" / ".env").write_text("A=2\n")
            self.assertEqual(legacy_dotenv_files(root),
                             [root / "jwis" / "backend" / ".env", root / "jwis" / ".env"])

    def test_nothing_to_find_without_a_checkout(self):
        self.assertEqual(legacy_dotenv_files(None), [])
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(legacy_dotenv_files(Path(tmp)), [])


class LegacyDbAdoptionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_record_store_adopts_legacy_file_and_table(self):
        legacy = RecordStore("jwis_permits", self.dir / "jwis_permits.db")
        legacy.write("p-1", {"permit_id": "p-1", "venue": "GBK"})
        legacy_bytes = (self.dir / "jwis_permits.db").read_bytes()

        store = RecordStore("pythia_permits", self.dir / "pythia_permits.db")

        self.assertEqual(store.get("p-1"), {"permit_id": "p-1", "venue": "GBK"})
        self.assertEqual(store.count(), 1)
        # The legacy file stays byte-identical so the upgrade can be rolled back.
        self.assertEqual((self.dir / "jwis_permits.db").read_bytes(), legacy_bytes)
        with closing(sqlite3.connect(self.dir / "pythia_permits.db")) as connection:
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("pythia_permits", tables)
        self.assertNotIn("jwis_permits", tables)

    def test_existing_pythia_file_is_never_overwritten(self):
        current = RecordStore("pythia_permits", self.dir / "pythia_permits.db")
        current.write("new", {"v": 2})
        # A legacy file that shows up later (e.g. restored from a backup).
        RecordStore("jwis_permits", self.dir / "jwis_permits.db").write("old", {"v": 1})

        self.assertFalse(adopt_legacy_db(self.dir / "pythia_permits.db"))
        again = RecordStore("pythia_permits", self.dir / "pythia_permits.db")
        self.assertEqual([r["v"] for r in again.all()], [2])

    def test_losing_an_adoption_race_keeps_the_winners_store(self):
        RecordStore("jwis_permits", self.dir / "jwis_permits.db").write("old", {"v": 1})
        target = self.dir / "pythia_permits.db"
        # Another worker publishes its adopted copy between our check and link.
        with mock.patch("app.storage.os.link", side_effect=FileExistsError):
            self.assertFalse(adopt_legacy_db(target))
        self.assertFalse(target.exists())
        self.assertEqual([p.name for p in self.dir.iterdir() if ".adopting-" in p.name], [])

    def test_noop_without_legacy_or_for_unprefixed_names(self):
        self.assertFalse(adopt_legacy_db(self.dir / "pythia_pretrip.db"))
        (self.dir / "jwis_custom.db").write_bytes(b"")
        self.assertFalse(adopt_legacy_db(self.dir / "custom.db"))
        self.assertFalse((self.dir / "pythia_pretrip.db").exists())

    def test_history_store_adopts_legacy_events(self):
        HistoryStore(self.dir / "jwis_history.db").record_event("dispatch_created", {"n": 1})
        events = HistoryStore(self.dir / "pythia_history.db").list_events()
        self.assertEqual([e["event_type"] for e in events], ["dispatch_created"])

    def test_spj_store_adopts_legacy_orders(self):
        legacy = SpjStore(db_path=str(self.dir / "jwis_spj.db"))
        spj = legacy.create("Budi", "T-210", DESTINATIONS[0], False, "normal", "")
        adopted = SpjStore(db_path=str(self.dir / "pythia_spj.db"))
        self.assertIsNotNone(adopted.get(spj.spj_id))

    def test_operations_plan_store_adopts_legacy_file(self):
        OperationsPlanStore(str(self.dir / "jwis_operations.db"))
        OperationsPlanStore(str(self.dir / "pythia_operations.db"))
        self.assertTrue((self.dir / "pythia_operations.db").exists())

    def test_spj_legacy_json_keeps_pre_rebrand_name(self):
        self.assertEqual(_legacy_json_path(os.path.join("d", "pythia_spj.db")),
                         os.path.join("d", "jwis_spj.json"))
        self.assertEqual(_legacy_json_path(os.path.join("d", "store.db")),
                         os.path.join("d", "store.json"))


if __name__ == "__main__":
    unittest.main()
