"""Driver-safety guard: duty states, local-day window, gate dwell, alerts and labels."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.core.storage import RecordStore
from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN, GATE_ALERT_MIN
from app.field import safety
from app.field import spj as spj_module
from app.field.pretrip import PRETRIP_ITEMS, PreTripStore
from app.field.spj import SpjStore

# 20:00 WIB on a fixed day: every offset used below stays inside that WIB day.
NOW = datetime(2026, 10, 20, 13, 0, tzinfo=UTC)
STOP = {"name": "TPS Uji", "kecamatan": "Cilandak", "address": "Jl. Uji 1", "lat": -6.29, "lng": 106.79}


@pytest.fixture()
def stores(tmp_path, monkeypatch):
    """Fresh SPJ, pre-trip, override and alert stores; routing and SPJ clock under test control."""
    spj_store = SpjStore(persist_path=str(tmp_path / "spj.db"))
    pretrip = PreTripStore(db_path=tmp_path / "pretrip.db")
    monkeypatch.setattr(safety, "SPJ_STORE", spj_store)
    monkeypatch.setattr(safety, "PRETRIP_STORE", pretrip)
    monkeypatch.setattr(safety, "OVERRIDES", RecordStore("overrides", tmp_path / "safety.db"))
    monkeypatch.setattr(safety, "ALERTS", RecordStore("alerts", tmp_path / "safety.db"))
    monkeypatch.setattr(safety, "simulated_fleet_codes", lambda: ["T-001", "T-047", "T-200", "T-201"])
    monkeypatch.setattr(
        spj_module,
        "road_route",
        lambda coords: {
            "geometry": [{"lat": la, "lng": ln} for la, ln in coords],
            "source": "LIVE_EXTERNAL",
            "distance_km": 1.0,
            "duration_min": 2,
        },
    )
    clock = {"now": NOW}
    monkeypatch.setattr(spj_module, "_utc_now", lambda: clock["now"].isoformat())
    monkeypatch.delenv("PYTHIA_WA_DEFAULT_GROUP_ID", raising=False)
    return {"spj": spj_store, "pretrip": pretrip, "clock": clock}


def _pretrip(stores, truck: str, at: datetime) -> None:
    record_id = f"{truck}-{at.timestamp()}"
    stores["pretrip"]._records.write(
        record_id,
        {
            "record_id": record_id,
            "truck_code": truck,
            "driver_name": "Pengemudi Uji",
            "date": at.date().isoformat(),
            "items": {k: True for k in PRETRIP_ITEMS},
            "note": "",
            "created_at": at.isoformat(),
        },
    )


def _active_spj(stores, truck: str, at: datetime, created_by: str = "admin"):
    stores["clock"]["now"] = at
    spj = stores["spj"].create("Pengemudi Uji", truck, "TPST Bantargebang", True, "normal", "", created_by)
    stores["spj"].add_stop(spj.spj_id, **STOP)
    return stores["spj"].activate(spj.spj_id)


# -- duty states -----------------------------------------------------------------


def test_thresholds_come_from_units():
    assert (DUTY_WARN_MIN, DUTY_BLOCK_MIN, GATE_ALERT_MIN) == (600, 720, 180)


@pytest.mark.parametrize(
    ("minutes", "state"), [(0, "ok"), (599, "ok"), (600, "warn"), (719, "warn"), (720, "blocked")]
)
def test_duty_state_transitions_from_observed_pretrip(stores, minutes, state):
    _pretrip(stores, "T-301", NOW - timedelta(minutes=minutes))
    truck = safety.driver_state("T-301", now=NOW)
    assert truck["duty_minutes"] == minutes
    assert truck["duty_state"] == state
    assert truck["classification"] == safety.OBSERVED
    assert truck["shift_source"] == "pretrip"
    assert (truck["warn_at_minutes"], truck["block_at_minutes"]) == (600, 720)


def test_shift_starts_at_the_earliest_pretrip_or_spj_activation(stores):
    _active_spj(stores, "T-302", NOW - timedelta(minutes=300))
    _pretrip(stores, "T-302", NOW - timedelta(minutes=200))
    truck = safety.driver_state("T-302", now=NOW)
    assert truck["duty_minutes"] == 300
    assert truck["shift_source"] == "spj_activation"


# -- local-day window ---------------------------------------------------------------


def test_local_day_is_wib_not_utc(stores):
    # 17:30 UTC is 00:30 WIB of the next day: it starts that WIB day's shift.
    now = datetime(2026, 10, 20, 20, 0, tzinfo=UTC)  # 03:00 WIB on 21 Oct
    _pretrip(stores, "T-303", datetime(2026, 10, 20, 17, 30, tzinfo=UTC))
    _pretrip(stores, "T-304", datetime(2026, 10, 20, 16, 50, tzinfo=UTC))  # 23:50 WIB, 20 Oct
    activity = safety.observed_activity(now)
    assert set(activity) == {"T-303"}
    assert safety.driver_state("T-303", now=now)["duty_minutes"] == 150
    window = safety.shift_window_payload(now)
    assert window["date"] == "2026-10-21"
    assert window["start"] == "2026-10-21T00:00:00+07:00"


def test_previous_day_pretrip_does_not_count(stores):
    _pretrip(stores, "T-305", datetime(2026, 10, 19, 16, 59, tzinfo=UTC))  # 23:59 WIB the day before
    _pretrip(stores, "T-306", NOW - timedelta(minutes=10))
    assert safety.driver_state("T-305", now=NOW)["duty_minutes"] == 0
    assert safety.driver_state("T-305", now=NOW)["shift_started_at"] is None


def test_active_spj_from_before_midnight_carries_its_start_over(stores):
    started = datetime(2026, 10, 19, 15, 0, tzinfo=UTC)  # 22:00 WIB, 19 Oct
    _active_spj(stores, "T-307", started)
    now = datetime(2026, 10, 20, 2, 0, tzinfo=UTC)  # 09:00 WIB, 20 Oct
    truck = safety.driver_state("T-307", now=now)
    assert truck["duty_minutes"] == 660
    assert truck["duty_state"] == "warn"


# -- override and the activation block ------------------------------------------------


def test_block_needs_observed_duty_and_lifts_with_an_override(stores):
    _pretrip(stores, "T-308", NOW - timedelta(minutes=720))
    check = safety.duty_check("T-308", now=NOW)
    assert check["blocked"] is True
    assert "diblokir" in check["reason"] and "12 jam" in check["reason"]

    with pytest.raises(ValueError):
        safety.grant_override("T-308", "terlalu", "supervisor", safety.OBSERVED, now=NOW)
    record = safety.grant_override(
        "T-308", "Sopir pengganti belum tersedia", "supervisor", safety.OBSERVED, now=NOW
    )
    assert record["by"] == "supervisor"
    assert record["local_date"] == "2026-10-20"

    check = safety.duty_check("T-308", now=NOW)
    assert check["blocked"] is False
    assert check["override"] == {
        "by": "supervisor",
        "reason": "Sopir pengganti belum tersedia",
        "at": NOW.isoformat(),
    }
    truck = safety.driver_state("T-308", now=NOW)
    assert truck["duty_state"] == "blocked"  # the state stays honest; the override is shown beside it
    assert truck["override"]["by"] == "supervisor"


def test_override_expires_with_the_local_day(stores):
    safety.grant_override("T-309", "Sopir pengganti belum tersedia", "supervisor", safety.OBSERVED, now=NOW)
    next_day = NOW + timedelta(days=1)
    _pretrip(stores, "T-309", next_day - timedelta(minutes=725))
    assert safety.duty_check("T-309", now=next_day)["blocked"] is True


def test_seed_spj_is_not_an_observed_event(stores):
    _active_spj(stores, "T-088", NOW - timedelta(minutes=800), created_by="seed")
    assert safety.observed_activity(NOW) == {}
    assert safety.duty_check("T-088", now=NOW)["blocked"] is False


# -- gate wait and alerts -------------------------------------------------------------


def test_gate_wait_runs_from_arrival_to_receipt(stores):
    spj = _active_spj(stores, "T-310", NOW - timedelta(minutes=400))
    stores["clock"]["now"] = NOW - timedelta(minutes=250)
    safety.record_gate_arrival(spj.spj_id, "driver", now=NOW - timedelta(minutes=250))
    waiting = safety.driver_state("T-310", now=NOW)
    assert waiting["gate_status"] == "waiting"
    assert waiting["gate_wait_minutes"] == 250
    assert waiting["gate_state"] == "alert"

    stores["spj"].complete_stop(spj.spj_id, 0, override={"reason": "uji tanpa bukti lapangan"}, actor="sv")
    stores["clock"]["now"] = NOW - timedelta(minutes=100)
    stores["spj"].record_receipt(spj.spj_id, "struk.jpg", "data:image/jpeg;base64,AAA", 9000.0, "manual")
    exited = safety.driver_state("T-310", now=NOW)
    assert exited["gate_status"] == "exited"
    assert exited["gate_wait_minutes"] == 150
    assert exited["gate_state"] == "ok"


def test_gate_arrival_is_recorded_once_and_validated(stores):
    spj = _active_spj(stores, "T-311", NOW - timedelta(minutes=60))
    with pytest.raises(ValueError):
        safety.record_gate_arrival(spj.spj_id, "driver", (NOW + timedelta(hours=1)).isoformat(), now=NOW)
    with pytest.raises(ValueError):
        safety.record_gate_arrival(spj.spj_id, "driver", (NOW - timedelta(hours=2)).isoformat(), now=NOW)
    with pytest.raises(LookupError):
        safety.record_gate_arrival("missing", "driver", now=NOW)
    first = (NOW - timedelta(minutes=30)).isoformat()
    safety.record_gate_arrival(spj.spj_id, "driver", first, now=NOW)
    safety.record_gate_arrival(spj.spj_id, "driver", (NOW - timedelta(minutes=5)).isoformat(), now=NOW)
    arrivals = [e for e in stores["spj"].audit_log(spj.spj_id) if e["action"] == "gate_arrival"]
    assert len(arrivals) == 1
    assert arrivals[0]["payload"]["arrived_at"] == first


def test_gate_alert_is_stored_once_and_sent_once_to_the_supervisor_group(stores, monkeypatch):
    sent: list[tuple[str, str]] = []
    monkeypatch.setenv("PYTHIA_WA_DEFAULT_GROUP_ID", "120363000000000000@g.us")
    monkeypatch.setattr(safety, "_dispatch", lambda fn, *args: fn(*args))
    monkeypatch.setattr(
        safety.OpenWAClient,
        "send_text",
        lambda self, chat_id, text: sent.append((chat_id, text)) or {"sent": True, "message": "ok"},
    )
    spj = _active_spj(stores, "T-312", NOW - timedelta(minutes=300))
    safety.record_gate_arrival(
        spj.spj_id, "driver", (NOW - timedelta(minutes=GATE_ALERT_MIN)).isoformat(), now=NOW
    )

    truck = safety.driver_state("T-312", now=NOW)
    assert truck["gate_state"] == "alert"
    assert len(safety.sweep_gate_alerts([truck], now=NOW)) == 1
    assert safety.sweep_gate_alerts([safety.driver_state("T-312", now=NOW + timedelta(minutes=5))]) == []

    assert len(sent) == 1
    assert sent[0][0] == "120363000000000000@g.us"
    assert "T-312" in sent[0][1] and "3 jam 0 menit" in sent[0][1]
    alerts = safety.alerts_today(NOW)
    assert len(alerts) == 1
    assert alerts[0]["whatsapp"]["status"] == "sent"
    assert alerts[0]["classification"] == safety.OBSERVED


def test_gate_alert_without_a_group_is_stored_but_not_sent(stores, monkeypatch):
    monkeypatch.setattr(safety, "_dispatch", lambda fn, *args: pytest.fail("no WhatsApp send expected"))
    spj = _active_spj(stores, "T-313", NOW - timedelta(minutes=300))
    safety.record_gate_arrival(spj.spj_id, "driver", (NOW - timedelta(minutes=200)).isoformat(), now=NOW)
    created = safety.sweep_gate_alerts([safety.driver_state("T-313", now=NOW)], now=NOW)
    assert [a["whatsapp"]["status"] for a in created] == ["not_configured"]


def test_gate_alert_below_the_limit_is_not_raised(stores):
    spj = _active_spj(stores, "T-314", NOW - timedelta(minutes=300))
    safety.record_gate_arrival(spj.spj_id, "driver", (NOW - timedelta(minutes=179)).isoformat(), now=NOW)
    truck = safety.driver_state("T-314", now=NOW)
    assert truck["gate_state"] == "ok"
    assert safety.sweep_gate_alerts([truck], now=NOW) == []


def test_gate_alert_tick_sweeps_observed_trucks_once_with_no_panel_open(stores):
    # An empty server: the tick never alerts on the simulated scenario.
    assert safety.gate_alert_tick(now=NOW) == []
    waiting = _active_spj(stores, "T-315", NOW - timedelta(minutes=300))
    safety.record_gate_arrival(waiting.spj_id, "driver", (NOW - timedelta(minutes=190)).isoformat(), now=NOW)
    short = _active_spj(stores, "T-316", NOW - timedelta(minutes=300))
    safety.record_gate_arrival(short.spj_id, "driver", (NOW - timedelta(minutes=20)).isoformat(), now=NOW)

    created = safety.gate_alert_tick(now=NOW)
    assert [a["truck_code"] for a in created] == ["T-315"]
    assert safety.gate_alert_tick(now=NOW + timedelta(minutes=1)) == []
    assert [a["truck_code"] for a in safety.alerts_today(NOW)] == ["T-315"]


# -- shift statistics --------------------------------------------------------------------


def test_percentiles_interpolate_linearly():
    values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    assert safety.percentile(values, 0.5) == 55.0
    assert safety.percentile(values, 0.9) == 91.0
    assert safety.percentile([42], 0.9) == 42.0
    assert safety.percentile([], 0.5) is None


def test_overview_reports_p50_p90_of_observed_gate_waits(stores):
    for i, wait in enumerate((30, 60, 90, 240)):
        spj = _active_spj(stores, f"T-32{i}", NOW - timedelta(minutes=400))
        safety.record_gate_arrival(spj.spj_id, "driver", (NOW - timedelta(minutes=wait)).isoformat(), now=NOW)
    _pretrip(stores, "T-329", NOW - timedelta(minutes=30))  # on duty, not at the gate
    payload = safety.overview(now=NOW)
    assert payload["classification"] == safety.OBSERVED
    assert payload["gate_wait_samples"] == 4
    assert payload["gate_wait_p50"] == 75.0
    assert payload["gate_wait_p90"] == 195.0
    assert payload["counts"]["gate_alert"] == 1
    assert payload["shift_window"]["date"] == "2026-10-20"
    assert payload["trucks"][0]["truck_code"] == "T-323"  # the gate alert sorts first


# -- classification ----------------------------------------------------------------------


def test_empty_server_falls_back_to_a_labelled_simulated_scenario(stores):
    payload = safety.overview(now=NOW)
    assert payload["classification"] == safety.SIMULATED
    assert "SIMULATED" in payload["label"]
    assert {t["truck_code"] for t in payload["trucks"]} == {"T-001", "T-047", "T-200", "T-201"}
    assert {t["classification"] for t in payload["trucks"]} == {safety.SIMULATED}
    assert all(t["shift_source"] == "simulated" for t in payload["trucks"])
    assert safety.overview(now=NOW)["trucks"] == payload["trucks"]  # seeded, deterministic
    assert safety.driver_state("T-200", now=NOW)["classification"] == safety.SIMULATED
    # A simulated scenario never blocks real work nor raises a stored alert.
    assert all(not safety.duty_check(t["truck_code"], now=NOW)["blocked"] for t in payload["trucks"])
    assert safety.sweep_gate_alerts(payload["trucks"], now=NOW) == []


def test_simulated_scenario_never_gives_one_driver_a_gate_alert(stores, monkeypatch):
    # #gate-numbers: the driver's "queue over 3 hours" notice must come from that
    # driver's observed gate arrival, not from the seeded example dwells.
    monkeypatch.setattr(safety, "simulated_fleet_codes", lambda: [f"T-{n:03d}" for n in range(1, 60)])
    seeded = [
        t["truck_code"]
        for t in safety.overview(now=NOW)["trucks"]
        if t["gate_wait_minutes"] is not None and t["gate_wait_minutes"] >= safety.GATE_ALERT_MIN
    ]
    assert seeded  # the labelled fleet scenario still exercises the alert
    for code in seeded:
        state = safety.driver_state(code, now=NOW)
        assert state["classification"] == safety.SIMULATED
        assert (state["gate_wait_minutes"], state["gate_state"], state["gate_arrived_at"]) == (
            None,
            None,
            None,
        )


def test_observed_events_replace_the_simulation_without_mixing(stores):
    _pretrip(stores, "T-330", NOW - timedelta(minutes=90))
    payload = safety.overview(now=NOW)
    assert payload["classification"] == safety.OBSERVED
    assert [t["truck_code"] for t in payload["trucks"]] == ["T-330"]
    assert payload["gate_wait_p50"] is None
    # A truck without events on an observed server reads zero duty, not a simulated number.
    other = safety.driver_state("T-200", now=NOW)
    assert other["classification"] == safety.OBSERVED
    assert (other["duty_minutes"], other["shift_started_at"]) == (0, None)
