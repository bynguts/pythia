"""The forecast learns from the weighbridge, and the monthly model refits on a new month.

Correction: an EWMA of actual / forecast over the last 14 weighed days, clamped to +/-25 %,
active only from 3 weighed days on, reported beside (never instead of) the raw model value.
Refit: at startup, a weighing dataset newer than the monthly artifact is refitted in-process
with the training script's own code.
"""

import csv
from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from app.api import state
from app.core import paths
from app.core.storage import RecordStore
from app.field import recap as recap_module
from app.field import spj as spj_module
from app.forecast import baseline as baseline_module
from app.forecast import engine, learning
from app.forecast.monthly_refit import latest_observed_month, refit_monthly_model_if_stale


@pytest.fixture()
def store(monkeypatch, tmp_path):
    """An empty learning store, no SPJ history and a fresh correction cache."""
    monkeypatch.setattr(learning, "LEARNING_STORE", RecordStore("learning_test", tmp_path / "learning.db"))
    monkeypatch.setattr(spj_module.SPJ_STORE, "list", lambda: [])
    learning._cache.update(ts=0.0, payload=None)
    yield learning.LEARNING_STORE
    learning._cache.update(ts=0.0, payload=None)


def _days(ratios: list[float]) -> list[dict]:
    start = date(2026, 10, 1)
    return [
        {
            "date": (start + timedelta(days=i)).isoformat(),
            "forecast_t": 100.0,
            "actual_t": 100.0 * r,
            "ratio": r,
        }
        for i, r in enumerate(ratios)
    ]


# ── Correction math ───────────────────────────────────────────────────────


def test_no_weighed_day_means_no_correction():
    c = learning.compute_correction([])
    assert c["active"] is False and c["factor"] == 1.0 and c["n_days"] == 0 and c["since"] is None


def test_fewer_than_three_weighed_days_never_adjust_the_forecast():
    c = learning.compute_correction(_days([1.1, 1.2]))
    assert c["active"] is False and c["factor"] == 1.0 and c["pct"] == 0.0
    assert c["n_days"] == 2 and c["min_days"] == 3
    assert c["learned_factor"] == pytest.approx(1.13)  # shown as provisional, not applied


def test_three_weighed_days_activate_an_ewma_correction():
    c = learning.compute_correction(_days([1.10, 1.20, 1.00]))
    expected = 0.3 * 1.00 + 0.7 * (0.3 * 1.20 + 0.7 * 1.10)  # 1.069
    assert c["active"] is True and c["factor"] == pytest.approx(expected, abs=1e-4)
    assert c["pct"] == pytest.approx((expected - 1) * 100, abs=0.1)
    assert c["since"] == "2026-10-01" and c["last_day"] == "2026-10-03" and c["clamped"] is False


@pytest.mark.parametrize(("ratio", "bound"), [(2.0, 1.25), (0.3, 0.75)])
def test_the_correction_is_clamped_to_25_percent(ratio, bound):
    c = learning.compute_correction(_days([ratio] * 4))
    assert c["factor"] == bound and c["clamped"] is True and c["unclamped_factor"] == pytest.approx(ratio)


def test_only_the_last_14_weighed_days_count():
    c = learning.compute_correction(_days([2.0] * 10 + [1.0] * 14))
    assert c["n_days"] == 14 and c["factor"] == 1.0 and c["since"] == "2026-10-11"


# ── Recording closed days from the recap ──────────────────────────────────


def _recap(spj=None, planned=100.0, actual=90.0, trips=4, receipts=4, delta=-10.0):
    return {
        # Assigned capacity (18 t a trip) is deliberately far from the forecast demand.
        "forecast": {"forecast_tons": planned, "planned_tons": trips * 18.0 * 3, "planned_trips": trips},
        "actual": {
            "receipt_tons": actual,
            "receipts": receipts,
            "spj": {"draft": 0, "aktif": 0, "selesai": receipts, "batal": 0, **(spj or {})},
        },
        "delta": {"tons": delta},
    }


def test_only_closed_fully_weighed_days_before_today_are_recorded(store, monkeypatch):
    today = learning.local_today()
    day = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
    recaps = {
        day(1): _recap(),  # closed, weighed
        day(2): _recap(spj={"aktif": 1}),  # a trip still open
        day(3): _recap(delta=None),  # a receipt without net weight / no plan
        day(4): _recap(trips=4, receipts=2, actual=50.0),  # half the trips weighed: pro-rated
        day(45): _recap(),  # outside the 30-day look-back
        today.isoformat(): _recap(),  # today is not closed
    }
    spjs = [SimpleNamespace(date=d) for d in recaps]
    monkeypatch.setattr(spj_module.SPJ_STORE, "list", lambda: spjs)
    monkeypatch.setattr(recap_module, "daily_recap", lambda d: recaps[d])

    assert learning.sync_closed_days() == 2
    rows = {r["date"]: r for r in store.all()}
    assert set(rows) == {day(1), day(4)}
    assert rows[day(1)]["ratio"] == pytest.approx(0.9)
    assert rows[day(4)]["forecast_t"] == pytest.approx(50.0) and rows[day(4)]["ratio"] == pytest.approx(1.0)
    assert rows[day(1)]["actual_classification"] == "OBSERVED_IN_APP"
    assert learning.sync_closed_days() == 0  # stored days are not recounted


