"""Planner rules as dated configuration (R7 quotas, R8 facility rules).

The rules live in ``paths.OPERATIONS_RULES_FILE`` (JSON under the data dir),
not in code: kecamatan rit quotas, truck trip limits, the Bantargebang gate
caps, the controlled-landfill residue roadmap and the RDF Rorotan acceptance
rule. Every entry carries its source URL and a classification
(``reported`` / ``reported_secondary`` / ``example_news_report`` /
``assumption``), and the planner resolves them for the plan date, so a rule
that changes on 1 Jan 2027 changes the plan without a deploy.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from app.core.paths import OPERATIONS_RULES_FILE

_cache: dict[str, Any] = {"key": None, "rules": None}


def load_rules_config(path: Path | None = None) -> dict[str, Any]:
    """The raw rules file, re-read when it changes on disk."""
    path = Path(path or OPERATIONS_RULES_FILE)
    key = (str(path), path.stat().st_mtime_ns)
    if _cache["key"] != key:
        _cache["rules"] = json.loads(path.read_text(encoding="utf-8"))
        _cache["key"] = key
    return _cache["rules"]


def _source(entry: dict[str, Any]) -> dict[str, Any]:
    """The provenance block every resolved rule carries to the API and UI."""
    return {
        key: entry[key]
        for key in (
            "classification",
            "label",
            "source_url",
            "as_of",
            "effective_from",
            "planner_effect",
            "planner_effect_classification",
        )
        if entry.get(key) is not None
    }


def _active(rules: list[dict[str, Any]], name: str, on: date) -> dict[str, Any] | None:
    """The latest entry of rule `name` already in force on `on`."""
    candidates = [r for r in rules if r.get("rule") == name and date.fromisoformat(r["effective_from"]) <= on]
    return max(candidates, key=lambda r: r["effective_from"]) if candidates else None


@dataclass
class FacilityLimits:
    """One destination's limits, already resolved for a plan date."""

    name: str
    display_name: str
    daily_rit_cap: int | None = None
    shift_rit_cap: int | None = None
    daily_tons_cap: int | None = None
    compactor_only: bool = False
    requires_leachate_free: bool = False
    served_cities: list[str] | None = None
    rules: list[dict[str, Any]] = field(default_factory=list)

    def accepts(self, vehicle_type: str, leachate_free: bool) -> bool:
        if self.compactor_only and "compactor" not in (vehicle_type or "").lower():
            return False
        return not (self.requires_leachate_free and not leachate_free)

    def serves(self, city: str | None) -> bool:
        return self.served_cities is None or (city in self.served_cities)

    def payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "daily_rit_cap": self.daily_rit_cap,
            "shift_rit_cap": self.shift_rit_cap,
            "daily_tons_cap": self.daily_tons_cap,
            "compactor_only": self.compactor_only,
            "requires_leachate_free": self.requires_leachate_free,
            "served_cities": self.served_cities,
            "rules": self.rules,
        }


@dataclass
class PlanningRules:
    """Everything the optimizer treats as a hard constraint for one plan date."""

    shifts: list[dict[str, str]]
    max_rit_per_truck_per_day: int
    max_rit_per_truck_per_shift: int
    default_quota: int | None
    quota_by_area: dict[str, int]
    facilities: list[FacilityLimits]
    quota_sources: dict[str, dict[str, Any]] = field(default_factory=dict)
    default_quota_source: dict[str, Any] = field(default_factory=dict)
    plan_date: str | None = None
    capacity_share: float = 1.0
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def unconstrained(cls) -> PlanningRules:
        """No quotas, one shift, one trip per truck, one open destination.

        This is the optimizer's behaviour before R7, kept for callers that pass
        no rules (unit tests of the bare assignment model).
        """
        return cls(
            shifts=[{"id": "harian", "window": ""}],
            max_rit_per_truck_per_day=1,
            max_rit_per_truck_per_shift=1,
            default_quota=None,
            quota_by_area={},
            facilities=[FacilityLimits(name="TPA", display_name="TPA")],
        )

    def quota_for(self, area: str) -> int | None:
        return self.quota_by_area.get(area, self.default_quota)

    def quota_source_for(self, area: str) -> dict[str, Any]:
        return self.quota_sources.get(area, self.default_quota_source)

    def payload(self) -> dict[str, Any]:
        return {
            "plan_date": self.plan_date,
            "shifts": self.shifts,
            "max_rit_per_truck_per_day": self.max_rit_per_truck_per_day,
            "max_rit_per_truck_per_shift": self.max_rit_per_truck_per_shift,
            "default_quota_rit_per_day": self.default_quota,
            "default_quota_source": self.default_quota_source,
            "quota_by_kecamatan": {
                area: {"rit_per_day": quota, **self.quota_sources.get(area, {})}
                for area, quota in self.quota_by_area.items()
            },
            "capacity_share": round(self.capacity_share, 4),
            "facilities": [f.payload() for f in self.facilities],
            **self.meta,
        }


