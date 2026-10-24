"""Startup cache warm-up, run from the app lifespan before serving requests."""

from __future__ import annotations

import inspect
from typing import Any

from app.api.routers.fleet import command_center, fleet_map_truth
from app.api.routers.forecast import predictions_kecamatan
from app.api.routers.operations import get_tpa_queue_status
from app.api.routers.twin import twin_scene
from app.fleet.data import TRUCKS, _route_b_osrm
from app.fleet.map_truth import _snapped_for, build_map_truth


def warm_twin_scene() -> dict[str, Any]:
    """Build the scene a bare `/twin` load requests: default city, no rain, no
    event, today. Raises on failure; the startup caller logs it.

    Called as a plain function, an omitted argument would stay a FastAPI
    `Query(...)` marker instead of its value (the previous call left `venue`
    and `day` out and failed on every start). Every argument is therefore the
    route's own declared default, so the warm entry is exactly the one a
    request without a query string hits, even when the route gains parameters.
    """
    defaults = {
        name: getattr(param.default, "default", param.default)
        for name, param in inspect.signature(twin_scene).parameters.items()
    }
    return twin_scene(**defaults)


def warm_tpa_queue() -> None:
    """Fill the `/api/tpa/queue-status` cache under the keys the route reads
    ("live" and "peak"), through the route itself. Writing a bare `payload`
    key, as before, left the route's cache empty."""
    for scenario in ("live", "peak"):
        get_tpa_queue_status(scenario=scenario)


def _warm_route_cache() -> None:
    """Warm OSRM caches (A* edges + per-truck map-truth routes) in a background
    thread so the first live demo request is fast, never blocking on cold OSRM."""
    print("Warming predictions on main thread...")
    try:
        from app.fleet.data import build_predictions

        build_predictions()
        print("Predictions warmed successfully.")
    except Exception as e:
        print("Predictions warmup failed:", e)

    # Necessary: predictions warm the /api/predictions/kecamatan default cache
    # key (rainfall=0, no event, not weekend) so the first browser request never
    # pays a cold 42-model load. Must run on the MAIN thread: xgboost predict
    # spawns joblib workers, and Windows hangs when that happens from a daemon
    # thread (observed: warm loop stuck forever, spawning zombie processes).
    try:
        from app.forecast.engine import predict_waste_hybrid
        from app.forecast.real_data import load_kecamatan_map

        for k in load_kecamatan_map():
            predict_waste_hybrid(kelurahan=k["slug"], rainfall_mm=0.0, event_attendance=0, is_weekend=False)
        print("Kecamatan predictions warmed.")
    except Exception as e:
        print("Kecamatan predictions warmup failed:", e)

    try:
        from app.assistant.rag import build_rag_index

        build_rag_index()
        print("RAG index warmed.")
    except Exception as e:
        print("RAG warmup failed:", e)

    # Necessary: pre-builds the command-center snapshot (42-model predictions,
    # weather fetch, queue sim) so the first client request hits the 8s cache
    # instead of paying a ~10s cold build that trips the frontend's fetch cap
    # and empties the forecast weather strip (e2e layout timeouts).
    try:
        command_center()
        print("Command center cache warmed.")
    except Exception as e:
        print("Command center warmup failed:", e)

    # Necessary: pre-fills the keyed kecamatan predictions cache (the forecast
    # workspace's first request) and the TPA marker cache so e2e pages that
    # mount at t=0 of the suite never wait on a cold 42-model build.
    try:
        predictions_kecamatan(rainfall_mm=42, event_attendance=85000, is_weekend=True)
        print("Kecamatan endpoint cache warmed.")
    except Exception as e:
        print("Kecamatan endpoint warmup failed:", e)
    try:
        warm_tpa_queue()
        print("TPA cache warmed.")
    except Exception as e:
        print("TPA warmup failed:", e)
    # Necessary: the twin's default 7-day scene runs 2×42 Prophet series on a
    # cold start (~90 s); warming the shared Prophet cache here (main thread,
    # same xgboost constraint as above) keeps scenario changes at ~1 s.
    try:
        warm_twin_scene()
        print("Twin scene warmed.")
    except Exception as e:
        print("Twin scene warmup failed:", e)

    import threading

    from app.fleet.astar_routing import warm_edge_cache

    def _warm():
        warm_edge_cache()
        try:
            _route_b_osrm()
            print("Route B warm cache ready.")
        except Exception as e:
            print("Route B warmup failed:", e)
        from concurrent.futures import ThreadPoolExecutor

        try:
            with ThreadPoolExecutor(max_workers=8) as ex:
                list(ex.map(build_map_truth, TRUCKS))
            fleet_map_truth()  # fill the payload cache too, not just per-truck caches
            print("Map truth warm cache ready.")
        except Exception as e:
            print("Map truth warmup failed:", e)

    threading.Thread(target=_warm, daemon=True).start()

    # Necessary: keeps the 30s snap cache perpetually fresh so request threads
    # never pay a cold OSRM snap fetch (public OSRM is slow; 6 parallel
    # map-truth calls each took ~6s during the cold window, stalling the
    # threadpool and tripping the frontend's 6s fetch abort). Pure I/O, so it
    # is safe in a daemon thread (no joblib/xgboost involved).
    def _snap_refresher():
        import time as _time

        from app.fleet.data import ASSIGNED_PATHS as _CURATED

        curated_codes = list(_CURATED.keys())
        idx = 0
        while True:
            _time.sleep(15)
            try:
                truck = next(
                    (t for t in TRUCKS if t["truck_code"] == curated_codes[idx % len(curated_codes)]), None
                )
                if truck is not None:
                    _snapped_for(truck)
            except Exception:
                pass
            idx += 1

    threading.Thread(target=_snap_refresher, daemon=True).start()
