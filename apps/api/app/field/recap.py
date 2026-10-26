"""Close-of-day recap: what the plan promised against what the app recorded (wave 12 lane E).

Read-only. Every figure comes from records on this server (SPJ, receipts, gate
arrivals, driver exceptions, damage reports) or from the stored plans (MODEL_OUTPUT).
A side with no data is ``None``, never zero, and ``delta`` needs both sides.
"""

from __future__ import annotations

from datetime import date as date_type
from typing import Any

from app.api.state import _OPERATIONS_PLAN_STORE
from app.core.units import GATE_ALERT_MIN
from app.field import safety
from app.field.damage_reports import DAMAGE_STORE
from app.field.driver_exceptions import EXCEPTION_STORE, KINDS
from app.field.spj import SPJ_STORE

FORECAST_CLASSIFICATION = "MODEL_OUTPUT"
ACTUAL_CLASSIFICATION = "OBSERVED_IN_APP"
SPJ_STATUSES = ("draft", "aktif", "selesai", "batal")
PLAN_LIMIT = 200


def _local_date(iso: str | None) -> str | None:
    parsed = safety._parse(iso)
    return parsed.astimezone(safety.WIB).date().isoformat() if parsed else None


def _forecast(day: str) -> dict[str, Any]:
    plans = [
        p
        for p in _OPERATIONS_PLAN_STORE.list_plans(status="approved", limit=PLAN_LIMIT)
        if p.get("plan_date") == day
    ]
    assigned = [float(p["total_assigned_tons"]) for p in plans if p.get("total_assigned_tons") is not None]
    needed = [float(p["total_demand_tons"]) for p in plans if p.get("total_demand_tons") is not None]
    planned = round(sum(assigned), 1) if assigned else None
    demand = round(sum(needed), 1) if needed else None
    return {
        "plan_ids": [p["plan_id"] for p in plans],
        "planned_tons": planned,
        "forecast_tons": demand,
        "classification": FORECAST_CLASSIFICATION,
    }


def _spj_facts(day: str) -> dict[str, Any]:
    spjs = [s for s in SPJ_STORE.list() if s.date == day]
    counts = {status: 0 for status in SPJ_STATUSES}
    receipts = net_kg = with_net = ritasi = pending_review = 0
    waits: list[float] = []
    missing = overrides = 0
    for spj in spjs:
        if spj.status in counts:
            counts[spj.status] += 1
        for stop in spj.stops:
            if stop.override:
                overrides += 1
            elif stop.status == "completed" and not stop.evidence:
                missing += 1
        receipt = spj.receipt
        if not receipt:
            continue
        receipts += 1
        ritasi += 1
        if receipt.get("net_weight_kg") is not None:
            net_kg += float(receipt["net_weight_kg"])
            with_net += 1
        if (receipt.get("ocr") or {}).get("status") == "unreviewed":
            pending_review += 1
        arrived = safety._gate_arrival(spj)
        exited = safety._parse(receipt.get("recorded_at"))
        if arrived and exited:
            waits.append(float(safety._minutes(arrived, exited)))
    return {
        "spj": counts,
        "receipts": receipts,
        "ritasi": ritasi,
        "receipt_tons": round(net_kg / 1000, 2) if with_net else None,
        "receipts_with_net_weight": with_net,
        "waits": waits,
        "missing": missing,
        "overrides": overrides,
        "pending_review": pending_review,
    }


def _incidents(day: str) -> dict[str, Any]:
    kinds = {kind: 0 for kind in KINDS}
    for exc in EXCEPTION_STORE.list():
        if exc.kind in kinds and _local_date(exc.reported_at or exc.created_at) == day:
            kinds[exc.kind] += 1
    damage = sum(1 for rep in DAMAGE_STORE.list() if _local_date(rep.created_at) == day)
    return {"exceptions": kinds, "damage_reports": damage}


def _summary(day: str, data: dict[str, Any]) -> dict[str, str]:
    fc, act, delta = data["forecast"], data["actual"], data["delta"]
    if not fc["plan_ids"] and not act["receipts"] and not any(act["spj"].values()):
        return {
            "id": f"{day}: belum ada data rencana atau realisasi untuk hari ini.",
            "en": f"{day}: no plan or recorded activity for this day yet.",
        }
    spj = act["spj"]
    tons = act["receipt_tons"]
    id_parts = [
        f"{day}: {spj['selesai']} SPJ selesai, {spj['aktif']} aktif, {spj['draft']} draf; "
        f"{act['receipts']} tanda terima",
        f"tonase tercatat {tons} t" if tons is not None else "tonase tercatat belum ada",
    ]
    en_parts = [
        f"{day}: {spj['selesai']} SPJ completed, {spj['aktif']} active, {spj['draft']} draft; "
        f"{act['receipts']} receipts",
        f"recorded tonnage {tons} t" if tons is not None else "no recorded tonnage yet",
    ]
    if fc["planned_tons"] is not None:
        id_parts.append(f"rencana (MODEL) {fc['planned_tons']} t")
        en_parts.append(f"plan (MODEL) {fc['planned_tons']} t")
    if delta["tons"] is not None:
        id_parts.append(f"selisih {delta['tons']:+} t ({delta['pct']:+}%)")
        en_parts.append(f"delta {delta['tons']:+} t ({delta['pct']:+}%)")
    wait = data["gate_wait"]
    if wait["median_min"] is not None:
        id_parts.append(f"antre gerbang median {wait['median_min']} menit (n={wait['observed_n']})")
        en_parts.append(f"median gate wait {wait['median_min']} min (n={wait['observed_n']})")
    return {"id": "; ".join(id_parts) + ".", "en": "; ".join(en_parts) + "."}


def daily_recap(date: str | date_type) -> dict[str, Any]:
    day = date.isoformat() if isinstance(date, date_type) else str(date)
    facts = _spj_facts(day)
    forecast = _forecast(day)
    receipt_tons = facts["receipt_tons"]
    planned = forecast["planned_tons"]
    complete = facts["receipts"] > 0 and facts["receipts_with_net_weight"] == facts["receipts"]
    delta_tons = round(receipt_tons - planned, 2) if complete and planned is not None else None
    delta_pct = round(delta_tons / planned * 100, 1) if delta_tons is not None and planned else None
    waits = facts["waits"]
    data = {
        "date": day,
        "forecast": forecast,
        "actual": {
            "receipt_tons": receipt_tons,
            "receipts_with_net_weight": facts["receipts_with_net_weight"],
            "receipts": facts["receipts"],
            "ritasi": facts["ritasi"],
            "spj": facts["spj"],
            "classification": ACTUAL_CLASSIFICATION,
        },
        "delta": {
            "tons": delta_tons,
            "pct": delta_pct,
            "delta_basis": "partial_receipts" if receipt_tons is not None and not complete else None,
        },
        "gate_wait": {
            "observed_n": len(waits),
            "median_min": safety.percentile(waits, 0.5),
            "p90_min": safety.percentile(waits, 0.9),
            "over_180": sum(1 for w in waits if w >= GATE_ALERT_MIN),
        },
        "incidents": _incidents(day),
        "evidence": {
            "stops_missing_evidence": facts["missing"],
            "overrides": facts["overrides"],
            "receipts_pending_review": facts["pending_review"],
        },
    }
    data["summary"] = _summary(day, data)
    return data
