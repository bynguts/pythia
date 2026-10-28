"""
backtest_ai_monthly.py — out-of-sample check of the daily per-kecamatan Prophet + XGBoost
hybrid against REAL monthly Bantargebang intake.

Run from the repository root (single process, ~25-30 min on a laptop):
    python ml/scripts/backtest_ai_monthly.py

Writes `apps/api/data/models/forecast_evaluation_ai.json`.

Why rolling-origin and not the shipped models: the daily training target of the 42 kecamatan
models is calibrated-synthetic and is multiplied by the real Bantargebang monthly index
(`train_models.build_monthly_intake_index`, normalised over every month through 2026-04).
Comparing the shipped models with the same months would score the generator, not the model.

Design: for each origin month of the existing `landfill_month` backtest (same origins, same
horizons 1..3, same target and loader), the synthetic daily dataset is rebuilt from data
available before the origin only (monthly index from months before the origin, SIPSN years
before the origin year, weather before the origin), the 42 hybrids are refitted with the
`train_models.train_one` configuration, and the next three months are forecast with
calendar/event features (known in advance) and training-period weather climatology (no
oracle weather). Daily district forecasts are summed to the city and averaged per month (t/day).

Two variants are scored:
  - `prophet_xgb_raw`: the summed hybrid as is (its level is SILIKA generation x SIPSN growth).
  - `prophet_xgb_rescaled`: the same, multiplied by actual / fitted over the 12 training months
    before the origin (level calibration on training months only).
Prophet uncertainty sampling is disabled: it does not change `yhat`.
"""

from __future__ import annotations

import json
import logging
import time

import numpy as np
import pandas as pd
import train_models as tm
from prophet import Prophet
from xgboost import XGBRegressor

logging.getLogger("prophet").setLevel(logging.ERROR)
logging.getLogger("cmdstanpy").setLevel(logging.ERROR)

OUT = tm.MODELS_DIR / "forecast_evaluation_ai.json"
AI_RAW = "prophet_xgb_raw"
AI_SCALED = "prophet_xgb_rescaled"
RESCALE_MONTHS = 12
WEATHER_COLS = ("precipitation_mm", "temp_max_c", "wind_max_kmh")


def sipsn_known_before(by_year: dict, origin: pd.Timestamp) -> dict:
    """SIPSN yearly totals are published after the year ends: only years before the origin year."""
    return {y: v for y, v in by_year.items() if y < origin.year}


def monthly_index_before(y: pd.Series, o: int) -> dict:
    """The real monthly index as `build_monthly_intake_index` builds it, from months before origin o."""
    train = tm.fill_gaps(y.iloc[:o]).dropna()
    overall = train.mean()
    return {(d.year, d.month): float(v / overall) for d, v in train.items()}


def future_features(
    days: pd.DatetimeIndex, train_weather: pd.DataFrame, holiday_md, events, city
) -> pd.DataFrame:
    """Calendar and scheduled events as known in advance; weather = training climatology per month."""
    clim = train_weather.groupby(train_weather["date"].dt.month)[list(WEATHER_COLS)].mean()
    f = pd.DataFrame({"ds": days})
    for col in WEATHER_COLS:
        f[col] = days.month.map(clim[col]).to_numpy()
    f["is_weekend"] = (days.dayofweek >= 5).astype(int)
    f["is_holiday"] = [int((d.month, d.day) in holiday_md) for d in days]
    f["event_attendance"] = [int(events.get((city, d.normalize()), 0)) for d in days]
    f["day_of_week"] = days.dayofweek
    f["month_of_year"] = days.month
    f["day_of_month"] = days.day
    f["is_payday"] = f["day_of_month"].isin([1, 2, 25, 26, 27, 28]).astype(int)
    f["rain_3d"] = tm.rain_3d(f["precipitation_mm"])
    return f


