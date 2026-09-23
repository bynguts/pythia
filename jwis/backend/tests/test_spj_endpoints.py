import unittest

from fastapi.testclient import TestClient

from app.main import app

EVIDENCE = {"arrival": {"photo_name": "a.jpg", "lat": -6.29, "lng": 106.79},
            "weighing": [], "officer": {"photo_name": "p.jpg", "name": "Petugas"}}


class SpjEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, raise_server_exceptions=False)
        _login = self.client.post("/api/auth/login", json={"username": "administrator", "password": "administrator-demo-pass"})
        self.client.headers.update({"Authorization": f"Bearer {_login.json()['token']}"})
        created = self.client.post("/api/spj", json={
            "driver_name": "Test Driver", "truck_code": "T-200",
            "destination": "TPST Bantargebang", "weigh_on_site": True,
            "priority": "normal", "note": "endpoint test",
        })
        self.assertEqual(created.status_code, 201)
        self.spj = created.json()

    def _add_stop_and_activate(self):
        r = self.client.post(f"/api/spj/{self.spj['spj_id']}/stops", json={
            "name": "TPS Test", "kecamatan": "Cilandak",
            "address": "Jl. Test 1", "lat": -6.29, "lng": 106.79,
        })
        self.assertEqual(r.status_code, 200)
        act = self.client.post(f"/api/spj/{self.spj['spj_id']}/activate")
        self.assertEqual(act.status_code, 200)
        return act.json()

    def tearDown(self):
        self.client.post(f"/api/spj/{self.spj['spj_id']}/cancel")

    def test_create_draft_201(self):
        self.assertEqual(self.spj["status"], "draft")
        self.assertTrue(self.spj["spj_number"].startswith("DLH-DKI/SPJ/"))
        self.assertEqual(self.spj["weigh_on_site"], True)

    def test_get_detail_and_404(self):
        r = self.client.get(f"/api/spj/{self.spj['spj_id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["spj_id"], self.spj["spj_id"])
        missing = self.client.get("/api/spj/does-not-exist")
        self.assertEqual(missing.status_code, 404)

    def test_list_with_status_filter(self):
        r = self.client.get("/api/spj?status=draft")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("count", body)
        ids = [s["spj_id"] for s in body["spj"]]
        self.assertIn(self.spj["spj_id"], ids)
        self.assertTrue(all(s["status"] == "draft" for s in body["spj"]))

    def test_activate_requires_stop_409(self):
        r = self.client.post(f"/api/spj/{self.spj['spj_id']}/activate")
        self.assertEqual(r.status_code, 409)

    def test_full_lifecycle(self):
        activated = self._add_stop_and_activate()
        self.assertEqual(activated["status"], "aktif")
        self.assertEqual(len(activated["stops"]), 1)
        done = self.client.post(
            f"/api/spj/{self.spj['spj_id']}/stops/0/complete",
            json={"evidence": EVIDENCE})
        self.assertEqual(done.status_code, 200)
        self.assertEqual(done.json()["status"], "selesai")
        self.assertEqual(done.json()["stops"][0]["evidence"]["officer"]["name"],
                         "Petugas")
        cancel = self.client.post(f"/api/spj/{self.spj['spj_id']}/cancel")
        self.assertEqual(cancel.status_code, 409)  # selesai cannot cancel

    def test_completion_without_evidence_409(self):
        """The Fleet panel's evidence-less completion must be refused."""
        self._add_stop_and_activate()
        r = self.client.post(f"/api/spj/{self.spj['spj_id']}/stops/0/complete")
        self.assertEqual(r.status_code, 409)
        self.assertIn("evidence", r.json()["detail"].lower())

    def test_supervisor_override_completes_with_reason(self):
        self._add_stop_and_activate()
        r = self.client.post(f"/api/spj/{self.spj['spj_id']}/complete", json={
            "override": {"reason": "Kamera rusak; bukti menyusul via WhatsApp"}})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "selesai")
        override = body["stops"][0]["override"]
        self.assertEqual(override["actor"], "administrator")
        self.assertIn("Kamera rusak", override["reason"])

    def test_override_requires_reason_422(self):
        self._add_stop_and_activate()
        self.assertEqual(
            self.client.post(f"/api/spj/{self.spj['spj_id']}/complete",
                             json={}).status_code, 409)
        self.assertEqual(
            self.client.post(f"/api/spj/{self.spj['spj_id']}/complete",
                             json={"override": {"reason": "short"}}).status_code,
            422)

    def test_dispatcher_cannot_use_the_override_path(self):
        """The exceptional path is gated by dispatch:override."""
        self._add_stop_and_activate()
        login = self.client.post("/api/auth/login", json={
            "username": "dispatcher", "password": "dispatcher-demo-pass"})
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        r = self.client.post(f"/api/spj/{self.spj['spj_id']}/complete",
                             json={"override": {"reason": "Lewati bukti lapangan"}},
                             headers=headers)
        self.assertEqual(r.status_code, 403)

    def test_out_of_order_stop_completion_409(self):
        self.client.post(f"/api/spj/{self.spj['spj_id']}/stops", json={
            "name": "TPS Pertama", "kecamatan": "Cilandak",
            "address": "Jl. Test 1", "lat": -6.29, "lng": 106.79})
        self.client.post(f"/api/spj/{self.spj['spj_id']}/stops", json={
            "name": "TPS Kedua", "kecamatan": "Cilandak",
            "address": "Jl. Test 2", "lat": -6.28, "lng": 106.78})
        activated = self.client.post(
            f"/api/spj/{self.spj['spj_id']}/activate")
        self.assertEqual(activated.status_code, 200)
        skipped = self.client.post(
            f"/api/spj/{self.spj['spj_id']}/stops/1/complete",
            json={"evidence": EVIDENCE})
        self.assertEqual(skipped.status_code, 409)
        detail = self.client.get(f"/api/spj/{self.spj['spj_id']}").json()
        self.assertEqual([s["status"] for s in detail["stops"]],
                         ["pending", "pending"])

    def test_destination_provenance_endpoint(self):
        r = self.client.get("/api/spj/destinations")
        self.assertEqual(r.status_code, 200)
        by_name = {d["name"]: d for d in r.json()["destinations"]}
        self.assertEqual(set(by_name), {"TPST Bantargebang", "JRC Pesanggrahan",
                                        "RDF Plant Jakarta"})
        self.assertTrue(by_name["TPST Bantargebang"]["usable_for_routing"])
        self.assertTrue(by_name["TPST Bantargebang"]["source_url"])
        # No sourced coordinate exists for the JRC site, and the API says so.
        self.assertFalse(by_name["JRC Pesanggrahan"]["usable_for_routing"])
        self.assertEqual(by_name["JRC Pesanggrahan"]["verification_status"],
                         "unverified")

    def test_active_path_endpoint(self):
        self._add_stop_and_activate()
        r = self.client.get(f"/api/spj/active-path/{self.spj['truck_code']}")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["has_active_spj"])
        self.assertEqual(len(body["path"]), 2)  # 1 stop + destination
        self.assertEqual(body["path"][0]["lat"], -6.29)
        none_case = self.client.get("/api/spj/active-path/T-254")
        self.assertIn(none_case.json()["has_active_spj"], (True, False))

    def test_invalid_destination_409(self):
        r = self.client.post("/api/spj", json={
            "driver_name": "X", "truck_code": "T-201",
            "destination": "TPA Liar", "weigh_on_site": False,
            "priority": "normal", "note": "",
        })
        self.assertEqual(r.status_code, 409)

    def test_double_activation_same_truck_409(self):
        self._add_stop_and_activate()
        second = self.client.post("/api/spj", json={
            "driver_name": "Y", "truck_code": self.spj["truck_code"],
            "destination": "RDF Plant Jakarta", "weigh_on_site": False,
            "priority": "vip", "note": "",
        })
        sid = second.json()["spj_id"]
        self.client.post(f"/api/spj/{sid}/stops", json={
            "name": "S", "kecamatan": "K", "address": "A",
            "lat": -6.2, "lng": 106.8,
        })
        r = self.client.post(f"/api/spj/{sid}/activate")
        self.assertEqual(r.status_code, 409)
        self.client.post(f"/api/spj/{sid}/cancel")


if __name__ == "__main__":
    unittest.main()
