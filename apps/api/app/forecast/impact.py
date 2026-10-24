"""Reproducible impact evaluation harness for Pythia.

Every KPI is derived from an actual engine (queue simulation, route geometry,
forecast) or explicitly labeled reference/modeled — never presented as observed
field impact. Replaces hardcoded 58.6% / fixed carbon / tree-equivalent claims.
"""

from __future__ import annotations

from typing import Any

from app.fleet.queue_simulation import queue_minutes_per_truck
from app.forecast.forecast_metrics import monthly_backtest_metrics


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


def _monthly_forecast_error() -> list[dict[str, Any]]:
    """Monthly landfill-intake forecast error vs the strongest naive, from the real backtest.

    Replaces the old hotspot-rank Spearman, which only reproduced its own SILIKA input.
    Omitted when the evaluation artifact is missing.
    """
    m = monthly_backtest_metrics().get("landfill_month")
    if not m:
        return []
    lo, hi = m["skill_ci90_pct"]
    return [
        {
            "name": "forecast_monthly_intake_mae",
            "unit": "tons_per_day",
            "baseline": m["mae_naive"],
            "pythia": m["mae_model"],
            "delta": m["skill_pct"],
            "source": (
                f"Rolling-origin backtest on real Bantargebang intake, {m['origins']} origins, "
                f"{m['horizons_months'][0]}-{m['horizons_months'][-1]} months ahead, vs {m['strongest_naive']} "
                f"(strongest naive); 90% interval of the gain {lo:+.1f}% to {hi:+.1f}%"
            ),
            "classification": "modeled",
        }
    ]


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
        *_monthly_forecast_error(),
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
