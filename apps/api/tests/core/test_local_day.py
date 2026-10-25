"""Gap 10: the working day is the Asia/Jakarta (WIB) day, not the UTC date.

06:00 WIB on 15 Sep is still 23:00 UTC on 14 Sep: a pre-trip check, an SPJ
number and compliance lateness must all count it as 15 Sep.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest
from spj_testutil import fresh_store_path

from app.core import env
from app.field import compliance as comp
from app.field.pretrip import PreTripStore
from app.field.spj import SpjStore

# 06:00 WIB on 2026-09-15 == 23:00 UTC on 2026-09-14.
WIB_0600 = datetime(2026, 9, 14, 23, 0, tzinfo=UTC)
ALL_OK = {k: True for k in ("rem", "mesin", "ban", "bbm", "oli", "bak_compactor", "lampu")}


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return WIB_0600 if tz is None else WIB_0600.astimezone(tz)


@pytest.fixture()
def at_0600_wib(monkeypatch):
    monkeypatch.delenv("PYTHIA_DEMO_DATE", raising=False)
    monkeypatch.setattr(env, "datetime", _FrozenDatetime)


def test_local_today_is_the_wib_day_at_0600(at_0600_wib):
    assert env.local_today() == date(2026, 9, 15)
    assert env.local_now().utcoffset().total_seconds() == 7 * 3600


def test_demo_date_wins_over_the_clock(at_0600_wib, monkeypatch):
    monkeypatch.setenv("PYTHIA_DEMO_DATE", "2026-10-24")
    assert env.local_today() == date(2026, 10, 24)


def test_pretrip_at_0600_wib_is_filed_today(at_0600_wib, tmp_path):
    store = PreTripStore(tmp_path / "pretrip.db")
    rec = store.submit("T-WIB", "Pengemudi Sim 01", ALL_OK)
    assert rec.date == "2026-09-15"
    assert store.today("T-WIB") is not None


def test_spj_number_and_date_use_the_wib_day(at_0600_wib):
    store = SpjStore(fresh_store_path("pythia_spj_local_day.db"))
    spj = store.create("Pengemudi Sim 01", "T-WIB", "TPST Bantargebang", False, "normal", "")
    assert spj.date == "2026-09-15"
    assert spj.spj_number.startswith("DLH-DKI/SPJ/15-09-2026/")


def test_an_early_shift_spj_is_not_late_when_closed_after_0700_wib(at_0600_wib, monkeypatch):
    """Created 06:00 WIB, closed 08:00 WIB the same day: UTC dates differ, WIB days do not."""
    store = SpjStore(fresh_store_path("pythia_spj_local_day_late.db"))
    spj = store.create("Pengemudi Sim 02", "T-WIBL", "TPST Bantargebang", False, "normal", "")
    assert spj.date == "2026-09-15"  # the UTC date at creation was 2026-09-14
    record = store.get(spj.spj_id)
    record.status = "selesai"
    record.completed_at = "2026-09-15T01:00:00+00:00"  # 08:00 WIB
    store._commit(record)

    pretrip = PreTripStore(fresh_store_path("pythia_pretrip_local_day.db"))
    monkeypatch.setattr(comp, "SPJ_STORE", store)
    monkeypatch.setattr(comp, "PRETRIP_STORE", pretrip)
    monkeypatch.setattr(comp, "get_dynamic_trucks", lambda: [])
    result = comp.compute_driver_score("Pengemudi Sim 02", ["T-WIBL"], today="2026-09-15")
    assert result["breakdown"]["late_completions"] == 0

    # Closed the next WIB day (00:30 WIB on 16 Sep = 17:30 UTC on 15 Sep): late.
    record = store.get(spj.spj_id)
    record.completed_at = "2026-09-15T17:30:00+00:00"
    store._commit(record)
    result = comp.compute_driver_score("Pengemudi Sim 02", ["T-WIBL"], today="2026-09-16")
    assert result["breakdown"]["late_completions"] == 1
