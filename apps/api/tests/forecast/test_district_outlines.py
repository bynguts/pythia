"""Twin district outlines: generated asset, kecamatan name mapping and the scene field."""

import importlib.util

import pytest
from shapely.geometry import Point, Polygon

from app.core.paths import DISTRICT_OUTLINES, REPO_ROOT
from app.forecast.engine import _KELURAHAN_SLUGS
from app.forecast.twin import kecamatan_outlines

SCRIPT = REPO_ROOT / "ml" / "scripts" / "build_district_outlines.py"


def _script():
    spec = importlib.util.spec_from_file_location("build_district_outlines", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_asset_has_a_closed_valid_ring_for_each_of_the_42_model_kecamatan():
    assert DISTRICT_OUTLINES.exists()
    outlines = kecamatan_outlines()
    assert set(outlines) == set(_KELURAHAN_SLUGS) and len(outlines) == 42
    for slug, ring in outlines.items():
        assert 4 <= len(ring) <= 400, slug
        assert ring[0] == ring[-1], slug
        polygon = Polygon(ring)
        assert polygon.is_valid and polygon.area > 0, slug
        # Jakarta's mainland bounding box, [lng, lat] order.
        assert all(106.6 < lng < 107.0 and -6.4 < lat < -6.0 for lng, lat in ring), slug


def test_boundary_names_map_onto_the_model_slugs():
    script = _script()
    assert script.slug_for("KALIDERES") == "kali_deres"
    assert script.slug_for("PAL MERAH") == "palmerah"
    assert script.slug_for("PULOGADUNG") == "pulo_gadung"
    assert script.slug_for("KRAMATJATI") == "kramat_jati"
    assert script.slug_for("GROGOL PETAMBURAN") == "grogol_petamburan"
    # The island regency has no trained model; its trailing-dot spelling is handled too.
    assert script.slug_for("KEPULAUAN SERIBU SELATAN.") is None
    assert script.slug_for("KEPULAUAN SERIBU UTARA") is None


def test_regenerating_from_the_source_reproduces_the_asset():
    script = _script()
    if not script.SOURCE.exists():
        pytest.skip("kelurahan source geojson not available")
    assert script.build()["outlines"] == kecamatan_outlines()


def test_scene_carries_an_outline_for_every_jakarta_district_and_none_for_hcmc(api_client):
    jakarta = api_client.get("/api/twin/scene", params={"days": 2}).json()
    assert len(jakarta["districts"]) == 42
    for district in jakarta["districts"]:
        ring = district["outline"]
        assert ring and ring[0] == ring[-1] and Polygon(ring).is_valid, district["id"]
        # The forecast's SILIKA point sits inside (or within ~2 km of) its own outline.
        assert Polygon(ring).buffer(0.02).contains(Point(district["lng"], district["lat"])), district["id"]
    assert jakarta["provenance"]["boundaries"]["class"] == "REAL"
    hcmc = api_client.get("/api/twin/scene", params={"city": "hcmc", "days": 2}).json()
    assert all(not d.get("outline") for d in hcmc["districts"])