def _scaled(value: float | None, share: float) -> int | None:
    return None if value is None else max(0, math.floor(value * share))


def resolve_rules(
    plan_date: date, capacity_share: float = 1.0, config: dict[str, Any] | None = None
) -> PlanningRules:
    """Resolve the configured rules for `plan_date`.

    `capacity_share` (0..1] is the plan's share of the citywide forecast; the
    citywide gate and facility caps are scaled by it (labelled an assumption in
    the config), so a five-district plan cannot claim the whole city's gate.
    """
    cfg = config or load_rules_config()
    share = min(1.0, max(0.0, capacity_share))
    quota_cfg = cfg.get("kecamatan_quota", {})
    default = quota_cfg.get("default") or {}
    by_area = quota_cfg.get("by_kecamatan", {})
    truck = cfg.get("truck_limits", {})

    facilities: list[FacilityLimits] = []
    for name, fac in (cfg.get("facilities") or {}).items():
        opens = fac.get("operating_from")
        if opens and date.fromisoformat(opens) > plan_date:
            continue  # not open yet on the plan date
        rules = fac.get("rules", [])
        accepts = fac.get("accepts", {})
        limits = FacilityLimits(
            name=name,
            display_name=fac.get("display_name", name),
            compactor_only=bool(accepts.get("compactor_only")),
            requires_leachate_free=bool(accepts.get("requires_leachate_free")),
        )
        applied = [{"rule": "accepts", **_source(accepts)}]

        daily = _active(rules, "daily_rit_cap", plan_date)
        residue = _active(rules, "residue_share", plan_date)
        if daily is not None:
            raw_share = 1.0 - float(residue["value"]) if residue else 1.0
            limits.daily_rit_cap = _scaled(daily["value"] * raw_share, share)
            applied.append({"rule": "daily_rit_cap", "value": daily["value"], **_source(daily)})
        if residue is not None:
            applied.append({"rule": "residue_share", "value": residue["value"], **_source(residue)})
        shift_cap = _active(rules, "shift_rit_cap", plan_date)
        if shift_cap is not None:
            limits.shift_rit_cap = _scaled(shift_cap["value"], share)
            applied.append({"rule": "shift_rit_cap", "value": shift_cap["value"], **_source(shift_cap)})
        design = _active(rules, "design_capacity_tons_per_day", plan_date)
        intake = _active(rules, "actual_intake_share", plan_date)
        if design is not None:
            in_use = float(intake["value"]) if intake else 1.0
            limits.daily_tons_cap = _scaled(design["value"] * in_use, share)
            applied.append(
                {"rule": "design_capacity_tons_per_day", "value": design["value"], **_source(design)}
            )
        if intake is not None:
            applied.append({"rule": "actual_intake_share", "value": intake["value"], **_source(intake)})
        cities = _active(rules, "served_cities", plan_date)
        if cities is not None:
            limits.served_cities = list(cities["value"])
            applied.append({"rule": "served_cities", "value": cities["value"], **_source(cities)})
        limits.rules = applied
        facilities.append(limits)

    return PlanningRules(
        shifts=list(cfg.get("shifts", {}).get("value") or [{"id": "harian", "window": ""}]),
        max_rit_per_truck_per_day=int(truck.get("max_rit_per_truck_per_day", 1)),
        max_rit_per_truck_per_shift=int(truck.get("max_rit_per_truck_per_shift", 1)),
        default_quota=default.get("rit_per_day"),
        quota_by_area={area: int(q["rit_per_day"]) for area, q in by_area.items()},
        quota_sources={area: _source(q) for area, q in by_area.items()},
        default_quota_source=_source(default),
        facilities=facilities,
        plan_date=plan_date.isoformat(),
        capacity_share=share,
        meta={
            "classification": cfg.get("classification"),
            "label": cfg.get("label"),
            "shifts_source": _source(cfg.get("shifts", {})),
            "truck_limits_source": _source(truck),
            "capacity_share_source": _source(cfg.get("capacity_share", {})),
        },
    )
