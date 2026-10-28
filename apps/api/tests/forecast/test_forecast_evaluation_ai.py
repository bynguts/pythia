"""The out-of-sample monthly check of the daily Prophet + XGBoost hybrid
(ml/scripts/backtest_ai_monthly.py -> forecast_evaluation_ai.json)."""

from __future__ import annotations

import json

import pytest

from app.core import paths

AI_EVALUATION = paths.MODELS_DIR / "forecast_evaluation_ai.json"
VARIANTS = ("prophet_xgb_raw", "prophet_xgb_rescaled")


@pytest.fixture(scope="module")
def ai():
    return json.loads(AI_EVALUATION.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def landfill():
    return json.loads(paths.FORECAST_EVALUATION.read_text(encoding="utf-8"))["resolutions"]["landfill_month"]


def test_ai_evaluation_shape(ai):
    assert ai["schema"] == "pythia.forecast_evaluation_ai/1"
    assert ai["generated_by"] == "ml/scripts/backtest_ai_monthly.py"
    assert ai["target_class"] == "real"
    assert ai["leakage_controls"]
    assert set(ai["variants"]) == set(VARIANTS)
    for name in VARIANTS:
        v = ai["variants"][name]
        assert v["model"] == name
        naive_maes = [m["mae"] for m in v["models"] if m["kind"] == "naive"]
        assert v["mae_naive"] == min(naive_maes)  # scored against the STRONGEST naive
        assert v["n_forecasts"] == sum(b["n_forecasts"] for b in v["by_horizon"])
        assert v["n_forecasts"] == v["calendar_months"]["n_forecasts"] + v["normal_months"]["n_forecasts"]
        lo, hi = v["skill_ci90_pct"]
        assert lo <= v["skill_pct"] <= hi
        kinds = {m["name"]: m["kind"] for m in v["models"]}
        assert kinds[name] == "model" and kinds["ma12_calendar"] == "reference_model"


def test_ai_check_uses_the_same_forecasts_as_the_landfill_backtest(ai, landfill):
    """Same origins, horizons, target months and naive baseline as forecast_evaluation.json."""
    for name in VARIANTS:
        v = ai["variants"][name]
        for field in (
            "origins",
            "first_origin",
            "last_origin",
            "horizons_months",
            "n_forecasts",
            "n_target_months",
            "strongest_naive",
            "mae_naive",
            "mape_naive_pct",
        ):
            assert v[field] == landfill[field], (name, field)
    ref = ai["reference_model"]
    assert ref["name"] == landfill["model"]
    assert ref["mape_pct"] == landfill["mape_model_pct"]
    assert ref["mae"] == landfill["mae_model"]


def test_ai_headline_numbers_follow_from_the_stored_forecasts(ai):
    """The 1-month-ahead rows in the file reproduce the h=1 errors stored next to them."""
    for name in VARIANTS:
        v = ai["variants"][name]
        rows = v["one_month_ahead"]
        h1 = next(b for b in v["by_horizon"] if b["h"] == 1)
        assert len(rows) == h1["n_forecasts"]
        mae_model = sum(abs(r["model"] - r["actual"]) for r in rows) / len(rows)
        mae_naive = sum(abs(r["naive"] - r["actual"]) for r in rows) / len(rows)
        assert mae_model == pytest.approx(h1["mae_model"], abs=0.2)
        assert mae_naive == pytest.approx(h1["mae_naive"], abs=0.2)
        assert v["skill_pct"] == pytest.approx(100 * (1 - v["mae_model"] / v["mae_naive"]), abs=0.1)
