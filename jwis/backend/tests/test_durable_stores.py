"""Durable-store guarantees that the JSON stores did not provide (issue #20).

Each test runs two *processes*, not two threads: the failure mode being
regression-tested is divergent in-process state, which a thread test cannot
reproduce because both threads share one dict.
"""
import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path

from app.damage_reports import DamageReportStore
from app.permits import PermitStore
from app.spj import SpjStore
from app.storage import RecordStore, StorageError

EVIDENCE = {"arrival": {"photo_name": "a.jpg", "lat": -6.2, "lng": 106.8},
            "weighing": [], "officer": {"photo_name": "p.jpg", "name": "X"}}


def _create_worker(db_path: str, truck: str, created, errors) -> None:
    """Child process: build its own store and create one SPJ."""
    try:
        store = SpjStore(db_path=db_path)
        spj = store.create(driver_name="Worker", truck_code=truck,
                           destination="TPST Bantargebang", weigh_on_site=False,
                           priority="normal", note="")
        created.put((spj.spj_id, spj.spj_number))
    except Exception as exc:  # noqa: BLE001 - reported to the parent
        errors.put(f"{type(exc).__name__}: {exc}")


def _activate_worker(db_path: str, spj_id: str, truck: str, results) -> None:
    try:
        store = SpjStore(db_path=db_path)
        store.add_stop(spj_id, name="S", kecamatan="K", address="A",
                       lat=-6.2, lng=106.8)
        store.activate(spj_id)
        results.put(("ok", truck))
    except ValueError as exc:
        results.put(("refused", str(exc)))
    except Exception as exc:  # noqa: BLE001
        results.put(("error", f"{type(exc).__name__}: {exc}"))


class MultiProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "spj.db")

    def tearDown(self):
        self.tmp.cleanup()

    def test_concurrent_creates_allocate_unique_numbers(self):
        """Two workers creating at the same time must not collide."""
        ctx = multiprocessing.get_context("spawn")
        created, errors = ctx.Queue(), ctx.Queue()
        procs = [
            ctx.Process(target=_create_worker,
                        args=(self.db, f"T-{i:03d}", created, errors))
            for i in range(6)
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(60)

        self.assertTrue(errors.empty(),
                        [errors.get() for _ in range(errors.qsize())])
        records = [created.get() for _ in range(created.qsize())]
        self.assertEqual(len(records), 6)
        self.assertEqual(len({spj_id for spj_id, _ in records}), 6)
        numbers = [number for _, number in records]
        self.assertEqual(len(set(numbers)), 6,
                         f"daily sequence reused: {sorted(numbers)}")

        # Every record survived: the file is shared state, not a last-write-wins copy.
        store = SpjStore(db_path=self.db)
        self.assertEqual(len(store.list()), 6)

    def test_concurrent_activate_keeps_one_active_per_truck(self):
        """Lifecycle invariant survives a cross-process race."""
        store = SpjStore(db_path=self.db)
        first = store.create(driver_name="A", truck_code="T-500",
                             destination="TPST Bantargebang", weigh_on_site=False,
                             priority="normal", note="")
        second = store.create(driver_name="B", truck_code="T-500",
                              destination="TPST Bantargebang", weigh_on_site=False,
                              priority="normal", note="")

        ctx = multiprocessing.get_context("spawn")
        results = ctx.Queue()
        procs = [
            ctx.Process(target=_activate_worker,
                        args=(self.db, spj_id, label, results))
            for spj_id, label in ((first.spj_id, "first"), (second.spj_id, "second"))
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(60)

        outcomes = [results.get() for _ in range(results.qsize())]
        self.assertEqual([o[0] for o in outcomes].count("ok"), 1,
                         f"expected exactly one activation to win: {outcomes}")
        self.assertEqual([o[0] for o in outcomes].count("refused"), 1)

        reloaded = SpjStore(db_path=self.db)
        active = [s for s in reloaded.list(status="aktif")
                  if s.truck_code == "T-500"]
        self.assertEqual(len(active), 1)

    def test_restart_preserves_every_record(self):
        store = SpjStore(db_path=self.db)
        created = [store.create(driver_name=f"D{i}", truck_code=f"T-6{i:02d}",
                                destination="TPST Bantargebang",
                                weigh_on_site=False, priority="normal",
                                note="").spj_id
                   for i in range(5)]
        reopened = SpjStore(db_path=self.db)
        self.assertEqual(sorted(s.spj_id for s in reopened.list()),
                         sorted(created))


class WriteFailureTests(unittest.TestCase):
    def test_write_failure_raises_instead_of_acknowledging(self):
        """A store that cannot commit must not return a success object."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "readonly" / "spj.db"
        db.parent.mkdir()
        store = SpjStore(db_path=db)
        db.parent.chmod(0o500)  # directory no longer writable
        self.addCleanup(db.parent.chmod, 0o700)
        try:
            with self.assertRaises(StorageError):
                store.create(driver_name="A", truck_code="T-700",
                             destination="TPST Bantargebang", weigh_on_site=False,
                             priority="normal", note="")
        finally:
            db.parent.chmod(0o700)

    def test_unreadable_legacy_file_does_not_break_startup(self):
        """A corrupt pre-migration JSON store must not stop the service booting."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        legacy = Path(tmp.name) / "jwis_damage_reports.json"
        legacy.write_text("{not json", encoding="utf-8")
        db = Path(tmp.name) / "jwis_damage_reports.db"
        store = DamageReportStore(db_path=db)
        self.assertEqual(store.list(), [])

    def test_legacy_json_is_imported_once_then_retired(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        legacy = Path(tmp.name) / "jwis_spj.json"
        legacy.write_text(json.dumps([{
            "spj_id": "legacy000001", "spj_number": "DLH-DKI/SPJ/01-01-2026/000007",
            "date": "2026-01-01", "driver_name": "Legacy", "truck_code": "T-800",
            "destination": "TPST Bantargebang", "weigh_on_site": False,
            "priority": "normal", "note": "", "stops": [], "status": "draft",
            "created_by": "admin", "created_at": "2026-01-01T00:00:00+00:00",
        }]), encoding="utf-8")
        records = RecordStore("jwis_spj", Path(tmp.name) / "jwis_spj.db")
        imported = records.migrate_legacy_json(legacy, "spj_id")
        self.assertEqual(imported, 1)
        self.assertEqual(len(records.all()), 1)
        self.assertFalse(legacy.exists())
        self.assertTrue(legacy.with_suffix(".json.migrated").exists())
        # A second call must not duplicate or resurrect anything.
        self.assertEqual(records.migrate_legacy_json(
            legacy.with_suffix(".json.migrated"), "spj_id"), 0)
        self.assertEqual(len(records.all()), 1)


class PermitStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "permits.db"

    def tearDown(self):
        self.tmp.cleanup()

    def test_ids_are_stable_and_never_reused_after_restart(self):
        store = PermitStore(db_path=self.db)
        first = store.add({"id": store.next_id(), "name": "A"})
        second = store.add({"id": store.next_id(), "name": "B"})
        self.assertEqual((first["id"], second["id"]),
                         ("EV-USER-001", "EV-USER-002"))

        reopened = PermitStore(db_path=self.db)
        self.assertEqual([p["id"] for p in reopened.list()],
                         ["EV-USER-001", "EV-USER-002"])
        # Deleting the newest must not let its identifier be handed out again.
        third = reopened.add({"id": reopened.next_id(), "name": "C"})
        self.assertEqual(third["id"], "EV-USER-003")

    def test_permit_survives_restart_with_full_payload(self):
        store = PermitStore(db_path=self.db)
        permit = {
            "id": store.next_id(), "name": "Konser", "expected_attendance": 70000,
            "affected_kecamatan": [{"kecamatan": "Gambir", "slug": "gambir",
                                    "distance_m": 120}],
            "impact": {"predicted_waste_tons": 84.0, "crews_required": 5},
        }
        store.add(permit)
        reopened = PermitStore(db_path=self.db)
        loaded = reopened.list()[0]
        self.assertEqual(loaded["expected_attendance"], 70000)
        self.assertEqual(loaded["affected_kecamatan"][0]["slug"], "gambir")
        self.assertEqual(loaded["impact"]["predicted_waste_tons"], 84.0)


class SpjEvidencePersistenceTests(unittest.TestCase):
    def test_stop_evidence_and_override_survive_restart(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "spj.db"
        store = SpjStore(db_path=db)
        spj = store.create(driver_name="A", truck_code="T-900",
                           destination="TPST Bantargebang", weigh_on_site=False,
                           priority="normal", note="")
        for name, lat in (("S1", -6.2), ("S2", -6.3)):
            store.add_stop(spj.spj_id, name=name, kecamatan="K", address="A",
                           lat=lat, lng=106.8)
        store.activate(spj.spj_id)
        store.complete_stop(spj.spj_id, 0, evidence=EVIDENCE)
        store.complete_stop(spj.spj_id, 1, actor="supervisor",
                            override={"reason": "Bukti hilang di lapangan"})

        reopened = SpjStore(db_path=db)
        loaded = reopened.get(spj.spj_id)
        self.assertEqual(loaded.status, "selesai")
        self.assertEqual(loaded.stops[0].evidence["officer"]["name"], "X")
        self.assertIsNone(loaded.stops[1].evidence)
        self.assertEqual(loaded.stops[1].override["actor"], "supervisor")


if __name__ == "__main__":
    unittest.main()