def test_the_ratio_is_against_forecast_demand_not_truck_capacity(store, monkeypatch):
    # Real trips carry ~6 t on 18 t trucks: dividing by capacity would read as a -67 % forecast error.
    yesterday = (learning.local_today() - timedelta(days=1)).isoformat()
    recap = _recap(planned=24.0, actual=23.8, trips=4, receipts=4)
    recap["forecast"]["planned_tons"] = 72.0
    monkeypatch.setattr(spj_module.SPJ_STORE, "list", lambda: [SimpleNamespace(date=yesterday)])
    monkeypatch.setattr(recap_module, "daily_recap", lambda d: recap)

    assert learning.sync_closed_days() == 1
    assert store.all()[0]["ratio"] == pytest.approx(23.8 / 24.0, abs=1e-4)


# ── The endpoints carry it beside the raw value ───────────────────────────


@pytest.fixture()
def quiet_week(monkeypatch):
    payload = {
        "source": "open-meteo",
        "kind": "forecast",
        "forecast": [
            {"date": (date.today() + timedelta(days=i)).isoformat(), "rainfall_mm": 0.0} for i in range(7)
        ],
    }
    monkeypatch.setattr(baseline_module, "fetch_jakarta_weather_forecast", lambda: payload)
    monkeypatch.setattr(baseline_module, "load_official_events", lambda: [])
    monkeypatch.setattr(baseline_module.PERMIT_STORE, "list", lambda: [])
    baseline_module._cache.clear()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)
    yield
    baseline_module._cache.clear()
    state._outlook_cache.update(key=None, ts=0.0, payload=None)


def test_inactive_correction_leaves_only_the_raw_model_value(api_client, auth_headers, store, quiet_week):
    body = api_client.get("/api/forecast/tomorrow", headers=auth_headers("dispatcher")).json()
    assert body["learned_correction"]["active"] is False and body["corrected_total_t"] is None
    outlook = api_client.get("/api/forecast/outlook", headers=auth_headers("dispatcher")).json()
    assert outlook["learned_correction"]["n_days"] == 0
    assert all(d["corrected_tons"] is None and d["total_tons"] > 0 for d in outlook["week"]["days"])


def test_active_correction_is_applied_next_to_the_raw_value(api_client, auth_headers, store, quiet_week):
    for row in _days([1.1, 1.1, 1.1]):
        learning.record_day(row["date"], row["forecast_t"], row["actual_t"])
    body = api_client.get("/api/forecast/tomorrow", headers=auth_headers("dispatcher")).json()
    c = body["learned_correction"]
    assert c["active"] is True and c["factor"] == pytest.approx(1.1) and c["n_days"] == 3
    assert body["corrected_total_t"] == pytest.approx(round(body["total_tonnage_t"] * 1.1, 1))
    outlook = api_client.get("/api/forecast/outlook", headers=auth_headers("dispatcher")).json()
    for day in outlook["week"]["days"]:
        assert day["corrected_tons"] == pytest.approx(round(day["total_tons"] * 1.1, 1))
    assert outlook["week"]["days"][1]["total_tons"] == body["total_tonnage_t"]  # raw stays raw


# ── Monthly refit at startup ──────────────────────────────────────────────


@pytest.fixture()
def no_refit():
    engine._MONTHLY_REFIT.clear()
    yield
    engine._MONTHLY_REFIT.clear()


def _dataset_with_a_new_month(tmp_path, new_period: str) -> tuple:
    with paths.BANTARGEBANG_CSV.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fields = reader.fieldnames
    last = max(r["periode_data"] for r in rows)
    added = [{**r, "periode_data": new_period} for r in rows if r["periode_data"] == last]
    target = tmp_path / "bantargebang.csv"
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows + added)
    return target, last


def test_current_data_keeps_the_committed_model(no_refit):
    status = refit_monthly_model_if_stale()
    artifact = engine._monthly_calendar_model()
    assert status["status"] == "current" and status["fitted_through"] == artifact["fitted_through"]
    assert latest_observed_month(paths.BANTARGEBANG_CSV) == artifact["fitted_through"]
    assert engine.forecast_monthly_intake(1)["model_source"] == "artifact"


def test_a_newer_month_refits_the_model_in_process(no_refit, tmp_path):
    artifact = engine._monthly_calendar_model()
    year, month = (int(x) for x in artifact["fitted_through"].split("-"))
    new = f"{year + month // 12}{month % 12 + 1:02d}"
    csv_path, _ = _dataset_with_a_new_month(tmp_path, new)

    status = refit_monthly_model_if_stale(csv_path=csv_path)
    assert status["status"] == "refit" and status["fitted_through"] == f"{new[:4]}-{new[4:]}"
    assert status["artifact_fitted_through"] == artifact["fitted_through"]
    assert status["n_months"] == artifact["n_months"] + 1 and status["seconds"] < 30

    out = engine.forecast_monthly_intake(3)
    assert out["model_source"] == "startup_refit" and out["fitted_through"] == status["fitted_through"]
    assert out["refit"]["status"] == "refit" and out["months"][0]["horizon_months"] == 1
    assert engine._monthly_calendar_model()["fitted_through"] == artifact["fitted_through"]  # file untouched


def test_without_the_training_code_the_artifact_keeps_serving(no_refit, tmp_path):
    csv_path, _ = _dataset_with_a_new_month(tmp_path, "209912")
    status = refit_monthly_model_if_stale(csv_path=csv_path, script=tmp_path / "missing.py")
    assert status["status"] == "training_code_unavailable"
    assert engine.forecast_monthly_intake(1)["model_source"] == "artifact"
