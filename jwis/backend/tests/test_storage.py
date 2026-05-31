import tempfile
import unittest
from pathlib import Path

from app.storage import HistoryStore


class StorageTests(unittest.TestCase):
    def test_history_store_records_dispatch_and_prediction_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = HistoryStore(Path(tmp) / "history.db")

            store.record_event("dispatch", {"truck_code": "T-047", "status": "PENDING"})
            store.record_event("prediction", {"district": "Jakarta Barat", "spike_percent": 41})

            events = store.list_events()

            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["event_type"], "prediction")
            self.assertEqual(events[1]["event_type"], "dispatch")


if __name__ == "__main__":
    unittest.main()
