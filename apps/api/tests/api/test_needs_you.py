"""/api/ops/needs-you: one feed of open items, each with its provenance; resolved items drop out."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.field import needs_you as feed
from app.field.damage_reports import DAMAGE_STORE
from app.field.driver_exceptions import EXCEPTION_STORE
from app.field.spj import SPJ_STORE

STOP = {
    "name": "TPS Kalideres Uji",
    "kecamatan": "Kalideres",
    "address": "Jl. Uji",
    "lat": -6.14,
    "lng": 106.7,
}
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
ITEM_KEYS = {
    "id",
    "kind",
    "category",
    "severity",
    "truck_code",
    "spj_id",
    "created_at",
    "facts",
    "suggestion",
    "actions",
    "classification",
    "next_step",
    "rule",
}


@pytest.fixture()
def truck() -> str:
    return f"NY-{uuid4().hex[:6]}"


@pytest.fixture(autouse=True)
def _no_gate_board(monkeypatch):
    """The gate board needs approved plans; most tests do not care about it."""
    monkeypatch.setattr(feed, "_gate_peaks", lambda day, follow_ups: [])


def _exception(truck: str, kind: str, spj_id: str | None = None, stop_index: int | None = None):
    return EXCEPTION_STORE.create(
        kind=kind,
        truck_code=truck,
        driver_name="Driver 01",
        reported_by="driver",
        spj_id=spj_id,
        stop_index=stop_index,
        note="",
        photo_name=None,
        photo_b64=None,
        lat=None,
        lng=None,
        approx=False,
        reported_at=None,
    )


def _feed(api_client, auth_headers) -> dict:
    res = api_client.get("/api/ops/needs-you", headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    return res.json()


def _mine(body: dict, truck: str) -> list[dict]:
    return [i for i in body["items"] if i["truck_code"] == truck]


def test_needs_the_dashboard_permission(api_client, auth_headers):
    assert api_client.get("/api/ops/needs-you").status_code == 401
    assert api_client.get("/api/ops/needs-you", headers=auth_headers("driver")).status_code == 403
    assert api_client.get("/api/ops/needs-you", headers=auth_headers("supervisor")).status_code == 200


def test_shape_counts_and_simulated_deviations(api_client, auth_headers):
    body = _feed(api_client, auth_headers)
    assert set(body["counts"]) == {"all", "urgent", "trucks", "gate", "tps"}
    assert body["counts"]["all"] == len(body["items"])
    assert body["counts"]["urgent"] == sum(1 for i in body["items"] if i["severity"] == "urgent")
    for item in body["items"]:
        assert set(item) == ITEM_KEYS
    for item in (i for i in body["items"] if i["kind"] == "deviation"):
        assert item["classification"] == "SIMULATED" and item["id"] == f"ALT-{item['truck_code']}"
        assert item["created_at"] is None


def test_deviation_carries_the_human_spj_number_not_only_its_hash(monkeypatch, truck):
    from types import SimpleNamespace

    from app.fleet import data

    deviation = {"violated": True, "distance_meters": 420, "severity": "warning", "rule_flags": []}
    monkeypatch.setattr(data, "get_dynamic_trucks", lambda: [{"truck_code": truck, "deviation": deviation}])
    spj = SimpleNamespace(spj_id="edbc85798e75", spj_number="DLH-DKI/SPJ/27-10-2026/000001")
    [item] = feed._deviations({truck: spj})
    assert item["spj_id"] == "edbc85798e75"
    assert item["facts"]["spj_number"] == "DLH-DKI/SPJ/27-10-2026/000001"
    [bare] = feed._deviations({})
    assert bare["spj_id"] is None and bare["facts"]["spj_number"] is None


def test_accident_is_urgent_and_drops_out_once_resolved(api_client, auth_headers, truck):
    exc = _exception(truck, "accident")
    item = _mine(_feed(api_client, auth_headers), truck)[0]
    assert item["id"] == f"driver-exception:{exc.exception_id}"
    assert item["kind"] == "accident" and item["severity"] == "urgent"
    assert item["classification"] == "FIELD" and "escalate" in item["actions"]
    res = api_client.post(
        "/api/alert/follow-up",
        json={"alert_id": item["id"], "status": "DISPATCHED", "note": "112 called"},
        headers=auth_headers("dispatcher"),
    )
    assert res.status_code == 200
    escalated = _mine(_feed(api_client, auth_headers), truck)[0]
    assert escalated["facts"]["follow_up"]["status"] == "DISPATCHED"
    api_client.post(
        "/api/alert/follow-up",
        json={"alert_id": item["id"], "status": "RESOLVED"},
        headers=auth_headers("dispatcher"),
    )
    assert _mine(_feed(api_client, auth_headers), truck) == []


def test_empty_tps_reports_of_one_stop_are_one_item(api_client, auth_headers, truck):
    spj = SPJ_STORE.create_with_stops(
        "Driver 01", truck, "TPST Bantargebang", False, "normal", "uji", [dict(STOP)], created_by="admin"
    )
    _exception(truck, "tps_empty", spj.spj_id, 0)
    _exception(truck, "tps_empty", spj.spj_id, 0)
    items = _mine(_feed(api_client, auth_headers), truck)
    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "tps_empty" and item["category"] == "tps" and item["severity"] == "normal"
    assert item["facts"]["reports"] == 2 and item["facts"]["stop_name"] == STOP["name"]
    assert item["id"] == f"tps-empty:{spj.spj_id}:0"


def test_breakdown_from_an_exception_is_not_repeated_by_its_damage_report(api_client, auth_headers, truck):
    res = api_client.post(
        "/api/driver/exceptions",
        json={"kind": "truck_breakdown", "truck_code": truck},
        headers=auth_headers("driver"),
    )
    assert res.status_code == 201, res.text
    try:
        items = _mine(_feed(api_client, auth_headers), truck)
        assert [i["kind"] for i in items] == ["truck_breakdown"]
        assert items[0]["id"].startswith("driver-exception:")
    finally:
        DAMAGE_STORE.resolve(res.json()["damage_report_id"])


def test_open_heavy_damage_report_is_a_breakdown(api_client, auth_headers, truck):
    rep = DAMAGE_STORE.create(truck, "Driver 01", "rem", "berat", "rem blong", source="pretrip")
    light = DAMAGE_STORE.create(truck, "Driver 01", "lampu", "ringan", "lampu mati", source="pretrip")
    try:
        items = _mine(_feed(api_client, auth_headers), truck)
        assert [i["id"] for i in items] == [f"damage:{rep.report_id}"]
        assert items[0]["facts"]["component"] == "rem" and items[0]["suggestion"] is None
    finally:
        DAMAGE_STORE.resolve(rep.report_id)
        DAMAGE_STORE.resolve(light.report_id)


def test_breakdown_in_an_approved_plan_suggests_the_first_backup(monkeypatch, truck):
    import app.field.readiness as readiness

    rep = DAMAGE_STORE.create(truck, "Driver 01", "mesin", "berat", "mogok", source="pretrip")
    monkeypatch.setattr(feed, "_plan_of", lambda code, day: "PLN-1" if code == truck else None)
    backup = {"truck_code": "T-140", "classification": "FIELD", "basis": "pre-trip passed"}
    monkeypatch.setattr(readiness, "readiness_payload", lambda day, scope: {"backup_candidates": [backup]})
    try:
        item = next(i for i in feed.needs_you()["items"] if i["truck_code"] == truck)
    finally:
        DAMAGE_STORE.resolve(rep.report_id)
    assert item["suggestion"] == {
        "kind": "reassign",
        "plan_id": "PLN-1",
        "from_truck": truck,
        "to_truck": "T-140",
        "basis": "pre-trip passed",
        "classification": "FIELD",
    }


def test_simulated_duty_is_counted_but_never_an_item(monkeypatch):
    monkeypatch.setattr(
        feed.safety,
        "overview",
        lambda now: {
            "classification": feed.safety.SIMULATED,
            "trucks": [{"truck_code": "T-1", "duty_state": "blocked"}],
        },
    )
    body = feed.needs_you()
    assert not [i for i in body["items"] if i["kind"].startswith("duty")]
    assert body["sources"]["duty"]["included"] is False and body["sources"]["duty"]["flagged"] == 1


def test_observed_duty_warn_and_block_are_items(monkeypatch):
    def truck(code, state, override=None):
        return {
            "truck_code": code,
            "duty_state": state,
            "override": override,
            "duty_minutes": 700,
            "warn_at_minutes": 600,
            "block_at_minutes": 720,
            "shift_started_at": None,
            "shift_source": "pretrip",
        }

    trucks = [truck("DTY-1", "warn"), truck("DTY-2", "blocked"), truck("DTY-3", "blocked", {"by": "s"})]
    monkeypatch.setattr(
        feed.safety, "overview", lambda now: {"classification": feed.safety.OBSERVED, "trucks": trucks}
    )
    items = [i for i in feed.needs_you()["items"] if i["id"].startswith("duty-")]
    assert {i["truck_code"]: (i["kind"], i["severity"]) for i in items} == {
        "DTY-1": ("duty_warn", "normal"),
        "DTY-2": ("duty_blocked", "urgent"),
        "DTY-3": ("duty_warn", "normal"),
    }


def test_gate_peak_groups_unaccepted_holds_by_slot(monkeypatch):
    import app.api.routers.gate_slots as gate

    def rec(truck, accepted=False):
        return {
            "id": f"rec-x-{truck}",
            "truck_code": truck,
            "hold_minutes": 15,
            "from_slot": "10:00",
            "to_slot": "10:15",
            "expected_wait_reduction_min": 9.5,
            "accepted": accepted,
        }

    board = {
        "slots": [{"start": "10:00", "expected_wait_min": 38.0}],
        "recommendations": [rec("T-031"), rec("T-044"), rec("T-050", accepted=True)],
        "classification": "SIMULATED",
        "wait_method": "fluid",
    }
    monkeypatch.undo()  # the autouse stub replaced _gate_peaks itself
    monkeypatch.setattr(gate, "gate_slots_payload", lambda day: board)
    items = feed._gate_peaks("2026-10-26", {})
    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "gate_peak" and item["category"] == "gate"
    assert item["classification"] == "SIMULATED" and item["facts"]["expected_wait_min"] == 38.0
    assert [h["truck_code"] for h in item["facts"]["holds"]] == ["T-031", "T-044"]
    assert feed._gate_peaks("2026-10-26", {item["id"]: {"status": "RESOLVED"}}) == []
    step, rule = feed._guidance(item)
    assert step == {"key": "ns_step_gate_peak", "params": {"n": 2, "slot": "10:00"}}
    assert rule["id"] == "CAPACITY_PER_SLOT" and rule["key"] == "ns_rule_gate_peak"


def _keys(body: dict, truck: str) -> list[tuple]:
    return [(i["next_step"]["key"], i["rule"]["id"], i["rule"]["value"]) for i in _mine(body, truck)]


def test_every_item_names_a_next_step_and_the_rule_that_raised_it(api_client, auth_headers, truck):
    _exception(truck, "accident")
    [item] = _mine(_feed(api_client, auth_headers), truck)
    assert item["next_step"] == {"key": "ns_step_accident", "params": {"truck": truck}}
    assert item["rule"] == {
        "id": "DRIVER_EXCEPTION",
        "value": "accident",
        "unit": None,
        "key": "ns_rule_accident",
        "params": {"value": "accident", "reports": 1},
    }


def test_heavy_damage_cites_its_severity_and_a_backup_step(api_client, auth_headers, truck):
    rep = DAMAGE_STORE.create(truck, "Driver 01", "rem", "berat", "rem blong", source="pretrip")
    try:
        assert _keys(_feed(api_client, auth_headers), truck) == [
            ("ns_step_breakdown", "DAMAGE_SEVERITY", "berat")
        ]
    finally:
        DAMAGE_STORE.resolve(rep.report_id)


def test_duty_items_cite_the_duty_limits_from_units(monkeypatch):
    from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN

    def truck(code, state, minutes, override=None):
        return {
            "truck_code": code,
            "duty_state": state,
            "override": override,
            "duty_minutes": minutes,
            "warn_at_minutes": DUTY_WARN_MIN,
            "block_at_minutes": DUTY_BLOCK_MIN,
            "shift_started_at": None,
            "shift_source": "pretrip",
        }

    trucks = [truck("DTW-1", "warn", 650), truck("DTW-2", "blocked", 730), truck("DTW-3", "blocked", 730, {})]
    monkeypatch.setattr(
        feed.safety, "overview", lambda now: {"classification": feed.safety.OBSERVED, "trucks": trucks}
    )
    items = {i["truck_code"]: i for i in feed.needs_you()["items"] if i["id"].startswith("duty-DTW")}
    assert (items["DTW-1"]["rule"]["id"], items["DTW-1"]["rule"]["value"]) == ("DUTY_WARN_MIN", DUTY_WARN_MIN)
    assert (items["DTW-2"]["rule"]["id"], items["DTW-2"]["rule"]["value"]) == (
        "DUTY_BLOCK_MIN",
        DUTY_BLOCK_MIN,
    )
    assert items["DTW-2"]["next_step"]["key"] == "ns_step_duty_blocked"
    # An overridden block is a warning, but the limit it crossed is still the 12 h one.
    assert items["DTW-3"]["kind"] == "duty_warn" and items["DTW-3"]["rule"]["id"] == "DUTY_BLOCK_MIN"


def _receipt_item(failed: list[str], spj_number: str = "DLH-DKI/SPJ/27-10-2026/000009") -> dict:
    return {
        "kind": "receipt_check",
        "truck_code": "T-1",
        "spj_id": "abc",
        "suggestion": None,
        "actions": ["mark_handled"],
        "facts": {"spj_number": spj_number, "failed": [{"id": c, "detail": ""} for c in failed]},
    }


def test_receipt_check_steps_answer_the_most_serious_failed_check():
    from app.core.units import TRUCK_CAPACITY_TONS

    step, rule = feed._guidance(_receipt_item(["ocr_vs_entered", "sealed"]))
    assert step["key"] == "ns_step_receipt_sealed" and rule["id"] == "SPJ_SEAL"
    step, rule = feed._guidance(_receipt_item(["net_vs_capacity"]))
    assert step == {"key": "ns_step_receipt_capacity", "params": {"spj": "DLH-DKI/SPJ/27-10-2026/000009"}}
    assert (rule["id"], rule["value"], rule["unit"]) == ("TRUCK_CAPACITY_TONS", TRUCK_CAPACITY_TONS, "t")
    assert feed._guidance(_receipt_item(["duplicate_ticket"]))[1]["id"] == "DUPLICATE_TICKET_PHOTO"
    assert feed._guidance(_receipt_item(["ocr_vs_entered"]))[0]["key"] == "ns_step_receipt_ocr"


def test_failed_receipt_check_is_an_item_and_a_broken_seal_is_urgent(monkeypatch, truck):
    import app.field.receipt_checks as checks

    spj = SPJ_STORE.create_with_stops(
        "Driver 01", truck, "TPST Bantargebang", False, "normal", "uji", [dict(STOP)], created_by="admin"
    )
    SPJ_STORE.activate(spj.spj_id, actor="admin")
    override = {"reason": "Foto bukti tidak tersedia di lokasi", "actor": "supervisor"}
    SPJ_STORE.complete_stop(spj.spj_id, 0, override=override, actor="supervisor")
    SPJ_STORE.record_receipt(spj.spj_id, "r.png", TINY_PNG, 15_000.0, "manual", tare_weight_kg=9_000.0)

    def fake(store, record, photos=None, tickets=None):
        if record.spj_id != spj.spj_id:
            return None
        failed = {"id": "sealed", "state": "fail", "detail": "Seal broken."}
        return {"overall": "review", "basis": checks.BASIS, "checks": [failed]}

    monkeypatch.setattr(checks, "checks_for", fake)
    [item] = [i for i in feed.needs_you()["items"] if i["spj_id"] == spj.spj_id]
    assert item["kind"] == "receipt_check" and item["severity"] == "urgent" and item["category"] == "gate"
    assert item["next_step"]["key"] == "ns_step_receipt_sealed" and item["rule"]["id"] == "SPJ_SEAL"


@pytest.mark.parametrize(
    ("check", "step", "rule_id"),
    [
        ("ticket_document", "ns_step_receipt_document", "TICKET_DOCUMENT"),
        ("ticket_arithmetic", "ns_step_receipt_arithmetic", "TICKET_ARITHMETIC_TOLERANCE_KG"),
        ("duplicate_ticket_no", "ns_step_receipt_ticket_no", "DUPLICATE_TICKET_NO"),
        ("plate_vs_truck", "ns_step_receipt_plate", "PLATE_VS_TRUCK"),
    ],
)
def test_ticket_ocr_checks_each_have_their_own_step_and_rule(check, step, rule_id):
    got_step, got_rule = feed._guidance(_receipt_item([check, "ocr_vs_entered"]))
    assert got_step["key"] == step and got_rule["id"] == rule_id


def test_ticket_arithmetic_rule_cites_the_tolerance_and_the_feed_batches_ticket_numbers(monkeypatch, truck):
    import app.field.receipt_checks as checks

    rule = feed._guidance(_receipt_item(["ticket_arithmetic"]))[1]
    assert (rule["value"], rule["unit"]) == (checks.TICKET_ARITHMETIC_TOLERANCE_KG, "kg")
    seen = []
    monkeypatch.setattr(
        checks, "checks_for", lambda store, spj, photos=None, tickets=None: seen.append(tickets)
    )
    feed._receipt_checks(feed.local_today().isoformat(), {})
    assert all(isinstance(t, dict) for t in seen)  # one batch lookup, never None (a query per receipt)
