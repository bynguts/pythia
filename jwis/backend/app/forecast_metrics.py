# -*- coding: utf-8 -*-
"""Forecasting evaluation metrics and honest per-resolution suitability contract.

Provides WAPE, MAE, MASE, and seasonal-naive baselines so Case 2 forecast
claims are benchmarked against naive baselines rather than presented in a
vacuum. suitability_labels() encodes which resolutions JWIS may claim as
reliable — daily-district is explicitly NOT supported because that target is
calibrated-synthetic.
"""
from __future__ import annotations

from collections.abc import Sequence


def mae(actual: Sequence[float], predicted: Sequence[float]) -> float:
    n = len(actual)
    if n == 0:
        return 0.0
    return sum(abs(a - p) for a, p in zip(actual, predicted)) / n


def wape(actual: Sequence[float], predicted: Sequence[float]) -> float:
    """Weighted Absolute Percentage Error = sum|error| / sum|actual|."""
    denom = sum(abs(a) for a in actual)
    if denom == 0:
        return 0.0
    return sum(abs(a - p) for a, p in zip(actual, predicted)) / denom


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


def suitability_labels() -> dict[str, str]:
    """Which forecast resolutions JWIS may present as reliable.

    Grounded in the multi-resolution evaluation (#18): 'reliable' is only
    claimed where OBSERVED holdout evidence exists at that resolution.
    Weekly/monthly per-district metrics are evaluated against the
    calibrated-synthetic district series (avg daily-district R² -0.033),
    so they are labeled synthetic-validated, not reliable.
    """
    return {
        "hotspot_rank": "high",
        "city_day": "reliable",
        "district_month": "synthetic_validated",
        "district_week": "synthetic_validated",
        "district_day": "not_supported",
    }


def suitability_details() -> dict[str, dict]:
    """Per-resolution validation evidence backing the labels (#18).

    validation_target is 'observed' (real holdout data at that
    resolution) or 'synthetic' (calibrated-synthetic series). 'reliable'
    in suitability_labels() requires an observed target here.
    """
    return {
        "hotspot_rank": {
            "validation_target": "observed",
            "sample": "42 kecamatan, SILIKA 2023 spatial baseline",
            "period": "2023",
            "baseline": "Spearman rank vs per-kecamatan tonnage (rho 0.998)",
        },
        "city_day": {
            "validation_target": "observed",
            "sample": "DKI daily series anchored to SIPSN city timbulan",
            "period": "2021-2025",
            "baseline": "SIPSN yearly per-city timbulan (real)",
        },
        "district_week": {
            "validation_target": "synthetic",
            "sample": "42 kecamatan calibrated-synthetic daily series",
            "period": "2016-2026 held-out 20%",
            "baseline": "SILIKA 2023 baseline with ~8% noise; not observed ground truth",
        },
        "district_month": {
            "validation_target": "synthetic",
            "sample": "42 kecamatan calibrated-synthetic daily series",
            "period": "2016-2026 held-out 20%",
            "baseline": "SILIKA 2023 baseline with ~8% noise; not observed ground truth",
        },
        "district_day": {
            "validation_target": "synthetic",
            "sample": "42 kecamatan calibrated-synthetic daily series (noise-dominated)",
            "period": "2016-2026 held-out 20%",
            "baseline": "avg per-district daily R² -0.033 vs naive",
        },
    }
