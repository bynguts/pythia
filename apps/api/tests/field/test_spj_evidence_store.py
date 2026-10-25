"""Gaps 3, 8 and H10: evidence photos out of the SPJ record, geotag honesty, weighing, net weight."""

from __future__ import annotations

import base64
import io
import json
from contextlib import closing

import pytest
from spj_testutil import fresh_store_path

from app.field.spj import APPROX_GEOTAG_LABEL, SpjStore

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _evidence(lat=-6.17, lng=106.82, approx=False, weighing=True, accuracy=None):
    arrival = {"photo_name": "a.png", "photo_b64": TINY_PNG, "lat": lat, "lng": lng, "approx": approx}
    if accuracy is not None:
        arrival["accuracy_m"] = accuracy
    return {
        "arrival": arrival,
        "weighing": (
            [{"fraction": "Residu", "weight_kg": 40.0, "photo_name": "w.png", "photo_b64": TINY_PNG}]
            if weighing
            else []
        ),
        "officer": {"name": "Petugas Contoh", "photo_name": "o.png", "photo_b64": TINY_PNG},
    }


def _store_with_active_spj(name: str, weigh_on_site: bool = False):
    store = SpjStore(fresh_store_path(name))
    spj = store.create_with_stops(
        "Pengemudi Sim 05",
        "T-EVD",
        "TPST Bantargebang",
        weigh_on_site,
        "normal",
        "",
        [
            {"name": "TPS 1", "kecamatan": "Gambir", "address": "Jl. 1", "lat": -6.17, "lng": 106.82},
            {"name": "TPS 2", "kecamatan": "Gambir", "address": "Jl. 2", "lat": -6.18, "lng": 106.83},
        ],
        created_by="dispatcher.contoh",
    )
    store.activate(spj.spj_id, actor="dispatcher.contoh")
    return store, spj


def test_photos_leave_the_spj_record_and_get_numbered_refs():
    store, spj = _store_with_active_spj("pythia_spj_evd_refs.db")
    done = store.complete_stop(spj.spj_id, 0, evidence=_evidence(), actor="sopir.contoh01")
    evidence = done.stops[0].evidence
    assert "photo_b64" not in json.dumps(evidence)
    refs = [
        evidence["arrival"]["photo_ref"],
        evidence["weighing"][0]["photo_ref"],
        evidence["officer"]["photo_ref"],
    ]
    assert refs == [1, 2, 3]
    photo = store.evidence_photo(spj.spj_id, 3)
    assert photo["slot"] == "officer" and photo["photo_b64"] == TINY_PNG
    # The cache reloaded from disk holds no bytes either.
    reloaded = SpjStore(store._path)
    assert "photo_b64" not in json.dumps([s.evidence for s in reloaded.get(spj.spj_id).stops])
    assert any(e["actor"] == "sopir.contoh01" for e in store.audit_log(spj.spj_id))


def test_legacy_inline_photos_are_migrated_on_open():
    store, spj = _store_with_active_spj("pythia_spj_evd_migrate.db")
    legacy = _evidence()
    with closing(store._connect()) as connection, connection:
        connection.execute(
            "UPDATE spj_stops SET status='completed', evidence=? WHERE spj_id=? AND idx=0",
            (json.dumps(legacy), spj.spj_id),
        )
    migrated = SpjStore(store._path)
    evidence = migrated.get(spj.spj_id).stops[0].evidence
    assert "photo_b64" not in json.dumps(evidence)
    assert migrated.evidence_photo(spj.spj_id, evidence["arrival"]["photo_ref"])["photo_b64"] == TINY_PNG


def test_weighing_is_required_only_when_the_spj_orders_it():
    store, spj = _store_with_active_spj("pythia_spj_evd_weigh_off.db", weigh_on_site=False)
    store.complete_stop(spj.spj_id, 0, evidence=_evidence(weighing=False))
    store, spj = _store_with_active_spj("pythia_spj_evd_weigh_on.db", weigh_on_site=True)
    with pytest.raises(ValueError, match="weigh_on_site"):
        store.complete_stop(spj.spj_id, 0, evidence=_evidence(weighing=False))
    store.complete_stop(spj.spj_id, 0, evidence=_evidence(weighing=True))


def test_receipt_keeps_gross_and_stores_net_with_a_tare():
    store, spj = _store_with_active_spj("pythia_spj_evd_net.db")
    store.complete_stop(spj.spj_id, 0, evidence=_evidence())
    store.complete_stop(spj.spj_id, 1, evidence=_evidence(lat=-6.18, lng=106.83))
    with pytest.raises(ValueError, match="tare"):
        store.record_receipt(spj.spj_id, "s.png", TINY_PNG, 16_000.0, "manual", tare_weight_kg=17_000.0)
    done = store.record_receipt(spj.spj_id, "s.png", TINY_PNG, 16_000.0, "manual", tare_weight_kg=9_500.0)
    assert done.receipt["gross_weight_kg"] == 16_000.0
    assert done.receipt["tare_weight_kg"] == 9_500.0
    assert done.receipt["net_weight_kg"] == 6_500.0


# --- API -----------------------------------------------------------------------


