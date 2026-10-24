"""Monthly landfill-intake forecaster: source cleaning, real-data backtest artifact,
the serving function and train/serve feature parity."""

from __future__ import annotations

import importlib.util
import json

import numpy as np
import pandas as pd
import pytest

from app.core import paths
from app.forecast import engine, forecast_metrics

SCRIPT = paths.REPO_ROOT / "ml" / "scripts" / "train_models.py"


@pytest.fixture(scope="module")
def tm():
    spec = importlib.util.spec_from_file_location("train_models", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def monthly(tm):
    return tm.load_bantargebang_monthly()


def _eid_dates(tm) -> list[str]:
    return [r["date"] for r in tm.load_idul_fitri_dates()]


# ── Source cleaning ───────────────────────────────────────────────────────


def test_corrections_swap_2024_04_and_fix_the_2024_01_jakarta_timur_typo(tm):
    rows = tm.load_bantargebang_rows()
    april = rows[rows["periode_data"] == "202404"]
    assert len(april) == 9
    barat = april[april["instansi_asal_kendaraan"].str.contains("JAKARTA BARAT")].iloc[0]
    assert barat["tonase_parsed"] == pytest.approx(43803.0)
    assert barat["ritasi"] == pytest.approx(6612.0)
    timur = rows[(rows["periode_data"] == "202401") & rows["instansi_asal_kendaraan"].str.contains("TIMUR")]
    assert timur["tonase_parsed"].tolist() == [pytest.approx(52619.0)]
    applied = {c["id"]: c for c in rows.attrs["corrections_applied"]}
    assert applied["202404_ritasi_tonase_swapped"]["rows"] == 9
    assert applied["202401_jakarta_timur_decimal"]["status"] == "inferred_pending_dlh_confirmation"


def test_cleaned_monthly_levels_and_the_2023_12_gap(monthly):
    by_month = monthly.set_index("periode_data")
    assert by_month.loc["202404", "tons_per_day"] == pytest.approx(7213, abs=1)
    assert by_month.loc["202401", "tons_per_day"] == pytest.approx(7845, abs=1)
    assert bool(by_month.loc["202312", "is_gap"]) and np.isnan(by_month.loc["202312", "tons_per_day"])
    assert monthly["is_gap"].sum() == 1
    months = pd.DatetimeIndex(monthly["month"])
    assert (months == pd.date_range(months.min(), months.max(), freq="MS")).all()


def test_tonnes_per_trip_check_fails_loudly_on_the_raw_source(tm):
    raw = tm.load_bantargebang_rows(apply_corrections=False)
    with pytest.raises(ValueError, match="sanity check failed: 10 row"):
        tm.check_tonnes_per_trip(raw, 1.5, 15.0)
    bad = pd.DataFrame(
        {
            "periode_data": ["209901"],
            "instansi_asal_kendaraan": ["X"],
            "ritasi": [100.0],
            "tonase_parsed": [5.0],
        }
    )
    with pytest.raises(ValueError, match="209901 X: 0.05 t/trip"):
        tm.check_tonnes_per_trip(bad, 1.5, 15.0)


def test_a_correction_that_no_longer_matches_the_source_is_refused(tm, tmp_path):
    corrections = json.loads(tm.CORRECTIONS_JSON.read_text(encoding="utf-8"))
    corrections["corrections"][1]["from_tonase"] = 1234.5
    path = tmp_path / "corrections.json"
    path.write_text(json.dumps(corrections), encoding="utf-8")
    with pytest.raises(ValueError, match="source changed"):
        tm.load_bantargebang_rows(corrections_path=path)


def test_synthetic_builder_index_uses_the_cleaned_series(tm):
    idx = tm.build_monthly_intake_index()
    assert (2023, 12) in idx  # gap interpolated for model input
    assert 0.9 < idx[(2024, 4)] < 1.1  # the swapped month no longer reads as -84%
    assert 0.9 < idx[(2024, 1)] < 1.15


# ── Calendar features and the monthly model ───────────────────────────────


def test_calendar_features_match_between_training_and_serving(tm):
    eid = _eid_dates(tm)
    months = pd.date_range("2022-12-01", "2027-12-01", freq="MS")
    for window in ((7, 7), (3, 7), (0, 0)):
        train = tm.month_calendar_features(months, eid, window)
        for m, row in train.iterrows():
            ram, mud = engine.monthly_calendar_features(m.year, m.month, eid, window, tm.RAMADAN_DAYS)
            assert ram == pytest.approx(row["ram"]) and mud == pytest.approx(row["mud"]), (m, window)


def test_committed_model_json_matches_a_refit_on_the_cleaned_series(tm, monthly):
    fitted = tm.fit_monthly_calendar_model(tm.bantargebang_series(monthly), tm.load_idul_fitri_dates())
    stored = json.loads(paths.MONTHLY_CALENDAR_MODEL.read_text(encoding="utf-8"))
    assert json.loads(json.dumps(fitted)) == stored


def test_monthly_forecast_is_deterministic_and_labelled():
    a = engine.forecast_monthly_intake(3)
    b = engine.forecast_monthly_intake(3)
    assert a == b and a["available"]
    assert a["classification"] == "MODEL OUTPUT"
    assert a["validation"] == "rolling-origin backtest on real Bantargebang intake"
    assert a["daily_district_suitability"] == "not_supported_calibrated_synthetic"
    model = json.loads(paths.MONTHLY_CALENDAR_MODEL.read_text(encoding="utf-8"))
    first = pd.Period(model["fitted_through"], freq="M") + 1
    assert [m["month"] for m in a["months"]] == [str(first + i) for i in range(3)]
    assert [m["horizon_months"] for m in a["months"]] == [1, 2, 3]
    assert all(m["within_backtested_horizon"] for m in a["months"])


def test_calendar_factor_dips_in_a_mudik_month_and_is_neutral_otherwise():
    fc = engine.forecast_monthly_intake(12, start_month="2026-01")
    by_month = {m["month"]: m for m in fc["months"]}
    assert by_month["2026-03"]["mudik_fraction"] > 0
    assert by_month["2026-03"]["calendar_factor"] < 1.0
    assert by_month["2026-07"]["calendar_factor"] == 1.0
    assert by_month["2026-07"]["tons_per_day"] > by_month["2026-03"]["tons_per_day"]
    assert by_month["2026-12"]["within_backtested_horizon"] is False  # 8 months after 2026-04
    assert by_month["2026-03"]["idul_fitri_date_unverified"] is False  # 2026 date is verified
    later = engine.forecast_monthly_intake(1, start_month="2027-03")["months"][0]
    assert later["idul_fitri_date_unverified"] is True  # 2027 date awaits the official decision


def test_monthly_forecast_without_a_model_claims_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(engine, "MONTHLY_CALENDAR_MODEL", tmp_path / "missing.json")
    engine._monthly_calendar_model.cache_clear()
    try:
        out = engine.forecast_monthly_intake()
        assert out["available"] is False and out["months"] == []
    finally:
        engine._monthly_calendar_model.cache_clear()


# ── Evaluation artifact ───────────────────────────────────────────────────


def test_evaluation_artifact_schema():
    ev = json.loads(paths.FORECAST_EVALUATION.read_text(encoding="utf-8"))
    assert ev["schema"] == "pythia.forecast_evaluation/1"
    assert ev["data_cleaning"]["missing_months"] == ["202312"]
    assert {c["id"] for c in ev["data_cleaning"]["corrections_applied"]} == {
        "202404_ritasi_tonase_swapped",
        "202401_jakarta_timur_decimal",
    }
    for key in ("landfill_month", "city_month"):
        r = ev["resolutions"][key]
        assert r["target_class"] == "real"
        assert r["strongest_naive"] in {m["name"] for m in r["models"] if m["kind"] == "naive"}
        naive_maes = [m["mae"] for m in r["models"] if m["kind"] == "naive"]
        assert r["mae_naive"] == min(naive_maes)  # scored against the STRONGEST naive
        lo, hi = r["skill_ci90_pct"]
        assert lo <= r["skill_pct"] <= hi
        assert r["origins"] >= 10 and r["horizons_months"] == [1, 2, 3]
        assert r["n_forecasts"] == sum(b["n_forecasts"] for b in r["by_horizon"])
        assert r["n_forecasts"] == r["calendar_months"]["n_forecasts"] + r["normal_months"]["n_forecasts"]
    assert any(s["mudik_window_days"] == [0, 0] for s in ev["sensitivity"])  # ablation kept


def test_evaluation_artifact_is_reproduced_by_the_backtest_code(tm, monthly):
    y = tm.bantargebang_series(monthly)
    eid = _eid_dates(tm)
    got = tm.summarize_backtest(tm.rolling_origin_backtest(y, eid), eid)
    stored = json.loads(paths.FORECAST_EVALUATION.read_text(encoding="utf-8"))["resolutions"][
        "landfill_month"
    ]
    for field in (
        "origins",
        "n_forecasts",
        "strongest_naive",
        "mae_model",
        "mae_naive",
        "skill_pct",
        "skill_ci90_pct",
    ):
        assert got[field] == stored[field], field


def test_metrics_and_labels_are_read_from_the_artifact(monkeypatch, tmp_path):
    ev = json.loads(paths.FORECAST_EVALUATION.read_text(encoding="utf-8"))
    ev["resolutions"]["landfill_month"].update(mae_model=111.11, mae_naive=222.22, skill_pct=50.0)
    ev["resolutions"]["city_month"].update(skill_pct=3.0, skill_ci90_pct=[-2.0, 8.0])
    fake = tmp_path / "forecast_evaluation.json"
    fake.write_text(json.dumps(ev), encoding="utf-8")
    monkeypatch.setattr(paths, "FORECAST_EVALUATION", fake)

    metrics = forecast_metrics.monthly_backtest_metrics()
    assert metrics["landfill_month"]["mae_model"] == 111.11
    assert metrics["landfill_month"]["mae_naive"] == 222.22
    labels = forecast_metrics.suitability_labels()
    assert labels["landfill_month"] == "backtested_real"
    assert labels["city_month"] == "not_evaluated"  # interval crosses zero: no skill claim
    details = forecast_metrics.suitability_details()
    assert details["landfill_month"]["evidence_of_skill"] is True
    assert details["city_month"]["evidence_of_skill"] is False

    monkeypatch.setattr(paths, "FORECAST_EVALUATION", tmp_path / "absent.json")
    assert forecast_metrics.monthly_backtest_metrics() == {}
    assert forecast_metrics.suitability_labels()["landfill_month"] == "not_evaluated"


def test_suitability_and_monthly_intake_endpoints(api_client):
    body = api_client.get("/api/ml/suitability").json()
    real = body["monthly_backtest"]["landfill_month"]
    assert body["resolutions"]["landfill_month"] == "backtested_real"
    assert body["details"]["landfill_month"]["metrics"]["skill_pct"] == real["skill_pct"]
    res = api_client.get("/api/ml/monthly-intake", params={"months": 2})
    assert res.status_code == 200
    assert len(res.json()["months"]) == 2


# ── rain_3d train/serve parity ────────────────────────────────────────────


@pytest.mark.parametrize("rain", [0.0, 4.2, 12.0, 42.0])
def test_rain_3d_serving_matches_the_training_definition(tm, rain):
    trained = float(tm.rain_3d(pd.Series([rain] * 5)).iloc[-1])  # constant scenario, steady state
    assert engine.scenario_rain_3d(rain) == pytest.approx(trained)
    features = engine.predict_waste_hybrid("cengkareng", rainfall_mm=rain)["features_used"]
    assert features["rain_3d"] == pytest.approx(trained)
    assert list(features) == tm.FEATURE_ORDER  # feature order unchanged