def fit_predict_one(dk: pd.DataFrame, fut: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """`train_one` configuration; returns (fitted on training days, forecast on future days)."""
    dk = dk.sort_values("date").reset_index(drop=True)
    dk["ds"] = pd.to_datetime(dk["date"])
    prophet = Prophet(
        weekly_seasonality=True, yearly_seasonality=True, daily_seasonality=False, uncertainty_samples=0
    )
    prophet.fit(dk[["ds"]].assign(y=dk["waste_tons"]))
    yhat_tr = prophet.predict(dk[["ds"]])["yhat"].to_numpy()
    xgb = XGBRegressor(
        n_estimators=500,
        max_depth=6,
        learning_rate=0.03,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        reg_alpha=0.1,
        reg_lambda=1.0,
        random_state=42,
        n_jobs=0,
    )
    xgb.fit(dk[tm.FEATURE_ORDER].astype(float), dk["waste_tons"].to_numpy() - yhat_tr)
    fitted = yhat_tr + xgb.predict(dk[tm.FEATURE_ORDER].astype(float))
    yhat_fu = prophet.predict(fut[["ds"]])["yhat"].to_numpy()
    pred = yhat_fu + xgb.predict(fut[tm.FEATURE_ORDER].astype(float))
    return pd.Series(fitted, index=dk["ds"]), pd.Series(pred, index=fut["ds"].to_numpy())


def ai_backtest(y: pd.Series) -> pd.DataFrame:
    kec = tm.load_kecamatan_baseline()
    by_year = tm.load_sipsn_baselines_by_year()
    weather = tm.load_weather()
    holiday_md = tm.load_holiday_monthdays()
    events = tm.load_event_calendar_by_city()
    recs = []
    for o in range(tm.BACKTEST_MIN_TRAIN, len(y)):
        t0 = time.time()
        origin = y.index[o]
        future_months = y.index[o : o + tm.BACKTEST_MAX_H]
        days = pd.date_range(origin, future_months[-1] + pd.offsets.MonthEnd(0), freq="D")
        w_train = weather[weather["date"] < origin].reset_index(drop=True)
        dataset = tm.build_dataset(
            w_train, holiday_md, events, kec, sipsn_known_before(by_year, origin), monthly_index_before(y, o)
        )
        fitted_sum = pd.Series(0.0, index=pd.DatetimeIndex(w_train["date"]))
        pred_sum = pd.Series(0.0, index=days)
        for slug, city in zip(kec["slug"], kec["city"], strict=True):
            fut = future_features(days, w_train, holiday_md, events, city)
            fitted, pred = fit_predict_one(dataset[dataset["kecamatan"] == slug].copy(), fut)
            fitted_sum += fitted.reindex(fitted_sum.index).to_numpy()
            pred_sum += pred.to_numpy()
        raw = pred_sum.resample("MS").mean()
        fitted_month = fitted_sum.resample("MS").mean()
        last = y.iloc[:o].dropna().index[-RESCALE_MONTHS:]
        scale = float(y.loc[last].mean() / fitted_month.reindex(last).mean())
        for h, d in enumerate(future_months, 1):
            if np.isnan(y.loc[d]):
                continue
            for name, v in ((AI_RAW, raw.loc[d]), (AI_SCALED, raw.loc[d] * scale)):
                recs.append(
                    {
                        "origin": f"{origin:%Y-%m}",
                        "h": h,
                        "month": f"{d:%Y-%m}",
                        "model": name,
                        "pred": float(v),
                        "actual": float(y.loc[d]),
                    }
                )
        print(
            f"[AI] origin {origin:%Y-%m}: h1 raw {raw.iloc[0]:,.0f} scaled {raw.iloc[0] * scale:,.0f} "
            f"actual {y.loc[origin]:,.0f} t/day (scale {scale:.3f}, {time.time() - t0:.0f}s)",
            flush=True,
        )
    return pd.DataFrame(recs)


def main() -> None:
    started = time.time()
    monthly = tm.load_bantargebang_monthly()
    y = tm.bantargebang_series(monthly)
    eid = [r["date"] for r in tm.load_idul_fitri_dates()]
    base = tm.rolling_origin_backtest(y, eid)
    fc = pd.concat([base, ai_backtest(y)], ignore_index=True)
    out_models = {}
    for name in (AI_RAW, AI_SCALED):
        s = tm.summarize_backtest(fc, eid, model=name)
        for m in s["models"]:
            if m["kind"] == "superseded":
                m["kind"] = "reference_model" if m["name"] == tm.MONTHLY_MODEL_NAME else "ai_variant"
        s["one_month_ahead"] = tm.one_month_ahead_rows(fc, eid, naive=s["strongest_naive"], model=name)
        out_models[name] = s
    reference = {m["name"]: m for m in out_models[AI_RAW]["models"]}[tm.MONTHLY_MODEL_NAME]
    evaluation = {
        "schema": "pythia.forecast_evaluation_ai/1",
        "generated_by": "ml/scripts/backtest_ai_monthly.py",
        "target": "Bantargebang landfill intake, t/day per month (total of all sources)",
        "target_class": "real",
        "unit": "t/day",
        "period": f"{y.index.min():%Y-%m}..{y.index.max():%Y-%m}",
        "source_file": tm.BANTARGEBANG_CSV.name,
        "corrections_file": tm.CORRECTIONS_JSON.name,
        "same_design_as": "forecast_evaluation.json resolutions.landfill_month",
        "design": (
            "rolling origin; at each origin the calibrated-synthetic daily dataset is rebuilt from data "
            "before the origin only and the 42 Prophet+XGBoost hybrids are refitted; daily district "
            "forecasts summed to the city and averaged per month"
        ),
        "leakage_controls": [
            "monthly index from months before the origin only (shipped models use all months)",
            "SIPSN yearly city totals for years before the origin year only",
            "weather of the forecast days unknown: training climatology per calendar month",
            "calendar, holidays and scheduled events used as known in advance",
        ],
        "not_applied": "serving-time monotone rain response and event overlay (engine.py)",
        "rescale_months": RESCALE_MONTHS,
        "reference_model": {"name": tm.MONTHLY_MODEL_NAME, **{k: reference[k] for k in ("mae", "mape_pct")}},
        "variants": out_models,
        "runtime_s": round(time.time() - started),
    }
    OUT.write_text(json.dumps(evaluation, indent=2) + "\n", encoding="utf-8")
    for name, s in out_models.items():
        print(
            f"{name}: MAPE {s['mape_model_pct']}% vs {s['strongest_naive']} {s['mape_naive_pct']}% "
            f"skill {s['skill_pct']:+.1f}% {s['skill_ci90_pct']} n={s['n_forecasts']}"
        )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
