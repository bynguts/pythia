# -*- coding: utf-8 -*-
"""
astar_routing.py - Custom A* Pathfinding Engine with Dynamic Traffic Weight.
Designed for JWIS truck routing under permit-corridor constraint.
When a road segment becomes congested, A* recomputes an alternative route
automatically (Google-Maps-style live rerouting for waste trucks).
"""
from __future__ import annotations

import heapq
from math import asin, cos, radians, sin, sqrt
from typing import Any

# Simplified Jakarta -> Bantargebang road network for real-time truck logistics.
# Each node is an actual intersection / checkpoint (lat, lng, label).
NODES = {
    "ORIGIN": (-6.221, 106.785, "Posisi Truk T-047 (Arteri Barat)"),
    "KEBON_JERUK": (-6.181, 106.764, "Simpang Susun Kebon Jeruk"),
    "SLIPI": (-6.198, 106.797, "Flyover Slipi"),
    "TOMANG": (-6.179, 106.788, "Gerbang Tol Tomang"),
    "SEMANGGI": (-6.219, 106.812, "Simpang Susun Semanggi"),
    "ANCOL": (-6.126, 106.843, "Tol Ancol Pelabuhan"),
    "CAWANG": (-6.244, 106.872, "Simpang Cawang / Tol Dalam Kota"),
    "BEKASI_BARAT": (-6.241, 106.994, "Gerbang Tol Bekasi Barat"),
    "BEKASI_TIMUR": (-6.258, 107.017, "Gerbang Tol Bekasi Timur"),
    "TPA_BANTARGEBANG": (-6.331, 106.991, "Jembatan Timbang TPA Bantargebang"),
}

# Standard connections with base distances in kilometers.
EDGES = [
    ("ORIGIN", "KEBON_JERUK", 4.5),
    ("ORIGIN", "SLIPI", 3.2),
    ("KEBON_JERUK", "TOMANG", 2.8),
    ("SLIPI", "TOMANG", 2.1),
    ("SLIPI", "SEMANGGI", 2.8),
    ("TOMANG", "ANCOL", 8.4),
    ("SEMANGGI", "CAWANG", 7.1),
    ("ANCOL", "CAWANG", 14.5),
    ("CAWANG", "BEKASI_BARAT", 13.8),
    ("BEKASI_BARAT", "BEKASI_TIMUR", 3.2),
    ("BEKASI_BARAT", "TPA_BANTARGEBANG", 10.2),
    ("BEKASI_TIMUR", "TPA_BANTARGEBANG", 8.5),
    # Coastal toll bypass via Tanjung Priok (used when CAWANG is gridlocked)
    ("ANCOL", "BEKASI_BARAT", 22.0),
]


def haversine_distance(coord1, coord2):
    R = 6371.0  # Earth radius in km
    lat1, lon1 = radians(coord1[0]), radians(coord1[1])
    lat2, lon2 = radians(coord2[0]), radians(coord2[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * R * asin(sqrt(a))


def build_detailed_path(node_sequence):
    """Subdivide each segment into steps so MapLibre renders smooth polylines."""
    path_coords = []
    for i in range(len(node_sequence) - 1):
        n1, n2 = node_sequence[i], node_sequence[i + 1]
        lat1, lng1 = NODES[n1][0], NODES[n1][1]
        lat2, lng2 = NODES[n2][0], NODES[n2][1]
        steps = 8
        for j in range(steps):
            t = j / steps
            path_coords.append({
                "lat": round(lat1 + (lat2 - lat1) * t, 6),
                "lng": round(lng1 + (lng2 - lng1) * t, 6),
            })
    last_node = node_sequence[-1]
    path_coords.append({"lat": NODES[last_node][0], "lng": NODES[last_node][1]})
    return path_coords


def find_astar_route(start="ORIGIN", goal="TPA_BANTARGEBANG", congested_edges=None):
    """A* shortest path. Congested edges carry a x5 traffic penalty."""
    if congested_edges is None:
        congested_edges = []

    congested_set = set()
    for u, v in congested_edges:
        congested_set.add((u, v))
        congested_set.add((v, u))  # undirected

    def heuristic(node):
        return haversine_distance(
            (NODES[node][0], NODES[node][1]),
            (NODES[goal][0], NODES[goal][1]),
        )

    adj = {n: [] for n in NODES}
    for u, v, d in EDGES:
        adj[u].append((v, d))
        adj[v].append((u, d))

    pq = []
    heapq.heappush(pq, (heuristic(start), 0.0, start, [start]))
    visited = {}

    while pq:
        f, g, u, path = heapq.heappop(pq)

        if u == goal:
            detailed = build_detailed_path(path)
            return {
                "success": True,
                "sequence": path,
                "sequence_labels": [NODES[n][2] for n in path],
                "path": detailed,
                "distance_km": round(g, 1),
                "eta_minutes": max(15, round((g / 45) * 60)),  # avg 45 km/h for trucks
                "is_diverted": len(congested_edges) > 0,
            }

        if u in visited and visited[u] <= g:
            continue
        visited[u] = g

        for v, dist in adj[u]:
            multiplier = 5.0 if (u, v) in congested_set else 1.0
            weight = dist * multiplier
            g_new = g + weight
            f_new = g_new + heuristic(v)
            if v not in visited or visited[v] > g_new:
                heapq.heappush(pq, (f_new, g_new, v, path + [v]))

    return {"success": False, "message": "No route found."}


# Default congestion scenario for the demo: the Cawang -> Bekasi Barat inner-city
# toll segment is gridlocked, forcing a divert via the Ancol coastal toll.
DEMO_CONGESTED_EDGES = [("CAWANG", "BEKASI_BARAT")]


def reroute_payload(jam_active: bool):
    """Return both the normal and (if jammed) the A*-diverted route for the frontend."""
    normal = find_astar_route(congested_edges=[])
    if not jam_active:
        return {
            "jam_active": False,
            "active_route": normal,
            "abandoned_route": None,
            "congestion_points": [],
            "message": "Lalu lintas normal. Truk mengikuti rute terpendek ke TPA Bantargebang.",
        }

    diverted = find_astar_route(congested_edges=DEMO_CONGESTED_EDGES)
    # congestion marker = midpoint of the jammed edge
    jam_points = []
    for u, v in DEMO_CONGESTED_EDGES:
        jam_points.append({
            "lat": round((NODES[u][0] + NODES[v][0]) / 2, 6),
            "lng": round((NODES[u][1] + NODES[v][1]) / 2, 6),
            "label": f"Macet total: {NODES[u][2]} -> {NODES[v][2]}",
        })
    extra_km = round(diverted["distance_km"] - normal["distance_km"], 1)
    return {
        "jam_active": True,
        "active_route": diverted,
        "abandoned_route": normal,
        "congestion_points": jam_points,
        "message": (
            f"Kemacetan terdeteksi di koridor Cawang. A* otomatis membelokkan truk "
            f"via {' -> '.join(NODES[n][2] for n in diverted['sequence'][1:-1])}. "
            f"Jarak +{extra_km} km, namun menghindari gridlock total."
        ),
    }


if __name__ == "__main__":
    import json
    print("=== NORMAL ===")
    print(json.dumps(reroute_payload(False)["active_route"]["sequence"], indent=2))
    print("=== JAM ACTIVE ===")
    r = reroute_payload(True)
    print("Active:", r["active_route"]["sequence"])
    print("Abandoned:", r["abandoned_route"]["sequence"])
    print("Msg:", r["message"])
