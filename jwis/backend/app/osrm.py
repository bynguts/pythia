from __future__ import annotations

import json
from math import asin, cos, radians, sin, sqrt
from typing import Any
from urllib.request import Request, urlopen


OSRM_BASE_URL = "https://router.project-osrm.org"


def build_osrm_url(origin: tuple[float, float], destination: tuple[float, float]) -> str:
    origin_lat, origin_lng = origin
    dest_lat, dest_lng = destination
    return (
        f"{OSRM_BASE_URL}/route/v1/driving/"
        f"{origin_lng},{origin_lat};{dest_lng},{dest_lat}"
        "?overview=full&geometries=geojson&alternatives=true&steps=false"
    )


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    radius = 6371
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    h = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * radius * asin(sqrt(h))


def parse_osrm_route(name: str, payload: dict[str, Any], index: int = 0) -> dict[str, Any]:
    route = payload["routes"][index]
    coordinates = route["geometry"]["coordinates"]
    return {
        "name": name,
        "source": "osrm",
        "eta_minutes": round(route["duration"] / 60),
        "distance_km": round(route["distance"] / 1000, 1),
        "path": [{"lng": lng, "lat": lat} for lng, lat in coordinates],
        "reason": "computed by OSRM public routing with full route geometry",
    }


def fallback_route(name: str, origin: tuple[float, float], destination: tuple[float, float]) -> dict[str, Any]:
    origin_lat, origin_lng = origin
    dest_lat, dest_lng = destination
    mid = {
        "lat": round((origin_lat + dest_lat) / 2 + 0.006, 6),
        "lng": round((origin_lng + dest_lng) / 2 + 0.01, 6),
    }
    distance_km = _haversine_km(origin, destination) * 1.35
    return {
        "name": name,
        "source": "fallback",
        "eta_minutes": max(8, round(distance_km / 22 * 60)),
        "distance_km": round(distance_km, 1),
        "path": [
            {"lat": origin_lat, "lng": origin_lng},
            mid,
            {"lat": dest_lat, "lng": dest_lng},
        ],
        "reason": "fallback route used when OSRM public service is unavailable",
    }


def fetch_osrm_route(
    name: str,
    origin: tuple[float, float],
    destination: tuple[float, float],
    timeout_seconds: float = 8.0,
) -> dict[str, Any]:
    url = build_osrm_url(origin, destination)
    try:
        request = Request(url, headers={"User-Agent": "JWIS-Competition-Prototype/1.0"})
        with urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("code") != "Ok" or not payload.get("routes"):
            raise ValueError(payload.get("message", "OSRM returned no route"))
        result = parse_osrm_route(name, payload)
        return {**result, "url": url}
    except Exception as error:
        return {**fallback_route(name, origin, destination), "url": url, "error": str(error)}
