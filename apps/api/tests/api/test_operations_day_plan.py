"""The /api/operations day plan: weekend from the date, hard quotas with a
visible shortfall, and plan dispatches from an Indonesian template with
structured fields (truck, stops, slot, reason)."""

from __future__ import annotations

import pytest

import app.api.routers.operations as operations

CITY_TONS = 7000.0


def _truck(code, vehicle_type="Compactor Besar"):
    return {
        "truck_code": code,
        "vehicle_type": vehicle_type,
        "is_damaged": False,
        "deviation": {"violated": False},
    }


@pytest.fixture()
def fake_inputs(monkeypatch):
    calls = []

    def predictions(**kwargs):
        calls.append(kwargs)
        kecamatan = [
            {"slug": "cakung", "kecamatan": "CAKUNG", "city": "Jakarta Timur", "predicted_tons": 400.0},
            {"slug": "tebet", "kecamatan": "TEBET", "city": "Jakarta Selatan", "predicted_tons": 30.0},
        ]
        return {
            "kecamatan": kecamatan,
            "top_hotspots": kecamatan,
            "total_predicted_tons": CITY_TONS,
            "kecamatan_count": 42,
            "scenario": {"targeted_kecamatan": []},
        }

    monkeypatch.setattr(operations, "predictions_kecamatan", predictions)
    monkeypatch.setattr(operations, "TRUCKS", [_truck(f"T-{i:03d}") for i in range(1, 31)])
    return calls


def _plan(api_client, auth_headers, **params):
    res = api_client.post("/api/operations/plan", params=params, headers=auth_headers("dispatcher"))
    assert res.status_code == 200, res.text
    return res.json()


@pytest.mark.parametrize(
    ("plan_date", "weekend"),
    [("2026-10-24", True), ("2026-10-25", True), ("2026-10-26", False), ("2026-10-30", False)],
)
def test_weekend_follows_the_plan_date(api_client, auth_headers, fake_inputs, plan_date, weekend):
    plan = _plan(api_client, auth_headers, plan_date=plan_date, top_n=2)
    assert fake_inputs[-1]["is_weekend"] is weekend
    assert str(fake_inputs[-1]["target_date"]) == plan_date
    assert plan["scenario"]["is_weekend"] is weekend
    assert plan["plan_date"] == plan_date
    assert plan["kind"] == "day_plan"


def test_a_fixed_weekend_flag_is_ignored(api_client, auth_headers, fake_inputs):
    plan = _plan(api_client, auth_headers, plan_date="2026-10-26", is_weekend="true", top_n=2)
    assert plan["is_weekend"] is False


def test_quota_limits_the_plan_and_the_shortfall_is_reported(
    api_client, auth_headers, fake_inputs, monkeypatch
):
    # Pasar Rebo carries the one published quota (14 rit/day); kecamatan without a
    # published quota are not capped.
    def predictions(**kwargs):
        fake_inputs.append(kwargs)
        kecamatan = [
            {
                "slug": "pasar_rebo",
                "kecamatan": "PASAR REBO",
                "city": "Jakarta Timur",
                "predicted_tons": 400.0,
            },
            {"slug": "tebet", "kecamatan": "TEBET", "city": "Jakarta Selatan", "predicted_tons": 30.0},
        ]
        return {
            "kecamatan": kecamatan,
            "top_hotspots": kecamatan,
            "total_predicted_tons": CITY_TONS,
            "kecamatan_count": 42,
            "scenario": {"targeted_kecamatan": []},
        }

    monkeypatch.setattr(operations, "predictions_kecamatan", predictions)
    plan = _plan(api_client, auth_headers, plan_date="2026-10-26", top_n=2)
    usage = {u["area"]: u for u in plan["quota_usage"]}
    assert usage["pasar_rebo"]["rit_used"] == 14
    assert usage["pasar_rebo"]["quota_rit_per_day"] == 14
    assert usage["pasar_rebo"]["binding_limit"] == "kecamatan_quota"
    assert usage["pasar_rebo"]["quota_source"]["classification"] == "example_news_report"
    assert usage["tebet"]["quota_rit_per_day"] is None
    assert usage["tebet"]["unassigned_tons"] == 0
    assert plan["feasible"] is False
    assert plan["unassigned_tons"] == 400 - 14 * 18
    assert plan["shortfall_label"] == f"infeasible: {400 - 14 * 18} t unassigned"
    assert plan["scope"]["fleet_classification"] == "SIMULATED"
    assert {f["name"] for f in plan["rules"]["facilities"]} == {"TPST Bantargebang", "RDF Plant Jakarta"}


