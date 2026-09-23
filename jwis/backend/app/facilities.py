"""SPJ destination facilities: authoritative coordinates, with provenance.

These coordinates are the final vertex of every active SPJ polyline, and that
polyline is the reference path the 500 m deviation detector scores trucks
against. A placeholder value therefore does not merely mis-draw a line: it
becomes operational compliance ground truth.

Two rules follow, and both are enforced here rather than documented away:

1. A coordinate is only usable as ground truth when it is backed by a named,
   dated source (`verification_status == "verified"`);
2. A destination with no verified coordinate is explicitly marked as such, so
   the API reports "no verified destination coordinate" instead of quietly
   routing trucks to a guessed point.

`route_ground_truth()` is the only accessor that returns coordinates for
routing, and it returns None for unverified destinations.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

DESTINATIONS = ("TPST Bantargebang", "JRC Pesanggrahan", "RDF Plant Jakarta")

RETRIEVED = "2026-09-24"
OSM_ODbL = "OpenStreetMap (ODbL) via Overpass API"


@dataclass(frozen=True)
class DestinationFacility:
    name: str
    lat: float | None
    lng: float | None
    verification_status: str  # verified | unverified
    source_name: str
    source_url: str
    source_record_id: str
    as_of: str
    note: str

    @property
    def is_ground_truth(self) -> bool:
        return (self.verification_status == "verified"
                and self.lat is not None and self.lng is not None)

    def payload(self) -> dict:
        return {**asdict(self), "usable_for_routing": self.is_ground_truth}


FACILITIES: dict[str, DestinationFacility] = {
    "TPST Bantargebang": DestinationFacility(
        name="TPST Bantargebang",
        lat=-6.3495367,
        lng=106.9981295,
        verification_status="verified",
        source_name=OSM_ODbL,
        source_url="https://www.openstreetmap.org/way/463512088",
        source_record_id="way/463512088",
        as_of="2026-09-23",
        note=("Landfill polygon centroid (landuse=landfill, name='TPA Bantar Gebang'). "
              "The A* road node 'TPA_BANTARGEBANG' (-6.331, 106.991) is the weighbridge "
              "approach on the toll network and sits ~2.2 km outside the facility "
              "footprint; it stays in the routing graph but is not the destination."),
    ),
    "JRC Pesanggrahan": DestinationFacility(
        name="JRC Pesanggrahan",
        lat=None,
        lng=None,
        verification_status="unverified",
        source_name="Dinas LH DKI Jakarta (UPST) — program page, no published coordinate",
        source_url="https://upstdlh.id/jrc/index",
        source_record_id="SK Kadis LH DKI No. 375/2019 (TPS 3R Pesanggrahan)",
        as_of=RETRIEVED,
        note=("JRC is the Jakarta Recycle Center programme; its processing site is TPS 3R "
              "Pesanggrahan on Jl. Bintaro Puspita Raya. Neither OSM, the DLH/Jakarta Satu "
              "ArcGIS layers, SILIKA, nor the project datasets publish a coordinate for that "
              "plant, so no coordinate is claimed here. The nearest documented points on that "
              "street are TPS RW 008 Pesanggrahan (-6.26512321, 106.7562971, DLH ArcGIS) and "
              "a door-to-door TPS at (-6.265, 106.7544444, SILIKA) — both are collection "
              "points, not the JRC plant, and must not be used as a routing destination."),
    ),
    "RDF Plant Jakarta": DestinationFacility(
        name="RDF Plant Jakarta",
        lat=-6.1474762,
        lng=106.9682646,
        verification_status="verified",
        source_name=OSM_ODbL,
        source_url="https://www.openstreetmap.org/way/1339442985",
        source_record_id="way/1339442985",
        as_of="2026-09-23",
        note=("Centroid of the Rorotan plant polygon (name='RDF Jakarta', "
              "alt_name='RDF Rorotan', landuse=industrial, utility=waste), matching the "
              "DLH groundbreaking location in Kelurahan Rorotan, Kec. Cilincing. "
              "Distinct from 'RDF Plant Bantargebang' (way/568896948), which is inside the "
              "Bantargebang complex ~23 km away."),
    ),
}

# Necessary: the previous table carried a bare tuple per destination with the
# JRC/RDF entries explicitly labelled "approximate, non-official placeholders".
# Those two values were ~1.1 km and ~9.3 km from the documented facilities and
# still steered deviation scoring, so they are replaced by sourced coordinates
# or by an explicit "unverified" state.
LEGACY_PLACEHOLDER_COORDS: dict[str, tuple[float, float]] = {
    "TPST Bantargebang": (-6.331, 106.991),
    "JRC Pesanggrahan": (-6.2594, 106.7640),
    "RDF Plant Jakarta": (-6.1340, 106.8850),
}


def facility_for(destination: str) -> DestinationFacility | None:
    return FACILITIES.get(destination)


def route_ground_truth(destination: str) -> tuple[float, float] | None:
    """Coordinates safe to use for routing, or None when unverified."""
    facility = FACILITIES.get(destination)
    if facility is None or not facility.is_ground_truth:
        return None
    return (float(facility.lat), float(facility.lng))


def provenance_payload(destination: str) -> dict:
    facility = FACILITIES.get(destination)
    if facility is None:
        return {"destination": destination, "verification_status": "unknown",
                "usable_for_routing": False,
                "note": "destination is not a registered disposal facility"}
    return facility.payload()
