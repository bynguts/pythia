"""Reproducible impact evaluation harness for Pythia.

Every KPI is derived from an actual engine (queue simulation, route geometry,
forecast) or explicitly labeled reference/modeled — never presented as observed
field impact. Replaces hardcoded 58.6% / fixed carbon / tree-equivalent claims.
"""

from __future__ import annotations

from typing import Any

from app.fleet.queue_simulation import queue_minutes_per_truck


def _tpa_wait_reduction() -> dict[str, Any]:
    """Unstaggered vs staggered dispatch, read from the one TPA queue metric."""
    metric = queue_minutes_per_truck() or {"baseline_mean": 0.0, "staggered_mean": 0.0, "source": ""}
    b, s = metric["baseline_mean"], metric["staggered_mean"]
    reduction = round(((b - s) / b) * 100, 1) if b > 0 else 0.0
    return {
        "name": "tpa_wait_reduction",
        "unit": "percent",
        "baseline": b,
        "pythia": s,
        "delta": reduction,
        "source": f"TPA queue metric (minutes per truck). {metric['source']}",
        "classification": "simulated",
    }


def build_impact_report() -> dict[str, Any]:
    """Assemble reproducible impact metrics with per-metric provenance."""
    metrics: list[dict[str, Any]] = [
        _tpa_wait_reduction(),
        {
            "name": "route_deviation_detection",
            "unit": "meters",
            "baseline": "waypoint-only (false positives)",
            "pythia": "point-to-polyline",
            "source": "engine.distance_point_to_polyline_m + test_engine geometry suite",
            "classification": "derived",
        },
        {
            "name": "forecast_hotspot_rank",
            "unit": "spearman_rho",
            "baseline": 0.0,
            "pythia": 0.998,
            "source": "hybrid_forecaster_evaluation.md multi-resolution",
            "classification": "modeled",
        },
        {
            "name": "fuel_per_ton",
            "unit": "liters_per_ton",
            "baseline": 1.8,
            "pythia": 1.8,
            "source": "engine constant (1.8 L/ton) — reference factor, not measured savings",
            "classification": "reference",
        },
    ]
    return {
        "metrics": metrics,
        "note": "All values are simulated/derived/modeled/reference. None represent "
        "observed field impact; a live pilot is required for observed metrics.",
    }
