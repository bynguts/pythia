# -*- coding: utf-8 -*-
"""
train_models.py — Reproducible training pipeline for Pythia Case 2 waste models.

Run from the repository root:
    python ml/scripts/train_models.py                 # everything
    python ml/scripts/train_models.py --monthly-only  # monthly model + evaluation only

Writes to `apps/api/data/models/`:
  - monthly_calendar_model.json + forecast_evaluation.json: the monthly landfill-intake
    forecaster (12-month level + Ramadan/Lebaran-exodus calendar adjustment) and its
    rolling-origin backtest on the REAL Bantargebang series against the strongest naive
    baseline. This is the only forecast validated on real data.
  - per-KECAMATAN Prophet + XGBoost hybrids (42 Jakarta kecamatan), plus the assembled
    training dataset and the evaluation report in `ml/data/processed/`.

DATA PROVENANCE (honest):
  REAL:
    - Per-kecamatan waste generation (42 kecamatan) from SILIKA DLH 2023
      (`timbulan_kecamatan_2023.csv`) — itself modelled by SILIKA's population formula.
    - SIPSN KLHK yearly per-city timbulan 2021-2025 — real temporal growth.
    - Bantargebang monthly landfill intake — real month-to-month variation. Two corrupted
      source rows are corrected and one missing month kept as a gap, all listed in
      `bantargebang_corrections.json` (the 2024-01 fix is an inference pending DLH
      confirmation); a tonnes-per-trip check stops training on new bad rows.
    - Idul Fitri dates (`idul_fitri_dates.json`, per-date `verified` flag).
    - Open-Meteo 5-year daily weather; Indonesian holidays; real event calendar
      2021-2026 (`jakarta_events_2021_2026.csv`).
  CALIBRATED-SYNTHETIC:
    - The DAILY resolution of each kecamatan series. Real daily per-kecamatan
      measurements do not exist publicly, so the real 2023 spatial baseline is
      grown by real SIPSN yearly ratios, shaped by the real Bantargebang monthly
      index, and varied daily by hand-set weather/event/weekday multipliers + ~5%
      lognormal noise. Every row is labelled `calibrated_synthetic_anchored_to_SILIKA_real`.
      Scores on this target are not validation. Swap in real daily per-kecamatan logs
      to retrain — contract unchanged.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from prophet import Prophet
from sklearn.metrics import mean_absolute_error
from xgboost import XGBRegressor

logging.getLogger("prophet").setLevel(logging.ERROR)
logging.getLogger("cmdstanpy").setLevel(logging.ERROR)

# ── Paths ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[1]              # ml/
DATA_REAL = ROOT / "data" / "real"
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"
MODELS_DIR = ROOT.parent / "apps" / "api" / "data" / "models"
BACKUP_DIR = MODELS_DIR / "_synthetic_backup"

KECAMATAN_CSV = DATA_REAL / "timbulan_kecamatan_2023.csv"
SIPSN_CSV = DATA_REAL / "sipsn_timbulan_2018_2025_dki.csv"
BANTARGEBANG_CSV = DATA_REAL / "bantargebang_hasil_penimbangan.csv"
WEATHER_JSON = DATA_RAW / "open_meteo_jakarta_history_5y.json"
HOLIDAYS_JSON = DATA_REAL / "hari_libur_indonesia_2026.json"
EVENTS_CSV = DATA_REAL / "jakarta_events_2021_2026.csv"
# Explicit corrections for corrupted Bantargebang rows, and the Idul Fitri date table.
CORRECTIONS_JSON = DATA_REAL / "bantargebang_corrections.json"
IDUL_FITRI_JSON = DATA_REAL / "idul_fitri_dates.json"

DATASET_OUT = DATA_PROCESSED / "training_dataset_kecamatan.csv"
REPORT_OUT = DATA_PROCESSED / "hybrid_forecaster_evaluation.md"
# Read by the API (app/core/paths.py): the monthly model and its real-data backtest.
MONTHLY_MODEL_OUT = MODELS_DIR / "monthly_calendar_model.json"
EVALUATION_OUT = MODELS_DIR / "forecast_evaluation.json"

# Backend feature contract (order MUST match apps/api/app/forecast/engine.py).
FEATURE_ORDER = [
    "precipitation_mm", "temp_max_c", "wind_max_kmh",
    "is_weekend", "is_holiday", "event_attendance",
    "day_of_week", "month_of_year", "day_of_month", "is_payday", "rain_3d",
]

SIPSN_CITY_MAP = {
    "Kota Adm. Jakarta Pusat": "Jakarta Pusat",
    "Kota Adm. Jakarta Utara": "Jakarta Utara",
    "Kota Adm. Jakarta Barat": "Jakarta Barat",
    "Kota Adm. Jakarta Selatan": "Jakarta Selatan",
    "Kota Adm. Jakarta Timur": "Jakarta Timur",
}


def _city_short(label: str) -> str:
    return (label.replace("KOTA ADM. ", "").replace("KAB. ADM. ", "")
            .strip().title())


def _slug(name: str) -> str:
    return name.strip().lower().replace(" ", "_")


# ── Load real per-kecamatan spatial baseline (SILIKA DLH 2023) ─────────────
def load_kecamatan_baseline() -> pd.DataFrame:
    """Real 2023 per-kecamatan waste generation from SILIKA DLH.

    Returns DataFrame[slug, kecamatan, city, base_2023_tpd, lat, lng].
    """
    df = pd.read_csv(KECAMATAN_CSV)
    df["slug"] = df["kecamatan"].map(_slug)
    df["city"] = df["kota_wilayah"].map(_city_short)
    df = df.rename(columns={"timbulan_ton_per_hari": "base_2023_tpd"})
    keep = df[["slug", "kecamatan", "city", "base_2023_tpd", "lat", "lng"]].copy()
    assert keep["slug"].is_unique, "duplicate kecamatan slug"
    print(f"[Spatial] SILIKA 2023: {len(keep)} kecamatan, "
          f"total {keep['base_2023_tpd'].sum():,.0f} t/day across "
          f"{keep['city'].nunique()} cities")
    return keep


# ── Real temporal growth (SIPSN yearly per city) ───────────────────────────
def load_sipsn_baselines_by_year() -> dict[int, dict[str, float]]:
    df = pd.read_csv(SIPSN_CSV)
    df = df[df["nama_kabkota"].isin(SIPSN_CITY_MAP)].copy()
    by_year: dict[int, dict[str, float]] = {}
    for year in sorted(df["tahun"].unique()):
        yr = int(year)
        sub = df[df["tahun"] == yr]
        levels = {}
        for label, short in SIPSN_CITY_MAP.items():
            row = sub[sub["nama_kabkota"] == label]
            if not row.empty:
                levels[short] = float(row["jml_timbulan_harian"].iloc[0])
        if len(levels) == len(SIPSN_CITY_MAP):
            by_year[yr] = levels
    print(f"[Temporal] SIPSN per-year city baselines: {sorted(by_year)}")
    return by_year


def build_city_growth_series(by_year: dict[int, dict[str, float]],
                             dates: pd.Series) -> dict[str, np.ndarray]:
    """Smooth per-day growth ratio per city, relative to 2023 (=1.0).

    Anchors each SIPSN year at mid-year (Jul 1), linearly interpolates, then
    divides by the city's 2023 level so the ratio multiplies the real 2023
    kecamatan baseline. Flat extrapolation outside the SIPSN range.
    """
    years = sorted(by_year)
    anchors_x = np.array([pd.Timestamp(y, 7, 1).value for y in years])
    x = dates.map(lambda d: pd.Timestamp(d).value).to_numpy()
    ref_year = 2023 if 2023 in by_year else years[0]
    out: dict[str, np.ndarray] = {}
    for short in SIPSN_CITY_MAP.values():
        anchors_y = np.array([by_year[y][short] for y in years])
        level = np.interp(x, anchors_x, anchors_y)
        out[short] = level / by_year[ref_year][short]
    return out


# ── Bantargebang monthly intake (the only fully REAL forecasting target) ───
def parse_tonase(value) -> float:
    """Robustly parse the inconsistent `tonase` column (4 real formats)."""
    s = str(value).strip()
    if not s:
        return float("nan")
    try:
        return float(s)
    except ValueError:
        pass
    if "," in s and "." not in s:
        try:
            return float(s.replace(",", "."))
        except ValueError:
            return float("nan")
    if s.count(".") > 1:
        parts = s.split(".")
        try:
            return float(f"{parts[0]}.{parts[1]}")
        except ValueError:
            return float("nan")
    groups = re.split(r"\s+", s)
    if len(groups) < 2:
        return float("nan")
    try:
        return float(f"{''.join(groups[:-1])}.{groups[-1]}")
    except ValueError:
        return float("nan")


def _norm_source_name(name) -> str:
    return re.sub(r"\s+", " ", str(name).upper()).strip()


def load_bantargebang_corrections(path: Path = CORRECTIONS_JSON) -> dict:
    """The explicit correction table for the Bantargebang source (see the file itself)."""
    return json.loads(path.read_text(encoding="utf-8"))


def apply_bantargebang_corrections(rows: pd.DataFrame, corrections: dict) -> pd.DataFrame:
    """Apply exactly the listed corrections; fail loudly when one no longer matches the source.

    `rows` needs `periode_data`, `instansi_asal_kendaraan`, numeric `ritasi` and
    `tonase_parsed`. The applied entries are recorded in `attrs["corrections_applied"]`.
    """
    df = rows.copy()
    applied: list[dict] = []
    for c in corrections.get("corrections", []):
        hit = df["periode_data"] == c["periode_data"]
        if c["instansi_asal_kendaraan"] != "*":
            wanted = _norm_source_name(c["instansi_asal_kendaraan"])
            hit &= df["instansi_asal_kendaraan"].map(_norm_source_name) == wanted
        if not hit.any():
            raise ValueError(f"Bantargebang correction {c['id']} matches no source row")
        if c["action"] == "swap_ritasi_tonase":
            df.loc[hit, ["tonase_parsed", "ritasi"]] = df.loc[hit, ["ritasi", "tonase_parsed"]].to_numpy()
        elif c["action"] == "set_tonase":
            if int(hit.sum()) != 1:
                raise ValueError(f"Bantargebang correction {c['id']} must match exactly one row")
            current = float(df.loc[hit, "tonase_parsed"].iloc[0])
            if abs(current - float(c["from_tonase"])) > 1e-6:
                raise ValueError(
                    f"Bantargebang correction {c['id']}: source tonase is {current}, expected "
                    f"{c['from_tonase']}. The source changed; review the correction before training."
                )
            df.loc[hit, "tonase_parsed"] = float(c["to_tonase"])
        else:
            raise ValueError(f"unknown Bantargebang correction action {c['action']!r}")
        applied.append({
            "id": c["id"], "periode_data": c["periode_data"], "action": c["action"],
            "rows": int(hit.sum()), "status": c["status"], "flag": c.get("flag"),
        })
    df.attrs["corrections_applied"] = applied
    return df


def check_tonnes_per_trip(rows: pd.DataFrame, lo: float, hi: float) -> None:
    """Every source row must carry a plausible tonnes-per-trip ratio, or training stops."""
    tpt = rows["tonase_parsed"] / rows["ritasi"]
    bad = rows[~tpt.between(lo, hi)]
    if bad.empty:
        return
    detail = "; ".join(
        f"{r.periode_data} {_norm_source_name(r.instansi_asal_kendaraan)}: "
        f"{r.tonase_parsed / r.ritasi if r.ritasi else float('nan'):.2f} t/trip"
        for r in bad.itertuples()
    )
    raise ValueError(
        f"Bantargebang sanity check failed: {len(bad)} row(s) outside {lo}-{hi} t per trip ({detail}). "
        f"Fix the source or add an explicit, documented entry to {CORRECTIONS_JSON.name}."
    )


def load_bantargebang_rows(apply_corrections: bool = True, csv_path: Path = BANTARGEBANG_CSV,
                           corrections_path: Path = CORRECTIONS_JSON) -> pd.DataFrame:
    """Source rows with parsed tonnes; corrected and sanity-checked unless told otherwise."""
    df = pd.read_csv(csv_path, dtype={"periode_data": str})
    df["tonase_parsed"] = df["tonase"].map(parse_tonase)
    df["ritasi"] = pd.to_numeric(df["ritasi"], errors="coerce")
    assert df["tonase_parsed"].isna().sum() == 0, "parse_tonase failed on some rows"
    if not apply_corrections:
        df.attrs["corrections_applied"] = []
        return df
    corrections = load_bantargebang_corrections(corrections_path)
    df = apply_bantargebang_corrections(df, corrections)
    bounds = corrections["sanity_check"]
    check_tonnes_per_trip(df, bounds["min_tonnes_per_trip"], bounds["max_tonnes_per_trip"])
    return df


def load_bantargebang_monthly(apply_corrections: bool = True, csv_path: Path = BANTARGEBANG_CSV,
                              corrections_path: Path = CORRECTIONS_JSON) -> pd.DataFrame:
    """Monthly landfill intake on a full monthly range: a month absent from the source is NaN."""
    rows = load_bantargebang_rows(apply_corrections, csv_path, corrections_path)
    totals = rows.groupby("periode_data")["tonase_parsed"].sum()
    totals.index = pd.to_datetime(totals.index, format="%Y%m")
    full = pd.date_range(totals.index.min(), totals.index.max(), freq="MS")
    monthly = pd.DataFrame({"month": full, "periode_data": full.strftime("%Y%m"),
                            "total_tons_month": totals.reindex(full).to_numpy()})
    monthly["days_in_month"] = monthly["month"].dt.days_in_month
    monthly["tons_per_day"] = monthly["total_tons_month"] / monthly["days_in_month"]
    monthly["is_gap"] = monthly["tons_per_day"].isna()
    monthly.attrs["corrections_applied"] = rows.attrs.get("corrections_applied", [])
    gaps = monthly.loc[monthly["is_gap"], "periode_data"].tolist()
    print(f"[Bantargebang] {len(monthly)} months {full.min():%Y-%m}..{full.max():%Y-%m}; "
          f"corrections {[c['id'] for c in monthly.attrs['corrections_applied']]}; gaps {gaps}")
    return monthly


def bantargebang_series(monthly: pd.DataFrame) -> pd.Series:
    """t/day indexed by month start; NaN marks a month missing from the source."""
    return pd.Series(monthly["tons_per_day"].to_numpy(), index=pd.DatetimeIndex(monthly["month"]),
                     name="tons_per_day")


def fill_gaps(y: pd.Series) -> pd.Series:
    """Model input only: interpolate interior gaps. Gap months are never scored."""
    return y.interpolate(limit_area="inside")


CITY_KEYS = ("PUSAT", "UTARA", "BARAT", "SELATAN", "TIMUR")
# From 2024-02 'Sampah Pasar' is no longer reported on its own and is folded into the
# city rows (structural break), so per-city series are only comparable from then on.
CITY_SERIES_START = "2024-02-01"


def _source_city(name) -> str | None:
    s = _norm_source_name(name)
    for city in CITY_KEYS:
        if re.search(rf"\b{city}\b", s):
            return city
    return None


def load_bantargebang_city_monthly() -> pd.DataFrame:
    """Per-city (5 Sudin incl. their market streams) intake in t/day, CITY_SERIES_START onward."""
    rows = load_bantargebang_rows()
    rows["city"] = rows["instansi_asal_kendaraan"].map(_source_city)
    rows = rows.dropna(subset=["city"])
    rows["month"] = pd.to_datetime(rows["periode_data"], format="%Y%m")
    piv = rows.pivot_table(index="month", columns="city", values="tonase_parsed", aggfunc="sum")
    piv = piv.reindex(pd.date_range(piv.index.min(), piv.index.max(), freq="MS"))
    piv = piv.div(piv.index.days_in_month, axis=0)
    return piv.loc[CITY_SERIES_START:, list(CITY_KEYS)]


def build_monthly_intake_index() -> dict[tuple[int, int], float]:
    """Real month-to-month variation for the synthetic daily builder (cleaned source).

    Uses the corrected series; the 2023-12 source gap is interpolated (input only).
    """
    y = fill_gaps(bantargebang_series(load_bantargebang_monthly())).dropna()
    overall = y.mean()
    idx = {(d.year, d.month): float(v / overall) for d, v in y.items()}
    print(f"[Monthly index] {len(idx)} months, "
          f"range {min(idx.values()):.2f}..{max(idx.values()):.2f}")
    return idx


# ── Monthly calendar model (Ramadan + Lebaran exodus) on the REAL landfill series ──
MUDIK_WINDOW_DAYS = (7, 7)        # Idul Fitri -7..+7 days, fixed a priori
RAMADAN_DAYS = 30                 # the 30 days before Idul Fitri, minus the mudik window
CALENDAR_RIDGE = 0.05             # light ridge on the two calendar coefficients (log scale)
MONTHLY_LEVEL_MONTHS = 12         # level = mean of the last 12 calendar-adjusted months
BACKTEST_MIN_TRAIN = 18           # first origin after 18 months of history
BACKTEST_MAX_H = 3                # horizons 1..3 months ahead
CITY_BACKTEST_MIN_TRAIN = 12
BOOTSTRAP_RESAMPLES = 3000
BOOTSTRAP_SEED = 7
NAIVE_BASELINES = ("naive_last", "seasonal_naive_12", "ma3", "ma6", "ma12", "expanding_mean")
MONTHLY_MODEL_NAME = "ma12_calendar"
SENSITIVITY_WINDOWS = ((7, 7), (3, 3), (3, 7), (7, 3), (10, 10), (14, 7), (0, 0))
SENSITIVITY_STARTS = (12, 18, 24)


def load_idul_fitri_dates(path: Path = IDUL_FITRI_JSON) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["dates"]


def month_calendar_features(months, eid_dates, window=MUDIK_WINDOW_DAYS) -> pd.DataFrame:
    """Fraction of each month's days in Ramadan (`ram`) and in the mudik window (`mud`).

    Idul Fitri dates are published in advance, so these are known at forecast time.
    Mirrored by app.forecast.engine.monthly_calendar_features (parity-tested).
    """
    months = pd.DatetimeIndex(months)
    before, after = window
    days = pd.date_range(months.min(), months.max() + pd.offsets.MonthEnd(0), freq="D")
    ram = np.zeros(len(days))
    mud = np.zeros(len(days))
    for e in pd.to_datetime(list(eid_dates)):
        mud[(days >= e - pd.Timedelta(days=before)) & (days <= e + pd.Timedelta(days=after))] = 1.0
        ram[(days >= e - pd.Timedelta(days=RAMADAN_DAYS)) & (days < e - pd.Timedelta(days=before))] = 1.0
    feats = pd.DataFrame({"ram": ram, "mud": mud}, index=days).resample("MS").mean()
    return feats.reindex(months)


def calendar_coefficients(y: pd.Series, eid_dates, window=MUDIK_WINDOW_DAYS,
                          ridge: float = CALENDAR_RIDGE) -> np.ndarray:
    """[c, a, b] of log y = c + a*ram + b*mud, ridge on a and b only."""
    cal = month_calendar_features(y.index, eid_dates, window)
    X = np.column_stack([np.ones(len(y)), cal["ram"], cal["mud"]])
    lam = np.diag([0.0, 1.0, 1.0]) * ridge
    return np.linalg.solve(X.T @ X + lam, X.T @ np.log(y.to_numpy()))


def ma_calendar_forecast(train: pd.Series, future, eid_dates, window=MUDIK_WINDOW_DAYS,
                         k: int = MONTHLY_LEVEL_MONTHS, beta: np.ndarray | None = None) -> np.ndarray:
    """MA-k of calendar-adjusted log intake, with the calendar effect re-applied per future month."""
    if beta is None:
        beta = calendar_coefficients(train, eid_dates, window)
    cal = month_calendar_features(train.index, eid_dates, window)
    adj = np.log(train.to_numpy()) - beta[1] * cal["ram"].to_numpy() - beta[2] * cal["mud"].to_numpy()
    cf = month_calendar_features(future, eid_dates, window)
    return np.exp(adj[-k:].mean() + beta[1] * cf["ram"].to_numpy() + beta[2] * cf["mud"].to_numpy())


def naive_forecasts(train: pd.Series, future) -> dict[str, np.ndarray]:
    """The simple baselines the model has to beat (the strongest one is reported)."""
    n = len(future)
    last = float(train.iloc[-1])
    return {
        "naive_last": np.full(n, last),
        "seasonal_naive_12": np.array([float(train.get(d - pd.DateOffset(years=1), last)) for d in future]),
        "ma3": np.full(n, train.iloc[-3:].mean()),
        "ma6": np.full(n, train.iloc[-6:].mean()),
        "ma12": np.full(n, train.iloc[-12:].mean()),
        "expanding_mean": np.full(n, train.mean()),
    }


def _prophet_previous_config(train: pd.Series, future) -> np.ndarray:
    """The superseded monthly Prophet (default yearly Fourier order 10), kept for comparison."""
    m = Prophet(yearly_seasonality=True, weekly_seasonality=False, daily_seasonality=False,
                uncertainty_samples=0)
    m.fit(pd.DataFrame({"ds": train.index, "y": train.to_numpy()}))
    return m.predict(pd.DataFrame({"ds": future}))["yhat"].to_numpy()


def rolling_origin_backtest(y: pd.Series, eid_dates, *, min_train: int = BACKTEST_MIN_TRAIN,
                            max_h: int = BACKTEST_MAX_H, window=MUDIK_WINDOW_DAYS,
                            extra_models: dict | None = None) -> pd.DataFrame:
    """Every model sees only months before the origin; gap months are never scored."""
    yf = fill_gaps(y)
    recs = []
    for o in range(min_train, len(y)):
        train = yf.iloc[:o]
        future = y.index[o:o + max_h]
        preds = naive_forecasts(train, future)
        preds[MONTHLY_MODEL_NAME] = ma_calendar_forecast(train, future, eid_dates, window)
        for name, fn in (extra_models or {}).items():
            preds[name] = fn(train, future)
        for name, p in preds.items():
            for h, (d, v) in enumerate(zip(future, p, strict=True), 1):
                if not np.isnan(y.loc[d]):
                    recs.append({"origin": f"{y.index[o]:%Y-%m}", "h": h, "month": f"{d:%Y-%m}",
                                 "model": name, "pred": float(v), "actual": float(y.loc[d])})
    return pd.DataFrame(recs)


def city_month_backtest(city: pd.DataFrame, total: pd.Series, eid_dates, *,
                        min_train: int = CITY_BACKTEST_MIN_TRAIN, max_h: int = BACKTEST_MAX_H,
                        window=MUDIK_WINDOW_DAYS) -> pd.DataFrame:
    """Per-city backtest; calendar coefficients pooled from the total series at the same cut-off."""
    total = fill_gaps(total)
    recs = []
    for o in range(min_train, len(city)):
        future = city.index[o:o + max_h]
        beta = calendar_coefficients(total.loc[:city.index[o - 1]], eid_dates, window)
        for name in city.columns:
            train = city[name].iloc[:o]
            preds = naive_forecasts(train, future)
            preds[MONTHLY_MODEL_NAME] = ma_calendar_forecast(train, future, eid_dates, window, beta=beta)
            for model, p in preds.items():
                for h, (d, v) in enumerate(zip(future, p, strict=True), 1):
                    recs.append({"origin": f"{city.index[o]:%Y-%m}", "city": name, "h": h,
                                 "month": f"{d:%Y-%m}", "model": model, "pred": float(v),
                                 "actual": float(city.loc[d, name])})
    return pd.DataFrame(recs)


def cluster_bootstrap_skill(err_model: np.ndarray, err_ref: np.ndarray, months: np.ndarray,
                            n_boot: int = BOOTSTRAP_RESAMPLES, seed: int = BOOTSTRAP_SEED) -> tuple[float, float]:
    """90% interval (p5, p95) of the MAE skill in percent, resampling whole target months.

    Forecasts of the same month at h = 1..3 are correlated, so they move together.
    """
    rng = np.random.default_rng(seed)
    groups = [np.where(months == m)[0] for m in np.unique(months)]
    skills = np.empty(n_boot)
    for i in range(n_boot):
        idx = np.concatenate([groups[j] for j in rng.integers(0, len(groups), len(groups))])
        skills[i] = 1.0 - err_model[idx].mean() / err_ref[idx].mean()
    return float(100 * np.percentile(skills, 5)), float(100 * np.percentile(skills, 95))


def _r(x: float, nd: int = 2) -> float:
    return round(float(x), nd)


def summarize_backtest(fc: pd.DataFrame, eid_dates, *, keys=("origin", "h", "month"),
                       window=MUDIK_WINDOW_DAYS, model: str = MONTHLY_MODEL_NAME,
                       naive_names=NAIVE_BASELINES, seed: int = BOOTSTRAP_SEED) -> dict:
    """Score the model against the STRONGEST naive baseline (lowest pooled MAE)."""
    keys = list(keys)
    piv = fc.pivot_table(index=keys, columns="model", values="pred")
    act = fc.groupby(keys)["actual"].first().loc[piv.index]
    err = piv.sub(act, axis=0).abs()
    ape = err.div(act, axis=0)
    best = min((n for n in naive_names if n in err), key=lambda n: err[n].mean())
    months = err.index.get_level_values("month").to_numpy()
    p5, p95 = cluster_bootstrap_skill(err[model].to_numpy(), err[best].to_numpy(), months, seed=seed)
    month_idx = pd.DatetimeIndex(sorted({pd.Timestamp(m + "-01") for m in months}))
    cal = month_calendar_features(month_idx, eid_dates, window)
    affected = {f"{d:%Y-%m}" for d, r in cal.iterrows() if r["ram"] > 0 or r["mud"] > 0}

    def block(mask) -> dict:
        e_m, e_n = err.loc[mask, model], err.loc[mask, best]
        return {"n_forecasts": int(mask.sum()), "mae_model": _r(e_m.mean()), "mae_naive": _r(e_n.mean()),
                "skill_pct": _r(100 * (1 - e_m.mean() / e_n.mean()), 1)}

    in_cal = np.isin(months, sorted(affected))
    horizons = err.index.get_level_values("h").to_numpy()
    origins = sorted(set(err.index.get_level_values("origin")))
    table = []
    for name in sorted(err.columns, key=lambda n: err[n].mean()):
        kind = "model" if name == model else "naive" if name in naive_names else "superseded"
        table.append({"name": name, "kind": kind, "mae": _r(err[name].mean()),
                      "mape_pct": _r(100 * ape[name].mean()),
                      "skill_vs_strongest_naive_pct": _r(100 * (1 - err[name].mean() / err[best].mean()), 1)})
    return {
        "model": model,
        "strongest_naive": best,
        "origins": len(origins),
        "first_origin": origins[0],
        "last_origin": origins[-1],
        "horizons_months": sorted(int(h) for h in set(horizons)),
        "n_forecasts": len(err),
        "n_target_months": len(set(months)),
        "mae_model": _r(err[model].mean()),
        "mae_naive": _r(err[best].mean()),
        "mape_model_pct": _r(100 * ape[model].mean()),
        "mape_naive_pct": _r(100 * ape[best].mean()),
        "skill_pct": _r(100 * (1 - err[model].mean() / err[best].mean()), 1),
        "skill_ci90_pct": [_r(p5, 1), _r(p95, 1)],
        "ci_method": f"cluster bootstrap over target months, {BOOTSTRAP_RESAMPLES} resamples, seed {seed}",
        "by_horizon": [{"h": int(h), **block(horizons == h)} for h in sorted(set(horizons))],
        "calendar_months": {"months": sorted(affected & set(months)), **block(in_cal)},
        "normal_months": block(~in_cal),
        "models": table,
    }


def sensitivity_analysis(y: pd.Series, eid_dates) -> list[dict]:
    """Robustness of the result to the mudik window and the first origin ((0, 0) = ablation)."""
    rows = []
    for window in SENSITIVITY_WINDOWS:
        for start in SENSITIVITY_STARTS:
            s = summarize_backtest(rolling_origin_backtest(y, eid_dates, min_train=start, window=window),
                                   eid_dates, window=window)
            rows.append({"mudik_window_days": list(window), "min_train_months": start,
                         "origins": s["origins"], "strongest_naive": s["strongest_naive"],
                         "mae_model": s["mae_model"], "mae_naive": s["mae_naive"],
                         "skill_pct": s["skill_pct"], "skill_ci90_pct": s["skill_ci90_pct"]})
            print(f"  [sensitivity] window {window} start {start}: {s['skill_pct']:+.1f}% "
                  f"{s['skill_ci90_pct']} vs {s['strongest_naive']}")
    return rows


def fit_monthly_calendar_model(y: pd.Series, eid_records: list[dict], window=MUDIK_WINDOW_DAYS) -> dict:
    """Fit on all cleaned months (gap interpolated as input); the serving contract for engine.py."""
    yf = fill_gaps(y).dropna()
    eid = [r["date"] for r in eid_records]
    beta = calendar_coefficients(yf, eid, window)
    cal = month_calendar_features(yf.index, eid, window)
    adj = np.log(yf.to_numpy()) - beta[1] * cal["ram"].to_numpy() - beta[2] * cal["mud"].to_numpy()
    return {
        "schema": "pythia.monthly_calendar_model/1",
        "model": MONTHLY_MODEL_NAME,
        "target": "Bantargebang landfill intake, mean tonnes per day per month (real, data.go.id)",
        "unit": "t/day",
        "classification": "MODEL OUTPUT",
        "formula": "t/day = exp(level_log + a_ramadan * ramadan_fraction + b_mudik * mudik_fraction)",
        "intercept": round(float(beta[0]), 6),
        "a_ramadan": round(float(beta[1]), 6),
        "b_mudik": round(float(beta[2]), 6),
        "level_log": round(float(adj[-MONTHLY_LEVEL_MONTHS:].mean()), 6),
        "level_months": MONTHLY_LEVEL_MONTHS,
        "ridge_lambda": CALENDAR_RIDGE,
        "mudik_window_days": list(window),
        "ramadan_days": RAMADAN_DAYS,
        "fitted_from": f"{yf.index.min():%Y-%m}",
        "fitted_through": f"{yf.index.max():%Y-%m}",
        "n_months": int(len(yf)),
        "gap_months": [f"{d:%Y-%m}" for d in y.index[y.isna()]],
        "idul_fitri": [{"date": r["date"], "verified": bool(r["verified"]), "status": r["status"]}
                       for r in eid_records],
        "backtested_horizon_months": list(range(1, BACKTEST_MAX_H + 1)),
        "validation": "rolling-origin backtest on real Bantargebang intake",
        "evaluation_file": EVALUATION_OUT.name,
        "generated_by": "ml/scripts/train_models.py",
    }


def run_monthly_pipeline(include_previous_prophet: bool = True) -> tuple[dict, dict]:
    """Clean the real series, backtest, fit and write the two JSON artifacts the API reads."""
    monthly = load_bantargebang_monthly()
    y = bantargebang_series(monthly)
    eid_records = load_idul_fitri_dates()
    eid = [r["date"] for r in eid_records]
    extra = {"prophet_previous_config": _prophet_previous_config} if include_previous_prophet else None
    print("[Monthly] rolling-origin backtest (landfill):")
    landfill = summarize_backtest(rolling_origin_backtest(y, eid, extra_models=extra), eid)
    print(f"  {landfill['model']} MAE {landfill['mae_model']} vs {landfill['strongest_naive']} "
          f"{landfill['mae_naive']}: {landfill['skill_pct']:+.1f}% {landfill['skill_ci90_pct']}")
    print("[Monthly] rolling-origin backtest (5 cities):")
    city = summarize_backtest(city_month_backtest(load_bantargebang_city_monthly(), y, eid), eid,
                              keys=("origin", "city", "h", "month"))
    print(f"  {city['model']} MAE {city['mae_model']} vs {city['strongest_naive']} "
          f"{city['mae_naive']}: {city['skill_pct']:+.1f}% {city['skill_ci90_pct']}")
    sensitivity = sensitivity_analysis(y, eid)
    model = fit_monthly_calendar_model(y, eid_records)
    corrections = load_bantargebang_corrections()
    evaluation = {
        "schema": "pythia.forecast_evaluation/1",
        "generated_by": "ml/scripts/train_models.py",
        "data_cleaning": {
            "source_file": BANTARGEBANG_CSV.name,
            "corrections_file": CORRECTIONS_JSON.name,
            "corrections_applied": monthly.attrs["corrections_applied"],
            "missing_months": [m["periode_data"] for m in corrections.get("missing_months", [])],
            "tonnes_per_trip_bounds": [corrections["sanity_check"]["min_tonnes_per_trip"],
                                       corrections["sanity_check"]["max_tonnes_per_trip"]],
        },
        "resolutions": {
            "landfill_month": {
                "target": "Bantargebang landfill intake, t/day per month (total of all sources)",
                "target_class": "real",
                "unit": "t/day",
                "period": f"{y.index.min():%Y-%m}..{y.index.max():%Y-%m}",
                **landfill,
            },
            "city_month": {
                "target": "Bantargebang intake per city (5 Sudin incl. market streams), t/day per month",
                "target_class": "real",
                "unit": "t/day",
                "period": f"{CITY_SERIES_START[:7]}..{y.index.max():%Y-%m}",
                "cities": list(CITY_KEYS),
                "coefficients": "calendar coefficients pooled from the total series at each cut-off",
                "independence_note": "Same Lebaran events as landfill_month; not independent evidence.",
                **city,
            },
        },
        "sensitivity": sensitivity,
        "caveats": [
            "Few events: the backtest window holds 3 Lebaran events; one unusual year could erase the gain.",
            "The Lebaran-exodus hypothesis was chosen after seeing the series; the window was fixed a "
            "priori at +/-7 days and every alternative window keeps a positive lower bound, but the "
            "bias cannot be ruled out.",
            "The 2024-01 Jakarta Timur correction is an inference pending DLH confirmation.",
            "The 2023-2025 Idul Fitri dates are public record not yet cross-checked against the "
            "SKB documents (see idul_fitri_dates.json, verified flag).",
            "Daily and per-district targets are calibrated-synthetic: no accuracy is claimed for them.",
        ],
    }
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    MONTHLY_MODEL_OUT.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    EVALUATION_OUT.write_text(json.dumps(evaluation, indent=2) + "\n", encoding="utf-8")
    print(f"[Monthly] wrote {MONTHLY_MODEL_OUT.name} and {EVALUATION_OUT.name}")
    return model, evaluation


# ── Real daily features ────────────────────────────────────────────────────
def load_weather() -> pd.DataFrame:
    j = json.loads(WEATHER_JSON.read_text(encoding="utf-8"))
    d = j["daily"]
    df = pd.DataFrame({
        "date": pd.to_datetime(pd.Series(d["time"])),
        "precipitation_mm": pd.to_numeric(pd.Series(d["precipitation_sum"]), errors="coerce").fillna(0.0),
        "temp_max_c": pd.to_numeric(pd.Series(d["temperature_2m_max"]), errors="coerce"),
        "wind_max_kmh": pd.to_numeric(pd.Series(d["wind_speed_10m_max"]), errors="coerce"),
    })
    df["temp_max_c"] = df["temp_max_c"].ffill().bfill()
    df["wind_max_kmh"] = df["wind_max_kmh"].ffill().bfill()
    print(f"[Weather] {len(df)} days {df['date'].min():%Y-%m-%d}..{df['date'].max():%Y-%m-%d}")
    return df


def load_holiday_monthdays() -> set[tuple[int, int]]:
    j = json.loads(HOLIDAYS_JSON.read_text(encoding="utf-8"))
    return {(pd.to_datetime(it["date"]).month, pd.to_datetime(it["date"]).day)
            for it in j.get("data", [])}


def load_event_calendar_by_city() -> dict[tuple[str, pd.Timestamp], int]:
    """Expand real 2021-2026 events into {(city, date): daily_attendance}.

    Total-attendance rows are spread across the event's days. Partial/first-week
    rows are skipped to avoid double counting. City is the host kota_wilayah, so
    an event only lifts its own city's kecamatan.
    """
    df = pd.read_csv(EVENTS_CSV)
    out: dict[tuple[str, pd.Timestamp], int] = {}
    used = 0
    for _, r in df.iterrows():
        name = str(r.get("nama_event", "")).lower()
        if "first week" in name or "first 9" in name or "partial" in str(r.get("estimasi_type", "")).lower():
            continue
        att = pd.to_numeric(r.get("estimasi_pengunjung"), errors="coerce")
        if pd.isna(att) or att <= 0:
            continue
        city = str(r.get("kota_wilayah", "")).strip().title()
        if city not in SIPSN_CITY_MAP.values():
            continue
        start = pd.to_datetime(r.get("tanggal_mulai"), errors="coerce")
        end = pd.to_datetime(r.get("tanggal_selesai"), errors="coerce")
        if pd.isna(start):
            continue
        if pd.isna(end):
            end = start
        days = pd.date_range(start.normalize(), end.normalize(), freq="D")
        if len(days) == 0:
            continue
        daily = int(att / len(days))
        for d in days:
            key = (city, d)
            out[key] = max(out.get(key, 0), daily)
        used += 1
    n_days = len({d for (_c, d) in out})
    print(f"[Events] {used} events used -> {len(out)} city-days ({n_days} distinct dates)")
    return out


# ── Assemble daily per-kecamatan dataset ───────────────────────────────────
RAIN_3D_WINDOW_DAYS = 3


def rain_3d(precipitation_mm: pd.Series) -> pd.Series:
    """`rain_3d` feature: rolling 3-day rainfall SUM (mm) ending on the day.

    The API mirrors this for a constant-rain scenario as 3 x rain
    (app.forecast.engine.scenario_rain_3d; parity-tested).
    """
    return precipitation_mm.rolling(RAIN_3D_WINDOW_DAYS, min_periods=1).sum().round(2)


def build_dataset(weather, holiday_md, events_by_city, kec: pd.DataFrame,
                  growth_by_city, monthly_index) -> pd.DataFrame:
    w = weather.copy()
    w["is_weekend"] = (w["date"].dt.dayofweek >= 5).astype(int)
    w["is_holiday"] = [int((d.month, d.day) in holiday_md) for d in w["date"]]
    w["year"] = w["date"].dt.year
    # Richer real features for the residual model
    w["day_of_week"] = w["date"].dt.dayofweek
    w["month_of_year"] = w["date"].dt.month
    w["day_of_month"] = w["date"].dt.day
    w["is_payday"] = w["day_of_month"].isin([1, 2, 25, 26, 27, 28]).astype(int)
    w["rain_3d"] = rain_3d(w["precipitation_mm"])
    dates = w["date"].to_numpy()
    rain_arr = w["precipitation_mm"].to_numpy()
    weekend_arr = w["is_weekend"].to_numpy()
    year_arr = w["year"].to_numpy()

    growth = build_city_growth_series(growth_by_city, w["date"])
    month_idx = np.array([monthly_index.get((pd.Timestamp(d).year, pd.Timestamp(d).month), 1.0)
                          for d in dates])

    def spike(rain, att, weekend, payday):
        s = 0.0
        if rain >= 30: s += 0.16
        elif rain >= 10: s += 0.08
        if att >= 50_000: s += 0.18
        elif att >= 10_000: s += 0.09
        if weekend: s += 0.07
        if payday: s += 0.04
        return 1.0 + s

    rng = np.random.default_rng(42)
    NOISE_CV = 0.05

    rows = []
    for _, krow in kec.iterrows():
        slug, city, base23 = krow["slug"], krow["city"], krow["base_2023_tpd"]
        # Real 2023 spatial baseline * real city growth ratio * real monthly index.
        base_arr = base23 * growth[city] * month_idx
        att_arr = np.array([int(events_by_city.get((city, pd.Timestamp(d).normalize()), 0))
                            for d in dates])
        mult = np.array([spike(rain_arr[i], int(att_arr[i]), int(weekend_arr[i]),
                               int(w["is_payday"].iloc[i]))
                         for i in range(len(w))])
        noise = rng.lognormal(0.0, NOISE_CV, len(w))
        raw = base_arr * mult * noise
        # Mean-preserving per year (keeps real level, retains learnable daily signal).
        calib = raw.copy()
        for yr in np.unique(year_arr):
            m = year_arr == yr
            calib[m] = raw[m] * (base_arr[m].mean() / raw[m].mean())
        rows.append(pd.DataFrame({
            "date": w["date"].dt.strftime("%Y-%m-%d"),
            "kecamatan": slug, "city": city,
            "precipitation_mm": w["precipitation_mm"].round(2),
            "temp_max_c": w["temp_max_c"].round(2),
            "wind_max_kmh": w["wind_max_kmh"].round(2),
            "is_weekend": w["is_weekend"], "is_holiday": w["is_holiday"],
            "event_attendance": att_arr,
            "day_of_week": w["day_of_week"],
            "month_of_year": w["month_of_year"],
            "day_of_month": w["day_of_month"],
            "is_payday": w["is_payday"],
            "rain_3d": w["rain_3d"],
            "waste_tons": np.round(calib, 3),
            "waste_tons_source": "calibrated_synthetic_anchored_to_SILIKA_real",
        }))
    dataset = pd.concat(rows, ignore_index=True)
    print(f"[Dataset] {len(dataset):,} rows "
          f"({dataset['kecamatan'].nunique()} kecamatan x {dataset['date'].nunique()} days)")
    return dataset


# ── Train one kecamatan (backend contract) ─────────────────────────────────
def daily_naive_maes(train: pd.DataFrame, test: pd.DataFrame) -> dict[str, float]:
    """Simple daily baselines on the same rows; the report scores against the best one."""
    y = test["waste_tons"].to_numpy()
    last28 = train.tail(28)
    by_dow = last28.groupby(last28["ds"].dt.dayofweek)["waste_tons"].mean()
    preds = {
        "train_mean": np.full(len(y), train["waste_tons"].mean()),
        "ma28": np.full(len(y), last28["waste_tons"].mean()),
        "same_weekday_last4": test["ds"].dt.dayofweek.map(by_dow).to_numpy(dtype=float),
    }
    return {name: float(mean_absolute_error(y, p)) for name, p in preds.items()}


def _best_naive(maes: dict[str, float]) -> tuple[str, float]:
    name = min(maes, key=maes.get)
    return name, maes[name]


def train_one(slug: str, df_k: pd.DataFrame) -> dict:
    df_k = df_k.sort_values("date").reset_index(drop=True)
    df_k["ds"] = pd.to_datetime(df_k["date"])
    n = len(df_k)
    split = int(n * 0.8)
    train, test = df_k.iloc[:split].copy(), df_k.iloc[split:].copy()

    prophet = Prophet(weekly_seasonality=True, yearly_seasonality=True,
                      daily_seasonality=False)
    prophet.fit(train[["ds"]].assign(y=train["waste_tons"]))
    yhat_tr = prophet.predict(train[["ds"]])["yhat"].to_numpy()
    yhat_te = prophet.predict(test[["ds"]])["yhat"].to_numpy()

    xgb = XGBRegressor(n_estimators=500, max_depth=6, learning_rate=0.03,
                       subsample=0.85, colsample_bytree=0.85, min_child_weight=3,
                       reg_alpha=0.1, reg_lambda=1.0, random_state=42, n_jobs=0)
    xgb.fit(train[FEATURE_ORDER].astype(float), train["waste_tons"].to_numpy() - yhat_tr)

    hybrid = yhat_te + xgb.predict(test[FEATURE_ORDER].astype(float))
    y_te = test["waste_tons"].to_numpy()
    joblib.dump(prophet, MODELS_DIR / f"prophet_{slug}.joblib")
    joblib.dump(xgb, MODELS_DIR / f"xgboost_{slug}.joblib")
    naive_name, naive_mae = _best_naive(daily_naive_maes(train, test))
    return {
        "kecamatan": slug, "city": df_k["city"].iloc[0],
        "n_train": split, "n_test": n - split,
        "mae": float(mean_absolute_error(y_te, hybrid)),
        "best_naive": naive_name, "mae_naive": naive_mae,
        "mean_tons": float(df_k["waste_tons"].mean()),
    }


def walk_forward_backtest(dataset: pd.DataFrame, slugs: list[str]) -> list[dict]:
    df = dataset.copy()
    df["ds"] = pd.to_datetime(df["date"])
    df["year"] = df["ds"].dt.year
    years = sorted(df["year"].unique())
    folds = []
    for test_year in years[1:]:
        yt_all, yp_all = [], []
        naive_err: dict[str, list[float]] = {}
        for slug in slugs:
            dk = df[df["kecamatan"] == slug]
            tr = dk[dk["year"] < test_year]
            te = dk[dk["year"] == test_year]
            if len(tr) < 180 or te.empty:
                continue
            pm = Prophet(weekly_seasonality=True, yearly_seasonality=True, daily_seasonality=False)
            pm.fit(tr[["ds"]].assign(y=tr["waste_tons"]))
            ytr = pm.predict(tr[["ds"]])["yhat"].to_numpy()
            yte = pm.predict(te[["ds"]])["yhat"].to_numpy()
            xg = XGBRegressor(n_estimators=500, max_depth=6, learning_rate=0.03,
                              subsample=0.85, colsample_bytree=0.85, min_child_weight=3,
                              reg_alpha=0.1, reg_lambda=1.0, random_state=42, n_jobs=0)
            xg.fit(tr[FEATURE_ORDER].astype(float), tr["waste_tons"].to_numpy() - ytr)
            pred = yte + xg.predict(te[FEATURE_ORDER].astype(float))
            yt_all.extend(te["waste_tons"]); yp_all.extend(pred)
            for name, m in daily_naive_maes(tr, te).items():
                naive_err.setdefault(name, []).append(m * len(te))  # sum of abs errors
        if not yt_all:
            continue
        yt, yp = np.array(yt_all), np.array(yp_all)
        naive_name, naive_mae = _best_naive({k: sum(v) / len(yt) for k, v in naive_err.items()})
        folds.append({"test_year": int(test_year), "n": len(yt),
                      "mae": float(mean_absolute_error(yt, yp)),
                      "best_naive": naive_name, "mae_naive": naive_mae})
        print(f"  [walk-forward] {test_year}: MAE={folds[-1]['mae']:.2f} "
              f"(best naive {naive_name} {naive_mae:.2f})")
    return folds


def backup_existing_models(slugs: list[str]) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    for f in MODELS_DIR.glob("*.joblib"):
        dst = BACKUP_DIR / f.name
        if not dst.exists():
            shutil.copy2(f, dst); moved += 1
    print(f"[Backup] copied {moved} existing model files -> {BACKUP_DIR}")


def _skill(model_mae: float, naive_mae: float) -> float:
    return (naive_mae - model_mae) / naive_mae * 100 if naive_mae else 0.0


def write_report(results, evaluation, date_range, n_rows, kec, wf_folds):
    avg_mae = float(np.mean([r["mae"] for r in results]))
    lf = evaluation["resolutions"]["landfill_month"]
    cm = evaluation["resolutions"]["city_month"]
    L = []
    L.append("# Pythia Forecaster — Evaluation Report (Case 2)\n")
    L.append("_Auto-generated by `ml/scripts/train_models.py`. Re-run to reproduce. "
             "Machine-readable copy: `apps/api/data/models/forecast_evaluation.json`._\n")
    L.append("## What is validated, and on what\n")
    L.append(
        "- **Validated on REAL data:** the monthly landfill-intake forecaster (Bantargebang, "
        "t/day per month, total and per city), by rolling-origin backtest 1-3 months ahead "
        "against the strongest simple baseline.\n"
        "- **NOT validated:** daily and per-kecamatan forecasts. Their target is "
        "calibrated-synthetic (generated by this script from SILIKA 2023 x SIPSN growth x the "
        "Bantargebang month index x hand-set rain/event/weekend/payday multipliers x ~5% "
        "lognormal noise). Scores on it measure agreement with the generator, not real-world "
        "accuracy, and are reported below only for transparency.\n")
    L.append("## Monthly landfill intake — rolling-origin backtest (REAL target)\n")
    dc = evaluation["data_cleaning"]
    L.append(
        f"- Target: {lf['target']}, {lf['period']} (source `{dc['source_file']}`, data.go.id).\n"
        f"- Source cleaning (explicit, `ml/data/real/{dc['corrections_file']}`): "
        + "; ".join(f"{c['id']} ({c['status']})" for c in dc["corrections_applied"])
        + f". Missing month(s) {', '.join(dc['missing_months'])} kept as gaps: interpolated "
          "for model input only, never scored. Every row must run "
          f"{dc['tonnes_per_trip_bounds'][0]}-{dc['tonnes_per_trip_bounds'][1]} t per trip.\n"
        f"- Model: 12-month average of calendar-adjusted log intake, with a Ramadan and "
        f"Lebaran-exodus (Idul Fitri -7..+7 days) adjustment (`{lf['model']}`).\n"
        f"- Origins: **{lf['origins']}** ({lf['first_origin']} .. {lf['last_origin']}), horizons "
        f"{lf['horizons_months']} months, **{lf['n_forecasts']}** forecasts. Each model sees only "
        "months before the origin.\n"
        f"- Strongest naive baseline: **{lf['strongest_naive']}**.\n")
    L.append("| Model | Kind | MAE (t/day) | MAPE | Skill vs strongest naive |")
    L.append("|---|---|--:|--:|--:|")
    for m in lf["models"]:
        L.append(f"| {m['name']} | {m['kind']} | {m['mae']:,.1f} | {m['mape_pct']:.2f}% | "
                 f"{m['skill_vs_strongest_naive_pct']:+.1f}% |")
    L.append("")
    L.append(f"Skill of `{lf['model']}` vs `{lf['strongest_naive']}`: **{lf['skill_pct']:+.1f}%**, "
             f"90% interval [{lf['skill_ci90_pct'][0]:+.1f}%, {lf['skill_ci90_pct'][1]:+.1f}%] "
             f"({lf['ci_method']}). By horizon: "
             + ", ".join(f"h{b['h']} {b['skill_pct']:+.1f}%" for b in lf["by_horizon"]) + ".\n")
    L.append(f"Where the skill comes from: Ramadan/Lebaran months ({', '.join(lf['calendar_months']['months'])}) "
             f"{lf['calendar_months']['skill_pct']:+.1f}% (n={lf['calendar_months']['n_forecasts']}); "
             f"all other months {lf['normal_months']['skill_pct']:+.1f}% "
             f"(n={lf['normal_months']['n_forecasts']}).\n")
    L.append("`prophet_previous_config` is the superseded monthly Prophet (default yearly "
             "seasonality on ~30 monthly points). Its old single-split result (516.6 vs 423.1 t/day) "
             "came from corrupted source rows and that over-fitted configuration and is superseded.\n")
    L.append("### Per city (5 Sudin), REAL target\n")
    L.append(f"- Period {cm['period']}, {cm['origins']} origins x {len(cm['cities'])} cities, "
             f"{cm['n_forecasts']} forecasts; {cm['coefficients']}.\n"
             f"- `{cm['model']}` MAE {cm['mae_model']:,.1f} vs `{cm['strongest_naive']}` "
             f"{cm['mae_naive']:,.1f} t/day: **{cm['skill_pct']:+.1f}%** "
             f"[{cm['skill_ci90_pct'][0]:+.1f}%, {cm['skill_ci90_pct'][1]:+.1f}%]. "
             f"{cm['independence_note']}\n")
    L.append("### Robustness (mudik window x first origin; (0, 0) = no mudik window)\n")
    L.append("| Window (days before, after) | Min train months | Origins | Skill vs strongest naive | 90% interval |")
    L.append("|---|--:|--:|--:|---|")
    for s in evaluation["sensitivity"]:
        L.append(f"| {tuple(s['mudik_window_days'])} | {s['min_train_months']} | {s['origins']} | "
                 f"{s['skill_pct']:+.1f}% | [{s['skill_ci90_pct'][0]:+.1f}, {s['skill_ci90_pct'][1]:+.1f}] |")
    L.append("")
    L.append("### Caveats\n")
    L.extend(f"- {c}" for c in evaluation["caveats"])
    L.append("")
    L.append("## Daily per-kecamatan hybrid (Prophet + XGBoost) — SYNTHETIC target, NOT validation\n")
    L.append(
        "Every score in this section is on the calibrated-synthetic daily series with the "
        "realized (oracle) weather of the scored days as input; at serving time the engine has "
        "only scenario weather. Baseline = the best of three naive forecasts on the same rows "
        "(train mean, last-28-day mean, mean of the last 4 same weekdays). No accuracy claim "
        "follows from these numbers.\n")
    if wf_folds:
        L.append("### Walk-forward by year (synthetic target, oracle weather)\n")
        L.append("| Test year | Days | MAE (t) | Best naive | Naive MAE (t) | Skill vs best naive |")
        L.append("|---|--:|--:|---|--:|--:|")
        for f in wf_folds:
            L.append(f"| {f['test_year']} | {f['n']:,} | {f['mae']:.2f} | {f['best_naive']} | "
                     f"{f['mae_naive']:.2f} | {_skill(f['mae'], f['mae_naive']):+.1f}% |")
        L.append("")
    L.append("### Per-kecamatan last-20% split (synthetic target, oracle weather)\n")
    L.append("| Kecamatan | City | MAE (t) | Best naive | Naive MAE (t) | Skill vs best naive |")
    L.append("|---|---|--:|---|--:|--:|")
    for r in sorted(results, key=lambda x: x["city"]):
        L.append(f"| {r['kecamatan'].replace('_', ' ').title()} | {r['city']} | {r['mae']:.2f} | "
                 f"{r['best_naive']} | {r['mae_naive']:.2f} | {_skill(r['mae'], r['mae_naive']):+.1f}% |")
    L.append(f"| **AVERAGE** | — | **{avg_mae:.2f}** | — | — | — |\n")
    L.append("Hotspot ranking: ranking the synthetic series by mean reproduces the SILIKA 2023 "
             "(modelled) per-kecamatan input ranking by construction, so it is not evidence of "
             "forecast skill.\n")
    L.append("## Reproducibility\n")
    L.append(f"- Training window: **{date_range[0]} .. {date_range[1]}** ({n_rows:,} kecamatan-day rows).\n"
             "- Command: `python ml/scripts/train_models.py` from the repository root "
             "(`--monthly-only` refreshes just the monthly model and its evaluation).\n"
             f"- Outputs: {len(kec)}× prophet + {len(kec)}× xgboost, `monthly_calendar_model.json` and "
             "`forecast_evaluation.json` in `apps/api/data/models/` (old models backed up to "
             "`_synthetic_backup/`), this report, and `data/processed/training_dataset_kecamatan.csv`.\n")
    REPORT_OUT.write_text("\n".join(L), encoding="utf-8")
    print(f"[Report] wrote {REPORT_OUT}")


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--monthly-only", action="store_true",
                        help="only rebuild monthly_calendar_model.json and forecast_evaluation.json")
    args = parser.parse_args(argv)

    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    _model, evaluation = run_monthly_pipeline()
    if args.monthly_only:
        return

    kec = load_kecamatan_baseline()
    slugs = kec["slug"].tolist()
    growth_by_city = load_sipsn_baselines_by_year()
    monthly_index = build_monthly_intake_index()
    weather = load_weather()
    holiday_md = load_holiday_monthdays()
    events_by_city = load_event_calendar_by_city()

    dataset = build_dataset(weather, holiday_md, events_by_city, kec, growth_by_city, monthly_index)
    dataset.to_csv(DATASET_OUT, index=False)
    print(f"[Dataset] wrote {DATASET_OUT}")

    backup_existing_models(slugs)

    results = []
    for slug in slugs:
        results.append(train_one(slug, dataset[dataset["kecamatan"] == slug]))
    print(f"[Train] {len(results)} kecamatan models written")

    print("[Backtest] walk-forward (synthetic target):")
    wf = walk_forward_backtest(dataset, slugs)

    date_range = (dataset["date"].min(), dataset["date"].max())
    write_report(results, evaluation, date_range, len(dataset), kec, wf)

    lf = evaluation["resolutions"]["landfill_month"]
    print("\n" + "=" * 60)
    print("CASE 2 TRAINING COMPLETE")
    print(f"  monthly (REAL)   : {lf['model']} {lf['skill_pct']:+.1f}% vs {lf['strongest_naive']} "
          f"{lf['skill_ci90_pct']} over {lf['origins']} origins")
    print(f"  kecamatan models : {len(results)} (synthetic target, not validated)")
    print(f"  rows             : {len(dataset):,}")
    print(f"  date range       : {date_range[0]} .. {date_range[1]}")
    print("=" * 60)


if __name__ == "__main__":
    main()
