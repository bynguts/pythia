"""Refit the monthly Bantargebang intake model at startup when DLH publishes a new month.

The committed artifact (monthly_calendar_model.json) knows its `fitted_through` month.
When the real weighing dataset holds a later month, the model is refitted in-process with
the training script's own cleaning and fitting functions (ml/scripts/train_models.py: the
correction table, the tonnes-per-trip check and `fit_monthly_calendar_model`), so serving
never re-implements training. The comparison is on the data's months, not file times, so a
fresh checkout does not trigger a refit. The refit lives in memory; the backtest error the
API reports stays the one the training script measured (its period says up to when).
"""

from __future__ import annotations

import csv
import importlib.util
import logging
import time
from pathlib import Path
from types import ModuleType
from typing import Any

from app.core import paths
from app.forecast import engine

logger = logging.getLogger(__name__)


def latest_observed_month(csv_path: Path) -> str | None:
    """The last `periode_data` month (YYYY-MM) in the weighing dataset, or None."""
    try:
        with csv_path.open(encoding="utf-8-sig", newline="") as handle:
            periods = [row.get("periode_data", "").strip() for row in csv.DictReader(handle)]
    except OSError:
        return None
    months = [p for p in periods if len(p) == 6 and p.isdigit()]
    if not months:
        return None
    last = max(months)
    return f"{last[:4]}-{last[4:]}"


def _train_models(script: Path) -> ModuleType | None:
    """ml/scripts/train_models.py as a module, or None where it is not shipped (docker image)."""
    if not script.exists():
        return None
    spec = importlib.util.spec_from_file_location("train_models", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def refit_monthly_model_if_stale(
    *,
    csv_path: Path | None = None,
    corrections_path: Path | None = None,
    eid_path: Path | None = None,
    script: Path | None = None,
) -> dict[str, Any]:
    """Refit when the dataset is newer than the model; record and return what happened."""
    csv_path = csv_path or paths.BANTARGEBANG_CSV
    started = time.perf_counter()
    artifact = engine._monthly_calendar_model()
    status: dict[str, Any] = {
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "artifact_fitted_through": artifact["fitted_through"] if artifact else None,
        "data_through": latest_observed_month(csv_path),
        "fitted_through": artifact["fitted_through"] if artifact else None,
    }
    if status["data_through"] is None:
        status["status"] = "no_data"
    elif artifact and status["data_through"] <= artifact["fitted_through"]:
        status["status"] = "current"
    else:
        try:
            tm = _train_models(script or paths.TRAIN_MODELS_SCRIPT)
            if tm is None:
                status["status"] = "training_code_unavailable"
            else:
                monthly = tm.load_bantargebang_monthly(
                    csv_path=csv_path, corrections_path=corrections_path or paths.BANTARGEBANG_CORRECTIONS
                )
                eid = tm.load_idul_fitri_dates(eid_path or paths.IDUL_FITRI_DATES)
                model = tm.fit_monthly_calendar_model(tm.bantargebang_series(monthly), eid)
                engine._MONTHLY_REFIT["model"] = model
                status.update(
                    status="refit", fitted_through=model["fitted_through"], n_months=model["n_months"]
                )
        except Exception as error:  # a failed refit keeps the artifact serving
            logger.exception("monthly model refit failed")
            status.update(status="refit_failed", reason=str(error)[:200])
    status["seconds"] = round(time.perf_counter() - started, 2)
    engine._MONTHLY_REFIT["status"] = status
    return status
