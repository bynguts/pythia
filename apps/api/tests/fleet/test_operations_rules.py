"""R8: facility rules are dated configuration, resolved for the plan date,
and every rule carries its source and classification."""

from __future__ import annotations

import json
import os
from datetime import date

from app.core.paths import DATA_DIR, OPERATIONS_RULES_FILE
from app.fleet.operations_optimizer import Demand, Vehicle, build_operational_plan
from app.fleet.operations_rules import load_rules_config, resolve_rules

BG = "TPST Bantargebang"
RDF = "RDF Plant Jakarta"


def _facility(rules, name):
    return next((f for f in rules.facilities if f.name == name), None)


def test_rules_file_lives_under_the_data_dir():
    assert OPERATIONS_RULES_FILE.is_relative_to(DATA_DIR)
    assert OPERATIONS_RULES_FILE.exists()


def test_bantargebang_raw_waste_cap_follows_the_residue_roadmap_by_date():
    # 900 rit/day gate cap; raw-waste trips are (1 - residue share) of it.
    assert _facility(resolve_rules(date(2026, 7, 31)), BG).daily_rit_cap == 900
    assert _facility(resolve_rules(date(2026, 8, 1)), BG).daily_rit_cap == 675  # 25 %
    assert _facility(resolve_rules(date(2027, 6, 1)), BG).daily_rit_cap == 450  # 50 %
    assert _facility(resolve_rules(date(2028, 6, 1)), BG).daily_rit_cap == 225  # 75 %
    assert _facility(resolve_rules(date(2029, 1, 1)), BG).daily_rit_cap == 0  # 100 %


def test_rdf_rorotan_is_closed_before_opening_and_takes_only_leachate_free_compactors():
    assert _facility(resolve_rules(date(2025, 11, 30)), RDF) is None
    rdf = _facility(resolve_rules(date(2026, 10, 26)), RDF)
    assert rdf.display_name == "RDF Rorotan"
    assert rdf.daily_tons_cap == 480  # 2,400 t/day stated x about 20 % in use
    assert rdf.accepts("Compactor Besar", leachate_free=True)
    assert not rdf.accepts("Dump Truck Besar", leachate_free=False)
    assert not rdf.accepts("Compactor Besar", leachate_free=False)
    assert rdf.served_cities == ["Jakarta Utara", "Jakarta Timur"]


def test_capacity_share_scales_citywide_caps():
    bg = _facility(resolve_rules(date(2026, 10, 26), capacity_share=0.25), BG)
    assert bg.daily_rit_cap == 168  # floor(900 x 0.75 x 0.25)
    assert bg.shift_rit_cap == 100


def test_every_rule_carries_a_source_and_a_classification():
    rules = resolve_rules(date(2026, 10, 26))
    for facility in rules.facilities:
        for rule in facility.rules:
            assert rule.get("classification"), rule
            if rule["rule"] != "accepts" or facility.name == RDF:
                assert rule.get("source_url", "").startswith("https://"), rule
    payload = rules.payload()
    pasar_rebo = payload["quota_by_kecamatan"]["pasar_rebo"]
    assert pasar_rebo["rit_per_day"] == 14
    assert pasar_rebo["label"] == "example quota (news report), confirm with DLH"
    assert payload["default_quota_source"]["classification"] == "assumption"
    residue = next(r for r in _facility(rules, BG).rules if r["rule"] == "residue_share")
    assert residue["planner_effect_classification"] == "assumption"


def test_plan_for_2029_cannot_send_raw_waste_to_bantargebang():
    rules = resolve_rules(date(2029, 3, 1))
    fleet = [Vehicle(truck_code=f"T-{i:03d}", capacity_tons=18, vehicle_type="Dump Truck") for i in range(10)]
    plan = build_operational_plan(
        [Demand(area="tebet", tons=100.0, lat=0, lng=0, city="Jakarta Selatan")], fleet, rules=rules
    )
    assert plan.assignments == []
    assert plan.unassigned_tons == 100.0
    assert plan.unmet_reasons == ["facility_limit:tebet"]


def test_editing_the_rules_file_changes_the_next_plan_without_a_deploy(tmp_path):
    config = json.loads(OPERATIONS_RULES_FILE.read_text(encoding="utf-8"))
    path = tmp_path / "operations_rules.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    assert load_rules_config(path)["kecamatan_quota"]["by_kecamatan"]["pasar_rebo"]["rit_per_day"] == 14

    config["kecamatan_quota"]["by_kecamatan"]["pasar_rebo"]["rit_per_day"] = 9
    path.write_text(json.dumps(config), encoding="utf-8")
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    reloaded = load_rules_config(path)
    assert reloaded["kecamatan_quota"]["by_kecamatan"]["pasar_rebo"]["rit_per_day"] == 9
    assert resolve_rules(date(2026, 10, 26), config=reloaded).quota_for("pasar_rebo") == 9


def test_configured_facilities_are_registered_destinations():
    from app.fleet.facilities import FACILITIES

    assert set(load_rules_config(OPERATIONS_RULES_FILE)["facilities"]) <= set(FACILITIES)
