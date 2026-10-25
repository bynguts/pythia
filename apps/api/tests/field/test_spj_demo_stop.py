"""gsc-2026 P0-3: a DEMO stop at the operator's own position.

A judge-facing demo runs wherever the phone is, so the stop is placed at the
operator's GPS fix. It must be stored DEMO-labelled (name + location_type),
may be completed with an arrival geotag outside Jakarta, and may activate on
an unresolved (straight-line) route that stays labelled FALLBACK_DEGRADED and
audited. Ordinary stops keep the Jakarta evidence range and the hard routing
gate.
"""

from __future__ import annotations

import os
from unittest import mock

import pytest
from spj_testutil import fresh_store_path

from app.field.spj import DEMO_LOCATION_TYPE, SpjStore

# A phone fix far outside Jakarta (Seoul).
FAR_LAT, FAR_LNG = 37.5045, 126.9571


def _evidence(lat: float, lng: float) -> dict:
    return {
        "arrival": {
            "photo_name": "datang.jpg",
            "photo_b64": "data:image/jpeg;base64,AAA",
            "lat": lat,
            "lng": lng,
        },
        "weighing": [],
        "officer": {
            "photo_name": "petugas.jpg",
            "photo_b64": "data:image/jpeg;base64,CCC",
            "name": "Petugas",
        },
    }


def _straight(coords):
    return {
        "geometry": [{"lat": la, "lng": ln} for la, ln in coords],
        "distance_km": 0.0,
        "duration_min": 0,
        "source": "FALLBACK_DEGRADED",
    }


def _draft(store: SpjStore, demo: bool, truck: str):
    spj = store.create(
        driver_name="A",
        truck_code=truck,
        destination="TPST Bantargebang",
        weigh_on_site=False,
        priority="normal",
        note="",
    )
    store.add_stop(
        spj.spj_id,
        name="Lokasi operator",
        kecamatan="DEMO",
        address="DEMO",
        lat=FAR_LAT,
        lng=FAR_LNG,
        demo=demo,
    )
    return spj.spj_id


def test_demo_stop_is_stored_with_demo_labels():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_labels.db"))
    spj_id = _draft(store, demo=True, truck="T-D1")
    stop = store.get(spj_id).stops[0]
    assert stop.name == "DEMO · Lokasi operator"
    assert stop.location_type == DEMO_LOCATION_TYPE


def test_demo_stop_activates_on_unresolved_route_with_audit_and_completes_far_from_jakarta():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_complete.db"))
    spj_id = _draft(store, demo=True, truck="T-D2")
    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "off"}),
        mock.patch("app.field.spj.road_route", side_effect=_straight),
    ):
        spj = store.activate(spj_id)
    assert spj.status == "aktif"
    assert spj.route_source == "FALLBACK_DEGRADED"
    assert any(e["action"] == "demo_straight_fallback" for e in store.audit_log(spj_id))

    spj = store.complete_stop(spj_id, 0, evidence=_evidence(FAR_LAT, FAR_LNG))
    assert spj.status == "selesai"


def test_ordinary_stop_keeps_jakarta_range_and_routing_gate():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_ordinary.db"))
    spj_id = _draft(store, demo=False, truck="T-D3")
    assert store.get(spj_id).stops[0].location_type != DEMO_LOCATION_TYPE
    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "off"}),
        mock.patch("app.field.spj.road_route", side_effect=_straight),
    ):
        with pytest.raises(ValueError, match="road"):
            store.activate(spj_id)

    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "on"}),
        mock.patch("app.field.spj.road_route", side_effect=_straight),
    ):
        store.activate(spj_id)
    with pytest.raises(ValueError, match="Jakarta"):
        store.complete_stop(spj_id, 0, evidence=_evidence(FAR_LAT, FAR_LNG))


def test_stop_endpoint_accepts_demo_flag(api_client, auth_headers):
    headers = auth_headers("dispatcher")
    created = api_client.post(
        "/api/spj",
        headers=headers,
        json={"driver_name": "A", "truck_code": "T-D4", "destination": "TPST Bantargebang"},
    )
    assert created.status_code == 201, created.text
    spj_id = created.json()["spj_id"]
    try:
        res = api_client.post(
            f"/api/spj/{spj_id}/stops",
            headers=headers,
            json={
                "name": "Lokasi operator",
                "kecamatan": "DEMO",
                "address": "DEMO",
                "lat": FAR_LAT,
                "lng": FAR_LNG,
                "demo": True,
            },
        )
        assert res.status_code == 200, res.text
        stop = res.json()["stops"][0]
        assert stop["name"].startswith("DEMO")
        assert stop["location_type"] == DEMO_LOCATION_TYPE
    finally:
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=headers)


# ── gsc review M2: the DEMO exemptions cannot be claimed with a free-text location_type ──


@pytest.mark.parametrize("spoof", ["DEMO", "demo", " Demo "])
def test_store_rejects_demo_location_type_without_the_demo_flag(spoof):
    store = SpjStore(persist_path=fresh_store_path("spj_demo_spoof.db"))
    spj = store.create(
        driver_name="A",
        truck_code="T-D5",
        destination="TPST Bantargebang",
        weigh_on_site=False,
        priority="normal",
        note="",
    )
    with pytest.raises(ValueError, match="demo=true"):
        store.add_stop(spj.spj_id, "Stop", "Gambir", "Alamat", -6.17, 106.82, location_type=spoof)
    assert store.get(spj.spj_id).stops == []


