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

Only the standard library is imported at module level: the pure helpers
(`runtime_estimate`, `backtest_scores`, `serialize`) are what the API tests recompute
the committed artifact with, and they must not pull pandas, prophet or xgboost into
that process. `train_models` (and pandas/numpy) load lazily, only to build the artifact.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "apps" / "api" / "data" / "models" / "queue_calibration.json"
SOURCE = (
    "Bantargebang weighing data (data.go.id, bantargebang_hasil_penimbangan.csv): "
    "monthly trips (ritasi) and tonnes per source agency"
)
WINDOW_MONTHS = 12  # the runtime estimator's window (bantargebang_daily_arrivals(months=12))
MODEL_NAME = "median_latest_12_months"
NAIVE_NAME = "naive_last_month"


def _per_day(row: dict) -> float | None:
    return None if row["trips"] is None else row["trips"] / row["days"]


def runtime_estimate(rows: list[dict]) -> tuple[int, list[str]]:
    """The runtime estimator on month rows: rounded median trips/day of the latest 12 months present."""
    present = [r for r in rows if r["trips"] is not None][-WINDOW_MONTHS:]
    return round(statistics.median(_per_day(r) for r in present)), [r["month"] for r in present]


def _forecasts(rows: list[dict]) -> list[dict]:
    """One-month-ahead forecasts at every origin with 12 months present and both months in the source."""
    out = []
    for i in range(len(rows) - 1):
        origin, target = rows[i], rows[i + 1]
        history = [r for r in rows[: i + 1] if r["trips"] is not None]
        if len(history) < WINDOW_MONTHS or origin["trips"] is None or target["trips"] is None:
            continue
        out.append(
            {
                "origin": origin["month"],
                "month": target["month"],
                "actual": _per_day(target),
                "model": float(runtime_estimate(history)[0]),
                "naive": _per_day(origin),
            }
        )
    return out


def backtest_scores(rows: list[dict]) -> dict:
    """Rolling-origin backtest of the runtime estimator vs last-month naive: every field but the CI.

    `rows` are `arrivals_per_day_by_month` entries (`month`, `trips` or None, `days`).
    """
    fc = _forecasts(rows)
    err_model = [abs(f["model"] - f["actual"]) for f in fc]
    err_naive = [abs(f["naive"] - f["actual"]) for f in fc]
    mae_model, mae_naive = statistics.fmean(err_model), statistics.fmean(err_naive)

    def mape(errors: list[float]) -> float:
        return round(100 * statistics.fmean(e / f["actual"] for e, f in zip(errors, fc, strict=True)), 2)

    return {
        "target": "Bantargebang gate trips (ritasi) per day, monthly mean",
        "unit": "trips/day",
        "model": MODEL_NAME,
        "naive": NAIVE_NAME,
        "horizon_months": 1,
        "min_history_months": WINDOW_MONTHS,
        "origins": len(fc),
        "first_origin": fc[0]["origin"],
        "last_origin": fc[-1]["origin"],
        "period": f"{fc[0]['month']}..{fc[-1]['month']}",
        "mae_model": round(mae_model, 1),
        "mae_naive": round(mae_naive, 1),
        "mape_model_pct": mape(err_model),
        "mape_naive_pct": mape(err_naive),
        "skill_pct": round(100 * (1 - mae_model / mae_naive), 1),
    }


def backtest_daily_arrivals(rows: list[dict]) -> dict:
    """backtest_scores plus the 90% skill interval (train_models' cluster bootstrap over target months)."""
    import numpy as np
    from train_models import BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, cluster_bootstrap_skill

    fc = _forecasts(rows)
    err_model = np.array([abs(f["model"] - f["actual"]) for f in fc])
    err_naive = np.array([abs(f["naive"] - f["actual"]) for f in fc])
    p5, p95 = cluster_bootstrap_skill(err_model, err_naive, np.array([f["month"] for f in fc]))
    return {
        **backtest_scores(rows),
        "skill_ci90_pct": [round(p5, 1), round(p95, 1)],
        "ci_method": (
            f"cluster bootstrap over target months, {BOOTSTRAP_RESAMPLES} resamples, seed {BOOTSTRAP_SEED}"
        ),
        "skipped": "origin/target pairs with a month missing from the source are not scored",
    }


def monthly_rows(apply_corrections: bool) -> tuple[list[dict], list[str]]:
    """Per calendar month on a full range: trips, days and tonnes (None when absent); plus the corrections."""
    import pandas as pd
    from train_models import load_bantargebang_rows

    rows = load_bantargebang_rows(apply_corrections=apply_corrections)
    totals = rows.groupby("periode_data")[["ritasi", "tonase_parsed"]].sum()
    totals.index = pd.to_datetime(totals.index, format="%Y%m")
    full = pd.date_range(totals.index.min(), totals.index.max(), freq="MS")
    totals = totals.reindex(full)
    months = [
        {
            "month": f"{month:%Y-%m}",
            "trips": None if pd.isna(r.ritasi) else int(r.ritasi),
            "days": int(month.days_in_month),
            "tons": None if pd.isna(r.ritasi) else float(r.tonase_parsed),
        }
        for month, r in zip(full, totals.itertuples(), strict=True)
    ]
    return months, [c["id"] for c in rows.attrs.get("corrections_applied", [])]


def build_calibration() -> dict:
    corrected, corrections = monthly_rows(apply_corrections=True)
    uncorrected, _none = monthly_rows(apply_corrections=False)
    value, window = runtime_estimate(corrected)
    raw_value, _raw_window = runtime_estimate(uncorrected)
    present = [r for r in corrected if r["trips"] is not None]
    trips, tons = sum(r["trips"] for r in present), sum(r["tons"] for r in present)
    months = [r["month"] for r in corrected]
    by_month = [
        {
            "month": r["month"],
            "trips": r["trips"],
            "days": r["days"],
            "arrivals_per_day": None if r["trips"] is None else round(_per_day(r), 1),
        }
        for r in corrected
    ]
    return {
        "artifact": "queue_calibration",
        "generated_by": "ml/scripts/calibrate_queue.py",
        "source": SOURCE,
        "data_classification": "real",
        "granularity": "monthly totals per source agency; no per-truck, per-day or per-hour records",
        "period": f"{months[0]}..{months[-1]}",
        "gap_months": [r["month"] for r in corrected if r["trips"] is None],
        "corrections_applied": corrections,
        "arrivals_per_day_by_month": by_month,
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
                    "month": c["month"],
                    "corrected_per_day": round(_per_day(c), 1),
                    "uncorrected_per_day": round(_per_day(u), 1),
                }
                for c, u in zip(corrected, uncorrected, strict=True)
                if c["trips"] != u["trips"]
            ],
        },
        "tons_per_rit_overall": {
            "value": round(tons / trips, 2),
            "tons": round(tons, 1),
            "trips": trips,
            "period": f"{months[0]}..{months[-1]} (gap months excluded)",
            "basis": "sum of corrected tonnes / sum of trips over every month present",
        },
        "backtest": backtest_daily_arrivals(by_month),
        "wait_validation": "not_observed",
        "wait_validation_note": (
            "the source has no gate-arrival or weigh-start times, so the simulated weighbridge "
            "waits are not validated by it"
        ),
    }


def serialize(calibration: dict) -> str:
    """The artifact's exact text: insertion order, 2-space indent, trailing newline (written with LF)."""
    return json.dumps(calibration, indent=2, ensure_ascii=False) + "\n"


def write_calibration(path: Path = OUT) -> dict:
    calibration = build_calibration()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(serialize(calibration))
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