def test_kecamatan_without_a_published_quota_is_not_capped(api_client, auth_headers, fake_inputs):
    plan = _plan(api_client, auth_headers, plan_date="2026-10-26", top_n=2)
    usage = {u["area"]: u for u in plan["quota_usage"]}
    assert usage["cakung"]["quota_rit_per_day"] is None
    assert usage["cakung"]["binding_limit"] != "kecamatan_quota"


def test_approved_plan_dispatches_indonesian_template_with_structured_fields(
    api_client, auth_headers, fake_inputs
):
    plan = _plan(api_client, auth_headers, plan_date="2026-10-26", top_n=2)
    first = plan["dispatches"][0]
    truck = first["truck_code"]
    assert first["text"].startswith(f"Rencana {plan['plan_id']} · 26 Okt 2026 · Truk {truck}")
    assert "1. Shift pagi (06:00-14:00): angkut ±18 t dari Kec. " in first["text"]
    assert "Alasan: prakiraan timbulan Kec. " in first["text"]
    assert "(keluaran model)" in first["text"]
    fields = first["fields"]
    assert fields["template"] == "plan_dispatch_v1"
    assert fields["truck_code"] == truck
    assert fields["slot"] == {"shift": "pagi", "window": "06:00-14:00"}
    assert fields["stops"][0]["kecamatan"] in {"Cakung", "Tebet"}
    assert fields["reason"]["code"] == "forecast_demand"
    assert fields["reason"]["classification"] == "MODEL_OUTPUT"
    # One dispatch per truck, covering every trip of that truck.
    assert len(plan["dispatches"]) == len({a["truck_code"] for a in plan["assignments"]})

    approved = api_client.post(
        f"/api/operations/{plan['plan_id']}/approve", headers=auth_headers("supervisor")
    ).json()
    assert len(approved["dispatch_ids"]) == len(plan["dispatches"])

    pending = api_client.get(f"/api/dispatch/{truck}", headers=auth_headers("driver")).json()
    texts = [d["instruction"] for d in pending if d["id"] in approved["dispatch_ids"]]
    assert texts == [first["text"]]

    res = api_client.get(f"/api/operations/instructions/{truck}", headers=auth_headers("driver"))
    assert res.status_code == 200, res.text
    instructions = [i for i in res.json() if i["plan_id"] == plan["plan_id"]]
    assert len(instructions) == 1
    assert instructions[0]["dispatch_id"] in approved["dispatch_ids"]
    assert instructions[0]["fields"]["stops"] == fields["stops"]
    assert instructions[0]["text"] == first["text"]


def test_instructions_need_a_field_or_dispatch_permission(api_client):
    assert api_client.get("/api/operations/instructions/T-001").status_code == 401
    login = api_client.post(
        "/api/auth/login", json={"username": "executive", "password": "executive-demo-pass"}
    ).json()
    headers = {"Authorization": f"Bearer {login['token']}"}
    assert api_client.get("/api/operations/instructions/T-001", headers=headers).status_code == 403


def test_rules_endpoint_resolves_the_plan_date(api_client):
    rules_2026 = api_client.get("/api/operations/rules", params={"plan_date": "2026-10-26"}).json()
    rules_2029 = api_client.get("/api/operations/rules", params={"plan_date": "2029-02-01"}).json()

    def bg(rules):
        return next(f for f in rules["facilities"] if f["name"] == "TPST Bantargebang")

    assert bg(rules_2026)["daily_rit_cap"] == 675
    assert bg(rules_2029)["daily_rit_cap"] == 0
    assert rules_2026["quota_by_kecamatan"]["pasar_rebo"]["rit_per_day"] == 14