def test_spoofed_demo_location_type_is_a_409(api_client, auth_headers):
    headers = auth_headers("dispatcher")
    stop = {"name": "Stop", "kecamatan": "Gambir", "address": "Alamat", "lat": FAR_LAT, "lng": FAR_LNG}
    composed = api_client.post(
        "/api/spj",
        headers=headers,
        json={
            "driver_name": "A",
            "truck_code": "T-D6",
            "destination": "TPST Bantargebang",
            "stops": [{**stop, "location_type": "DEMO"}],
        },
    )
    assert composed.status_code == 409, composed.text

    created = api_client.post(
        "/api/spj",
        headers=headers,
        json={"driver_name": "A", "truck_code": "T-D6", "destination": "TPST Bantargebang"},
    )
    assert created.status_code == 201, created.text
    spj_id = created.json()["spj_id"]
    try:
        spoofed = api_client.post(
            f"/api/spj/{spj_id}/stops", headers=headers, json={**stop, "location_type": "DEMO"}
        )
        assert spoofed.status_code == 409, spoofed.text
        # demo=true is the one way in, and it still stores the DEMO labels.
        flagged = api_client.post(
            f"/api/spj/{spj_id}/stops",
            headers=headers,
            json={**stop, "location_type": "DEMO", "demo": True},
        )
        assert flagged.status_code == 200, flagged.text
        assert flagged.json()["stops"][0]["location_type"] == DEMO_LOCATION_TYPE
    finally:
        api_client.post(f"/api/spj/{spj_id}/cancel", headers=headers)


# ── gsc review n18: the DEMO routing exemption covers only legs touching a DEMO stop ──

JAKARTA_STOP = (-6.1754, 106.8272)


def _road_except_far(coords):
    # Roads resolve everywhere in Jakarta; only a leg touching the far DEMO fix degrades.
    if any(lat == FAR_LAT for lat, _ in coords):
        return _straight(coords)
    return {**_straight(coords), "source": "LIVE_EXTERNAL"}


def _demo_then_ordinary(store: SpjStore, truck: str) -> str:
    spj_id = _draft(store, demo=True, truck=truck)
    store.add_stop(spj_id, "TPS Gambir", "Gambir", "Alamat", *JAKARTA_STOP)
    return spj_id


def test_demo_stop_does_not_exempt_an_unresolved_ordinary_leg():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_leg_gate.db"))
    spj_id = _demo_then_ordinary(store, "T-D7")
    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "off"}),
        mock.patch("app.field.spj.road_route", side_effect=_straight),
    ):
        with pytest.raises(ValueError, match="road"):
            store.activate(spj_id)
    assert store.get(spj_id).status == "draft"


def test_demo_exemption_applies_when_only_demo_legs_are_unresolved():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_leg_ok.db"))
    spj_id = _demo_then_ordinary(store, "T-D8")
    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "off"}),
        mock.patch("app.field.spj.road_route", side_effect=_road_except_far),
    ):
        spj = store.activate(spj_id)
    assert spj.status == "aktif"
    assert spj.route_source == "FALLBACK_DEGRADED"
    assert any(e["action"] == "demo_straight_fallback" for e in store.audit_log(spj_id))


# ── gsc #6: a DEMO SPJ keeps the road geometry of every leg that resolves ──

# A second DEMO fix 300 m north of the first, reachable by road.
NEAR_LAT = FAR_LAT + 0.0027
ROAD_CORNER = (FAR_LAT, FAR_LNG + 0.002)


def _road_between_demo_fixes(coords):
    # Only the leg between the two DEMO fixes resolves (via a corner); any
    # call that reaches the Jakarta destination degrades to a straight line.
    if len(coords) == 2 and all(lat > 30 for lat, _ in coords):
        (a_lat, a_lng), (b_lat, b_lng) = coords
        geometry = [(a_lat, a_lng), ROAD_CORNER, (b_lat, ROAD_CORNER[1]), (b_lat, b_lng)]
        return {**_straight(geometry), "source": "LIVE_EXTERNAL"}
    return _straight(coords)


def test_demo_leg_from_stop_1_keeps_its_road_geometry_while_the_spj_stays_degraded():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_leg_road.db"))
    spj_id = _draft(store, demo=True, truck="T-D9")
    store.add_stop(spj_id, "Lokasi operator 2", "DEMO", "DEMO", NEAR_LAT, FAR_LNG, demo=True)
    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "off"}),
        mock.patch("app.field.spj.road_route", side_effect=_road_between_demo_fixes),
    ):
        spj = store.activate(spj_id)
    # Honest label: the SPJ as a whole is not road-resolved.
    assert spj.route_source == "FALLBACK_DEGRADED"
    geometry = [tuple(p) for p in spj.route_geometry]
    # Stop 1 → stop 2 follows the road (the corner vertices are kept) ...
    assert geometry[:4] == [(FAR_LAT, FAR_LNG), ROAD_CORNER, (NEAR_LAT, ROAD_CORNER[1]), (NEAR_LAT, FAR_LNG)]
    # ... and only the unresolved hop to the destination is a straight segment.
    assert len(geometry) == 5
    assert geometry[-1] != geometry[-2]
    audit = next(e for e in store.audit_log(spj_id) if e["action"] == "demo_straight_fallback")
    assert audit["payload"]["road_legs"] == 1
    assert audit["payload"]["legs"] == 2


def test_demo_spj_with_no_resolvable_leg_stays_a_straight_line():
    store = SpjStore(persist_path=fresh_store_path("spj_demo_leg_none.db"))
    spj_id = _draft(store, demo=True, truck="T-D10")
    with (
        mock.patch.dict(os.environ, {"PYTHIA_SPJ_STRAIGHT_FALLBACK": "off"}),
        mock.patch("app.field.spj.road_route", side_effect=_straight),
    ):
        spj = store.activate(spj_id)
    assert spj.route_source == "FALLBACK_DEGRADED"
    assert len(spj.route_geometry) == 2  # the DEMO fix and the destination, nothing else