def _api_active_spj(api_client, headers, truck, weigh_on_site=False):
    created = api_client.post(
        "/api/spj",
        json={
            "driver_name": "Pengemudi Sim 05",
            "truck_code": truck,
            "destination": "TPST Bantargebang",
            "weigh_on_site": weigh_on_site,
            "stops": [
                {"name": "TPS 1", "kecamatan": "Gambir", "address": "Jl. 1", "lat": -6.17, "lng": 106.82},
                {"name": "TPS 2", "kecamatan": "Gambir", "address": "Jl. 2", "lat": -6.18, "lng": 106.83},
            ],
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    spj_id = created.json()["spj_id"]
    assert api_client.post(f"/api/spj/{spj_id}/activate", headers=headers).status_code == 200
    return spj_id


def test_evidence_summary_flags_an_approximate_geotag_and_serves_photos(api_client, auth_headers):
    admin, driver = auth_headers("administrator"), auth_headers("driver")
    spj_id = _api_active_spj(api_client, admin, "T-EVD-API")
    # Stop 0: no GPS fix, the app stored the stop's own coordinates.
    api_client.post(
        f"/api/spj/{spj_id}/stops/0/complete", json={"evidence": _evidence(approx=True)}, headers=driver
    )
    # Stop 1: a GPS fix ~400 m from the stop.
    far = _evidence(lat=-6.1836, lng=106.8300, accuracy=12)
    api_client.post(f"/api/spj/{spj_id}/stops/1/complete", json={"evidence": far}, headers=driver)

    summary = api_client.get(f"/api/spj/{spj_id}/evidence-summary", headers=admin).json()
    first, second = summary["stops"]
    assert first["geotag"]["status"] == "approx"
    assert first["geotag"]["label"] == APPROX_GEOTAG_LABEL == "Approximate, not GPS"
    assert first["geotag"]["flagged"] is True
    assert second["geotag"]["status"] == "gps" and second["geotag"]["accuracy_m"] == 12
    assert second["geotag"]["distance_to_stop_m"] > 150 and second["geotag"]["flagged"] is True
    assert [p["slot"] for p in first["photos"]] == ["arrival", "weighing-0", "officer"]

    n = first["photos"][0]["n"]
    image = api_client.get(f"/api/spj/{spj_id}/evidence/{n}", headers=admin)
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert image.content == base64.b64decode(TINY_PNG.split(",", 1)[1])
    thumb = api_client.get(f"/api/spj/{spj_id}/evidence/{n}/thumb", headers=admin)
    assert thumb.status_code == 200
    assert thumb.headers["x-pythia-image-variant"] in ("thumbnail", "original")
    if thumb.headers["x-pythia-image-variant"] == "thumbnail":
        from PIL import Image

        assert Image.open(io.BytesIO(thumb.content)).format == "JPEG"
    assert api_client.get(f"/api/spj/{spj_id}/evidence/99", headers=admin).status_code == 404
    assert (
        api_client.get(f"/api/spj/{spj_id}/evidence/{n}", headers=auth_headers("dispatcher")).status_code
        == 200
    )


def test_spj_list_drops_geometry_and_filters(api_client, auth_headers):
    admin = auth_headers("administrator")
    first = _api_active_spj(api_client, admin, "T-EVD-LST1")
    second = _api_active_spj(api_client, admin, "T-EVD-LST2")
    listing = api_client.get("/api/spj?status=aktif&truck_code=T-EVD-LST1", headers=admin).json()
    assert [s["spj_id"] for s in listing["spj"]] == [first]
    assert "route_geometry" not in listing["spj"][0] and listing["spj"][0]["route_point_count"] >= 2
    limited = api_client.get("/api/spj?status=aktif&limit=1", headers=admin).json()
    assert limited["count"] == 1
    assert api_client.get("/api/spj?limit=0", headers=admin).status_code == 422
    for spj_id in (first, second):
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=admin)


def test_receipt_api_labels_gross_and_net(api_client, auth_headers):
    admin, driver = auth_headers("administrator"), auth_headers("driver")
    spj_id = _api_active_spj(api_client, admin, "T-EVD-RCPT")
    for i, (lat, lng) in enumerate([(-6.17, 106.82), (-6.18, 106.83)]):
        res = api_client.post(
            f"/api/spj/{spj_id}/stops/{i}/complete",
            json={"evidence": _evidence(lat=lat, lng=lng)},
            headers=driver,
        )
        assert res.status_code == 200, res.text
    res = api_client.post(
        f"/api/spj/{spj_id}/receipt",
        json={
            "photo_name": "struk.png",
            "photo_b64": TINY_PNG,
            "total_weight_kg": 15_000,
            "tare_weight_kg": 9_000,
            "weight_source": "manual",
        },
        headers=driver,
    )
    assert res.status_code == 201, res.text
    posted = res.json()["receipt"]  # the driver's done screen reads the stored weights from here
    assert posted["net_weight_kg"] == 6_000 and "photo_b64" not in posted
    receipt = api_client.get(f"/api/spj/{spj_id}", headers=admin).json()["receipt"]
    assert receipt["gross_weight_kg"] == 15_000 and receipt["net_weight_kg"] == 6_000
    assert receipt["total_weight_kg"] == 15_000  # legacy name = gross
    assert "Gross" in receipt["weight_labels"]["gross_weight_kg"]
    assert "Net" in receipt["weight_labels"]["net_weight_kg"]
