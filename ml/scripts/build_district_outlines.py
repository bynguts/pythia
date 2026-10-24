"""Build the twin's Jakarta kecamatan outlines from the real kelurahan polygons.

Run from the repository root:
    python ml/scripts/build_district_outlines.py

Reads `ml/data/real/kelurahan_dki_full_267.geojson` (267 DKI kelurahan,
pararawendy/border-indonesia-geojson, 2020), dissolves the villages by
`sub_district` (kecamatan), keeps the outer ring of each kecamatan's largest
part, simplifies it and writes `apps/api/data/assets/jakarta_kecamatan_outlines.json`
keyed by the 42 model kecamatan slugs the twin uses (`app/forecast/engine.py`).

The features are typed "Polygon" but carry MultiPolygon-depth coordinates
(ring lists nested one level deeper), so every feature is normalised to a
MultiPolygon before the dissolve. Administrative boundaries only: the outline
is drawn geography, the tonnage on it is still model output.
"""

from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.ops import unary_union

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "ml" / "data" / "real" / "kelurahan_dki_full_267.geojson"
OUTPUT = REPO_ROOT / "apps" / "api" / "data" / "assets" / "jakarta_kecamatan_outlines.json"

# Geojson sub_district names that do not slugify to the model slug as is.
# The SILIKA kecamatan list (and so the trained models) splits or joins these words
# differently from the boundary dataset.
NAME_TO_SLUG = {
    "KALIDERES": "kali_deres",
    "PAL MERAH": "palmerah",
    "PULOGADUNG": "pulo_gadung",
    "KRAMATJATI": "kramat_jati",
}
# Kepulauan Seribu has no trained kecamatan model (the twin draws 42 mainland
# kecamatan), so its two island sub_districts are left out on purpose.
EXCLUDED = {"KEPULAUAN SERIBU UTARA", "KEPULAUAN SERIBU SELATAN"}
# ~22 m at Jakarta's latitude; keeps every outline to a few hundred vertices.
SIMPLIFY_DEGREES = 0.0002
MAX_VERTICES = 400
DECIMALS = 5


def slug_for(sub_district: str) -> str | None:
    name = sub_district.strip().rstrip(".").strip().upper()
    if name in EXCLUDED:
        return None
    return NAME_TO_SLUG.get(name, name.lower().replace(" ", "_"))


def _polygons(geometry: dict) -> list[Polygon]:
    """Normalise a feature geometry (Polygon or MultiPolygon, any nesting) to polygons."""
    coords = geometry["coordinates"]
    # A Polygon's first ring is a list of [x, y]; one level deeper means MultiPolygon.
    depth, probe = 0, coords
    while isinstance(probe, list) and probe and isinstance(probe[0], list):
        depth, probe = depth + 1, probe[0]
    parts = coords if depth == 3 else [coords] if depth == 2 else []
    out = []
    for part in parts:
        polygon = Polygon(part[0], part[1:])
        out.append(polygon if polygon.is_valid else polygon.buffer(0))
    return out


def build() -> dict:
    features = json.loads(SOURCE.read_text(encoding="utf-8"))["features"]
    groups: dict[str, list[Polygon]] = {}
    for feature in features:
        slug = slug_for(feature["properties"]["sub_district"])
        if slug:
            groups.setdefault(slug, []).extend(_polygons(feature["geometry"]))

    outlines = {}
    for slug, polygons in sorted(groups.items()):
        merged = unary_union(polygons)
        parts = list(merged.geoms) if isinstance(merged, MultiPolygon) else [merged]
        largest = max(parts, key=lambda p: p.area)
        outer = Polygon(largest.exterior)
        tolerance = SIMPLIFY_DEGREES
        simple = outer.simplify(tolerance, preserve_topology=True)
        while len(simple.exterior.coords) > MAX_VERTICES:
            tolerance *= 1.5
            simple = outer.simplify(tolerance, preserve_topology=True)
        ring = [[round(x, DECIMALS), round(y, DECIMALS)] for x, y in mapping(simple)["coordinates"][0]]
        ring[-1] = ring[0]
        outlines[slug] = ring

    return {
        "source": "pararawendy/border-indonesia-geojson (2020), 267 DKI kelurahan dissolved by kecamatan",
        "classification": "REAL",
        "note": "Outer ring of each kecamatan's largest part, simplified; administrative boundary only.",
        "outlines": outlines,
    }


def main() -> None:
    payload = build()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    vertices = sum(len(r) for r in payload["outlines"].values())
    print(f"{len(payload['outlines'])} kecamatan, {vertices} vertices -> {OUTPUT}")


if __name__ == "__main__":
    main()
