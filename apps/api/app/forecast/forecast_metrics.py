"""Forecasting evaluation metrics and honest per-resolution suitability contract.

Provides WAPE, MAE, MASE, and seasonal-naive baselines so Case 2 forecast
claims are benchmarked against naive baselines rather than presented in a
vacuum. suitability_labels() encodes what Pythia may claim per resolution:
only the monthly landfill/city intake forecast is backtested on REAL data
(its numbers are read from the training artifact, never hardcoded here);
every daily or per-district resolution is calibrated-synthetic and carries
no accuracy claim. suitability_details() also reports the TPA queue's daily
gate-arrival input, backtested on the real Bantargebang trips (read from the
queue calibration artifact); the simulated queue waits are not validated.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from app.core import paths


def _check_same_length(actual: Sequence[float], predicted: Sequence[float]) -> None:
    if len(actual) != len(predicted):
        raise ValueError(
            f"actual and predicted must have the same length ({len(actual)} != {len(predicted)})"
        )


def mae(actual: Sequence[float], predicted: Sequence[float]) -> float:
    _check_same_length(actual, predicted)
    n = len(actual)
    if n == 0:
        return 0.0
    return sum(abs(a - p) for a, p in zip(actual, predicted, strict=True)) / n


def wape(actual: Sequence[float], predicted: Sequence[float]) -> float:
    """Weighted Absolute Percentage Error = sum|error| / sum|actual|."""
    _check_same_length(actual, predicted)
    denom = sum(abs(a) for a in actual)
    if denom == 0:
        return 0.0
    return sum(abs(a - p) for a, p in zip(actual, predicted, strict=True)) / denom


def seasonal_naive_forecast(series: Sequence[float], seasonal_period: int = 7) -> list[float]:
    """Predict each point from the value one season earlier; warm-up uses first value."""
    out: list[float] = []
    for i in range(len(series)):
        if i < seasonal_period:
            out.append(series[0])
        else:
            out.append(series[i - seasonal_period])
    return out


def mase(actual: Sequence[float], predicted: Sequence[float], seasonal_period: int = 1) -> float:
    """Mean Absolute Scaled Error: model MAE / seasonal-naive MAE on the actuals.

    < 1 means the model beats the seasonal-naive baseline; >= 1 means it does not.
    """
    n = len(actual)
    if n <= seasonal_period:
        return float("inf")
    naive_errors = [abs(actual[i] - actual[i - seasonal_period]) for i in range(seasonal_period, n)]
    scale = sum(naive_errors) / len(naive_errors) if naive_errors else 0.0
    if scale == 0:
        return 0.0
    return mae(actual, predicted) / scale


# Resolutions backtested on a real target; their evidence comes from the artifact.
REAL_BACKTEST_RESOLUTIONS = ("landfill_month", "city_month")

_BACKTEST_FIELDS = (
    "target",
    "target_class",
    "unit",
    "period",
    "model",
    "strongest_naive",
    "origins",
    "first_origin",
    "last_origin",
    "horizons_months",
    "n_forecasts",
    "n_target_months",
    "mae_model",
    "mae_naive",
    "mape_model_pct",
    "mape_naive_pct",
    "skill_pct",
    "skill_ci90_pct",
    "ci_method",
    "calendar_months",
    "normal_months",
)


def load_forecast_evaluation() -> dict[str, Any] | None:
    """forecast_evaluation.json written by ml/scripts/train_models.py, or None if absent."""
    path = paths.FORECAST_EVALUATION
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        logging.getLogger(__name__).exception("forecast evaluation artifact failed to load")
        return None


def load_queue_calibration() -> dict[str, Any] | None:
    """queue_calibration.json written by ml/scripts/calibrate_queue.py, or None if absent."""
    path = paths.QUEUE_CALIBRATION
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        logging.getLogger(__name__).exception("queue calibration artifact failed to load")
        return None


def monthly_backtest_metrics() -> dict[str, dict[str, Any]]:
    """Real-data rolling-origin backtest per resolution, read from the artifact.

    Each entry: model vs the strongest naive baseline (MAE, MAPE), skill with its
    90% cluster-bootstrap interval, origin count and period. Empty when the
    artifact is missing, so the API then claims nothing.
    """
    evaluation = load_forecast_evaluation()
    if not evaluation:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for key in REAL_BACKTEST_RESOLUTIONS:
        res = evaluation.get("resolutions", {}).get(key)
        if res:
            out[key] = {k: res[k] for k in _BACKTEST_FIELDS if k in res}
    return out


def beats_naive(metrics: dict[str, Any]) -> bool:
    """Skill counts only when the whole 90% interval is above zero."""
    ci = metrics.get("skill_ci90_pct") or [0, 0]
    return metrics.get("skill_pct", 0) > 0 and ci[0] > 0


def suitability_labels() -> dict[str, str]:
    """What Pythia may claim per forecast resolution.

    'backtested_real' requires a rolling-origin backtest on a real target whose
    skill interval against the strongest naive baseline is above zero (read from
    the artifact; 'not_evaluated' otherwise). City-day and every per-district
    resolution are sums or slices of the calibrated-synthetic series:
    'synthetic_validated' at most, never 'reliable'. Hotspot ranking reproduces
    its own SILIKA input ranking, so it is not evidence of skill.
    """
    backtest = monthly_backtest_metrics()
    labels = {
        key: "backtested_real" if key in backtest and beats_naive(backtest[key]) else "not_evaluated"
        for key in REAL_BACKTEST_RESOLUTIONS
    }
    labels.update(
        {
            "hotspot_rank": "reproduces_input",
            "city_day": "synthetic_validated",
            "district_month": "synthetic_validated",
            "district_week": "synthetic_validated",
            "district_day": "not_supported",
        }
    )
    return labels


_SYNTHETIC_SAMPLE = "42 kecamatan calibrated-synthetic daily series"
_SYNTHETIC_BASELINE = "SILIKA 2023 baseline x growth x month index with ~5% noise; not observed ground truth"


def suitability_details() -> dict[str, dict]:
    """Per-resolution validation evidence backing the labels.

    validation_target is 'real' (rolling-origin backtest on a real series) or
    'synthetic' (calibrated-synthetic series). evidence_of_skill is True only
    for a real-target backtest whose 90% skill interval is above zero.
    """
    backtest = monthly_backtest_metrics()
    details: dict[str, dict] = {}
    for key in REAL_BACKTEST_RESOLUTIONS:
        m = backtest.get(key)
        if m is None:
            details[key] = {
                "validation_target": "real",
                "sample": "Bantargebang monthly intake (evaluation artifact missing)",
                "period": "unavailable",
                "baseline": "unavailable",
                "evidence_of_skill": False,
            }
            continue
        details[key] = {
            "validation_target": "real",
            "sample": f"{m['target']}; {m['origins']} rolling origins, {m['n_forecasts']} forecasts",
            "period": m["period"],
            "baseline": f"{m['strongest_naive']} (strongest naive baseline)",
            "evidence_of_skill": beats_naive(m),
            "metrics": m,
        }
    details["tpa_gate_arrivals_day"] = _gate_arrivals_detail()
    details.update(
        {
            "hotspot_rank": {
                "validation_target": "synthetic",
                "sample": "42 kecamatan, means of the calibrated-synthetic series",
                "period": "2023 baseline",
                "baseline": (
                    "Spearman 0.998 (earlier report) against the SILIKA 2023 (modelled) input ranking; "
                    "the series are built from that ranking, so the score is circular and not "
                    "evidence of skill"
                ),
                "evidence_of_skill": False,
            },
            "city_day": {
                "validation_target": "synthetic",
                "sample": "sum of the calibrated-synthetic kecamatan series per city",
                "period": "2021-2026",
                "baseline": "no observed daily city series exists in the data; not observed ground truth",
                "evidence_of_skill": False,
            },
            "district_week": {
                "validation_target": "synthetic",
                "sample": _SYNTHETIC_SAMPLE,
                "period": "2021-2026 held-out 20%",
                "baseline": _SYNTHETIC_BASELINE,
                "evidence_of_skill": False,
            },
            "district_month": {
                "validation_target": "synthetic",
                "sample": _SYNTHETIC_SAMPLE,
                "period": "2021-2026 held-out 20%",
                "baseline": _SYNTHETIC_BASELINE,
                "evidence_of_skill": False,
            },
            "district_day": {
                "validation_target": "synthetic",
                "sample": f"{_SYNTHETIC_SAMPLE} (noise-dominated)",
                "period": "2021-2026 held-out 20%",
                "baseline": "noise-dominated synthetic target; no accuracy claim",
                "evidence_of_skill": False,
            },
        }
    )
    return details


def _gate_arrivals_detail() -> dict[str, Any]:
    """The TPA queue's daily gate-arrival input, backtested on the real Bantargebang trips.

    The runtime estimator (median trips/day of the latest 12 months) against the
    last-month naive, one month ahead; read from the calibration artifact. The
    simulated weighbridge waits themselves are not validated by any observed data.
    """
    calibration = load_queue_calibration()
    if calibration is None:
        return {
            "validation_target": "real",
            "sample": "Bantargebang monthly trips (queue calibration artifact missing)",
            "period": "unavailable",
            "baseline": "unavailable",
            "evidence_of_skill": False,
            "wait_validation": "not_observed",
        }
    m = calibration["backtest"]
    return {
        "validation_target": "real",
        "sample": (
            f"{m['target']}; {m['origins']} rolling origins, {m['horizon_months']}-month-ahead forecasts"
        ),
        "period": m["period"],
        "baseline": f"{m['naive']} (last-month naive)",
        "evidence_of_skill": beats_naive(m),
        "metrics": m,
        "wait_validation": calibration["wait_validation"],
    }
