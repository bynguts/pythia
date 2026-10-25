"""calibrate_queue.py: calibrate the TPA queue model's inputs on the real Bantargebang weighing data.

Run from the repository root:
    python ml/scripts/calibrate_queue.py

Writes `apps/api/data/models/queue_calibration.json`, which the API adds to the queue
metric as its `calibration` block (`app/fleet/queue_simulation.py`). The run is
deterministic: the same CSV gives byte-identical JSON.

What the source can and cannot calibrate (honest):
  - `bantargebang_hasil_penimbangan.csv` (data.go.id) holds MONTHLY trips (ritasi) and
    tonnes per source agency. It is read through `train_models.load_bantargebang_rows`
    (the shared `parse_tonase` parser and the explicit `bantargebang_corrections.json`).
  - It calibrates the daily gate-arrival input (trips/day) and the overall tonnes per trip.
  - It has no gate-arrival or weigh-start times, so the simulated waits are NOT validated
    by it (`wait_validation: not_observed`).
  - The runtime arrival input (`bantargebang_daily_arrivals`) reads the raw CSV and does
    not apply the corrections; this script reports the corrected and uncorrected values
    side by side instead of changing the runtime input.

Backtest of the daily-arrival input: rolling origin, one month ahead. At each origin the
runtime estimator (median trips/day of the latest 12 months present, rounded) and the
last-month naive (the origin month's trips/day) predict the next calendar month. A pair
with a gap month (missing from the source) is not scored.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

import pandas as pd
from train_models import (
    BOOTSTRAP_RESAMPLES,
    BOOTSTRAP_SEED,
    MODELS_DIR,
    cluster_bootstrap_skill,
    load_bantargebang_rows,
)

OUT = MODELS_DIR / "queue_calibration.json"
SOURCE = (
    "Bantargebang weighing data (data.go.id, bantargebang_hasil_penimbangan.csv): "
    "monthly trips (ritasi) and tonnes per source agency"
)
WINDOW_MONTHS = 12  # the runtime estimator's window (bantargebang_daily_arrivals(months=12))
MODEL_NAME = "median_latest_12_months"
NAIVE_NAME = "naive_last_month"


def monthly_arrivals(apply_corrections: bool) -> pd.DataFrame:
    """Trips/day per calendar month on a full monthly range; a month absent from the source is NaN."""
    rows = load_bantargebang_rows(apply_corrections=apply_corrections)
    totals = rows.groupby("periode_data")[["ritasi", "tonase_parsed"]].sum()
    totals.index = pd.to_datetime(totals.index, format="%Y%m")
    full = pd.date_range(totals.index.min(), totals.index.max(), freq="MS")
    out = totals.reindex(full)
    out["days"] = full.days_in_month
    out["arrivals_per_day"] = out["ritasi"] / out["days"]
    out.attrs["corrections_applied"] = rows.attrs.get("corrections_applied", [])
    return out


def runtime_estimate(per_day: pd.Series) -> tuple[int, list[str]]:
    """The runtime estimator on a series: rounded median of the latest 12 months present."""
    present = per_day.dropna().iloc[-WINDOW_MONTHS:]
    return round(statistics.median(present.tolist())), [f"{d:%Y-%m}" for d in present.index]


def backtest_daily_arrivals(per_day: pd.Series) -> dict:
    """Rolling-origin one-month-ahead backtest: runtime median estimator vs last-month naive."""
    recs = []
    for i in range(len(per_day) - 1):
        history = per_day.iloc[: i + 1].dropna()
        origin, target = per_day.index[i], per_day.index[i + 1]
        if len(history) < WINDOW_MONTHS or pd.isna(per_day.iloc[i]) or pd.isna(per_day.iloc[i + 1]):
            continue
        actual = float(per_day.iloc[i + 1])
        model, _window = runtime_estimate(history)
        naive = float(per_day.iloc[i])
        recs.append(
            {
                "origin": f"{origin:%Y-%m}",
                "month": f"{target:%Y-%m}",
                "actual": actual,
                "model": float(model),
                "naive": naive,
            }
        )
    fc = pd.DataFrame(recs)
    err_model = (fc["model"] - fc["actual"]).abs().to_numpy()
    err_naive = (fc["naive"] - fc["actual"]).abs().to_numpy()
    p5, p95 = cluster_bootstrap_skill(err_model, err_naive, fc["month"].to_numpy())
    mae_model, mae_naive = float(err_model.mean()), float(err_naive.mean())
    return {
        "target": "Bantargebang gate trips (ritasi) per day, monthly mean",
        "unit": "trips/day",
        "model": MODEL_NAME,
        "naive": NAIVE_NAME,
        "horizon_months": 1,
        "min_history_months": WINDOW_MONTHS,
        "origins": len(fc),
        "first_origin": fc["origin"].iloc[0],
        "last_origin": fc["origin"].iloc[-1],
        "period": f"{fc['month'].iloc[0]}..{fc['month'].iloc[-1]}",
        "mae_model": round(mae_model, 1),
        "mae_naive": round(mae_naive, 1),
        "mape_model_pct": round(float(100 * (err_model / fc["actual"]).mean()), 2),
        "mape_naive_pct": round(float(100 * (err_naive / fc["actual"]).mean()), 2),
        "skill_pct": round(100 * (1 - mae_model / mae_naive), 1),
        "skill_ci90_pct": [round(p5, 1), round(p95, 1)],
        "ci_method": (
            f"cluster bootstrap over target months, {BOOTSTRAP_RESAMPLES} resamples, seed {BOOTSTRAP_SEED}"
        ),
        "skipped": "origin/target pairs with a month missing from the source are not scored",
    }


def build_calibration() -> dict:
    corrected = monthly_arrivals(apply_corrections=True)
    uncorrected = monthly_arrivals(apply_corrections=False)
    per_day = corrected["arrivals_per_day"]
    value, window = runtime_estimate(per_day)
    raw_value, _raw_window = runtime_estimate(uncorrected["arrivals_per_day"])
    differs = (corrected["ritasi"] - uncorrected["ritasi"]).abs() > 0
    present = corrected.dropna(subset=["ritasi"])
    trips, tons = float(present["ritasi"].sum()), float(present["tonase_parsed"].sum())
    months = [f"{d:%Y-%m}" for d in corrected.index]
    return {
        "artifact": "queue_calibration",
        "generated_by": "ml/scripts/calibrate_queue.py",
        "source": SOURCE,
        "data_classification": "real",
        "granularity": "monthly totals per source agency; no per-truck, per-day or per-hour records",
        "period": f"{months[0]}..{months[-1]}",
        "gap_months": [m for m, gap in zip(months, corrected["ritasi"].isna(), strict=True) if gap],
        "corrections_applied": [c["id"] for c in corrected.attrs["corrections_applied"]],
        "arrivals_per_day_by_month": [
            {
                "month": m,
                "trips": None if pd.isna(r.ritasi) else int(r.ritasi),
                "days": int(r.days),
                "arrivals_per_day": None if pd.isna(r.ritasi) else round(float(r.arrivals_per_day), 1),
            }
            for m, r in zip(months, corrected.itertuples(), strict=True)
        ],
        "arrivals_per_day": {
            "estimator": f"median trips/day of the latest {WINDOW_MONTHS} months present, rounded",
            "window": f"{window[0]}..{window[-1]}",
            "corrected": value,
            "uncorrected": raw_value,
            "difference": value - raw_value,
            "corrections_applied_at_runtime": False,
            "note": (
                "the runtime arrival input (bantargebang_daily_arrivals) reads the raw CSV without "
                "bantargebang_corrections.json; the corrected value is reported here, not substituted"
            ),
            "months_changed_by_corrections": [
                {
                    "month": m,
                    "corrected_per_day": round(float(c), 1),
                    "uncorrected_per_day": round(float(u), 1),
                }
                for m, c, u, hit in zip(
                    months, per_day, uncorrected["arrivals_per_day"], differs, strict=True
                )
                if hit
            ],
        },
        "tons_per_rit_overall": {
            "value": round(tons / trips, 2),
            "tons": round(tons, 1),
            "trips": int(trips),
            "period": f"{months[0]}..{months[-1]} (gap months excluded)",
            "basis": "sum of corrected tonnes / sum of trips over every month present",
        },
        "backtest": backtest_daily_arrivals(per_day),
        "wait_validation": "not_observed",
        "wait_validation_note": (
            "the source has no gate-arrival or weigh-start times, so the simulated weighbridge "
            "waits are not validated by it"
        ),
    }


def write_calibration(path: Path = OUT) -> dict:
    calibration = build_calibration()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(calibration, indent=2, ensure_ascii=False) + "\n")
    return calibration


def main() -> None:
    calibration = write_calibration()
    bt = calibration["backtest"]
    print(
        f"[Queue calibration] wrote {OUT}: {calibration['arrivals_per_day']['corrected']} trips/day "
        f"({calibration['arrivals_per_day']['window']}), {calibration['tons_per_rit_overall']['value']} t/rit; "
        f"backtest {bt['origins']} origins MAE {bt['mae_model']} vs naive {bt['mae_naive']} "
        f"(skill {bt['skill_pct']}% CI90 {bt['skill_ci90_pct']})"
    )


if __name__ == "__main__":
    main()
