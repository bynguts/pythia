"""Process-wide singletons and TTL caches shared by the routers and the warm-up.

Each object is created exactly once, here; every other module imports it.
"""

from __future__ import annotations

import threading
from typing import Any

from app.ai.actions.auto_reroute import AutoRerouter
from app.ai.actions.auto_state import EVENT_FEED
from app.ai.detectors.deviation_trigger import DeviationTrigger
from app.ai.detectors.speed_anomaly import SpeedAnomalyDetector
from app.ai.detectors.stop_pattern import StopPatternDetector
from app.ai.forecasters.event_impact import EventImpactForecaster
from app.ai.forecasters.fuel_model import CarbonCalculator
from app.ai.forecasters.queue_predictor import TpaQueuePredictor
from app.core.storage import HistoryStore, RecordStore
from app.fleet.operations_plans import OperationsPlanStore
from app.forecast.engine import DispatchCenter

history_store = HistoryStore()
dispatch_center = DispatchCenter()
# #36: handle on the AI engine so /api/health can report configured vs
# running state instead of silently serving empty /api/ai/*.
_AI_ENGINE_STATE: dict[str, bool] = {"running": False}

_kecamatan_cache: dict[str, Any] = {"key": None, "ts": 0.0, "payload": None}

# Necessary: the snapshot costs ~3.2s (42 models + per-truck OSRM reroutes), so
# parallel dashboard clients (e.g. the 4 Playwright workers) would each recompute
# it and stall. An 8s TTL shares one computation while keeping truck motion live
# (position liveness comes from /api/map-truth and the feed, not this snapshot).
_command_center_lock = threading.Lock()
_command_center_cache: dict[str, Any] = {"ts": 0.0, "payload": None}

# ── Integrated Operations Optimizer (Case 2 -> Case 1 bridge) ────────
_OPERATIONS_PLAN_STORE = OperationsPlanStore()

# Necessary: the TPA payload is deterministic per 5s; caching it keeps the
# map marker render (one-shot, no retry) from vanishing on a slow first fetch.
_tpa_cache: dict[str, Any] = {}

# Necessary: each build_map_truth costs 1-4.5s (per-truck snap + T-047 reroute
# hit OSRM). With 4 Playwright workers polling every 8s, uncached recomputes
# overlapped and the frontend's fetch-settle checks timed out. A 4s TTL shares
# one recompute across all clients while GPS freshness stays within 4s.
_map_truth_lock = threading.Lock()
_map_truth_cache: dict[str, Any] = {"ts": 0.0, "payload": None}

# ── AI ENGINE (production AI-first) ──────────────────────────────────────────
_ai_detector = SpeedAnomalyDetector()
_ai_rerouter = AutoRerouter(detector=_ai_detector, feed=EVENT_FEED)
_ai_queue = TpaQueuePredictor()
_ai_deviation = DeviationTrigger(feed=EVENT_FEED)
_ai_stop = StopPatternDetector()
_ai_carbon = CarbonCalculator()
_ai_forecast = EventImpactForecaster(feed=EVENT_FEED)

# ── Scentinel sensor-placement evidence (#23) ────────────────────────────────
SCENTINEL_STORE = RecordStore("scentinel_evidence")

# Fleet-wide scoring walks every SPJ/pretrip/damage record per driver, so a
# 60s TTL shares one computation across dashboard clients.
_compliance_lock = threading.Lock()
_compliance_cache: dict[str, Any] = {"ts": 0.0, "payload": None}

# gsc P2 shared tabletop: in-memory /api/xr/session/{code} scenario state.
_xr_sessions_lock = threading.Lock()
_xr_sessions: dict[str, dict[str, Any]] = {}


def _refresh_fleet_caches() -> None:
    from app.fleet.data import _fleet_cache
    from app.fleet.fleet_generator import _gen_cache

    _fleet_cache["ts"] = 0.0
    _gen_cache["ts"] = 0.0
    _map_truth_cache["ts"] = 0.0
