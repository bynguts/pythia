"""Assistant "Ana" queries and the executive summary report."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import require_permission
from app.api.routers.fleet import fleet_status_overview
from app.api.routers.forecast import predictions_kecamatan
from app.api.schemas import AssistantRequest
from app.api.state import dispatch_center, history_store
from app.assistant.assistant import answer_with_openai_if_configured, build_executive_summary
from app.fleet.data import command_center_snapshot
from app.forecast.engine import simulate_staggered_dispatch
from app.forecast.weather import fetch_jakarta_weather_forecast

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/assistant/query")
def assistant_query(
    payload: AssistantRequest, _role: str = Depends(require_permission("dashboard:read"))
) -> dict:
    # FastAPI executes sync endpoints in a worker; gateway latency must not block the event loop.
    try:
        from app.assistant.tools import ToolContext

        tool_ctx = ToolContext(dispatch_center=dispatch_center, history_store=history_store)
        snapshot = {}
        images = None
        if payload.file_data and payload.file_type:
            from app.assistant.pdf_vision import resolve_file_to_images

            images = resolve_file_to_images(payload.file_data, payload.file_type)
        result = answer_with_openai_if_configured(
            payload.question,
            snapshot,
            history=payload.history,
            tool_ctx=tool_ctx,
            images=images,
            language=payload.language,
        )
    except Exception as e:
        logger.exception("assistant query failed")
        raise HTTPException(status_code=502, detail=f"AI gateway error: {e}") from e

    if result.get("provider") == "error":
        raise HTTPException(status_code=502, detail=f"AI gateway error: {result.get('error', 'unknown')}")

    history_store.record_event(
        "assistant_query", {"question": payload.question, "provider": result["provider"]}
    )
    return result


@router.get("/api/reports/executive-summary")
def executive_summary() -> dict:
    snapshot = command_center_snapshot(dispatch_center.audit_log(), weather=fetch_jakarta_weather_forecast())
    summary = build_executive_summary(snapshot)

    from app.assistant.assistant import _top_prediction

    top = _top_prediction(snapshot)
    # Numbers must come from the live snapshot — a literal default here once
    # shipped "41% / Jakarta Barat / 28 trucks" while the KPI card said +4%.
    tpa_wait = snapshot["kpis"]["tpa_wait_minutes"]
    if top.get("district"):
        top_spike = int(top.get("spike_percent") or snapshot["kpis"].get("predicted_spike_percent") or 0)
        extra_trucks = int(top.get("recommended_extra_trucks") or 0)
        extra_crews = int(top.get("recommended_extra_crews") or 0)
        spike_clause = (
            f"Proyeksi peningkatan volume sampah puncak sebesar {top_spike}% terjadi di {top['district']}, "
            f"didorong curah hujan/event, "
            + (f"yang membutuhkan {extra_trucks} armada truk tambahan. " if extra_trucks else "")
        )
        crew_clause = (
            f" dan pengerahan {extra_crews} tim kru tambahan ke kelurahan terdampak" if extra_crews else ""
        )
    else:
        spike_clause = "Tidak ada lonjakan volume signifikan pada horizon 7 hari. "
        crew_clause = ""
    summary_id = (
        f"Pythia mendeteksi {snapshot['kpis']['trucks_with_issues']} kendala operasional di lapangan. "
        + spike_clause
        + f"Antrian di Bantargebang saat ini mencapai {tpa_wait} menit. Direkomendasikan implementasi staggered dispatch "
        + f"untuk mereduksi beban TPA{crew_clause}."
    )

    history_store.record_event("executive_summary", {"summary": summary})
    impact = simulate_staggered_dispatch(int(snapshot["kpis"]["active_trucks"]))

    preds = predictions_kecamatan(rainfall_mm=0.0, event_attendance=0)
    hotspots = [
        {
            "kecamatan": h["kecamatan"],
            "city": h["city"],
            "predicted_tons": h["predicted_tons"],
            "trucks_required": h["trucks_required"],
            "crews_required": h["crews_required"],
            "workers_required": h["workers_required"],
            "man_hours_required": h["man_hours_required"],
            "bins_required": h["bins_required"],
            "facility_readiness": h.get("facility_readiness"),
        }
        for h in preds["top_hotspots"][:5]
    ]
    from app.forecast.facility_planning import build_facility_gap_analysis

    gap = build_facility_gap_analysis({k["kecamatan"]: k["predicted_tons"] for k in preds["kecamatan"]})
    fleet_status = fleet_status_overview()
    return {
        "summary": summary_id,
        "summary_en": summary,
        "queue_impact": impact,
        "top_hotspots": hotspots,
        "facility_summary": gap["summary"],
        "fleet_status": {
            "total_trucks": fleet_status["total_trucks"],
            "by_activity": fleet_status["by_activity"],
            "damaged_count": fleet_status["damaged_count"],
        },
        "model_suitability_note": (
            "Only the monthly landfill-intake forecast is backtested on real data; daily, "
            "weekly and monthly per-district figures and the hotspot ranking rest on "
            "calibrated-synthetic series anchored to SILIKA 2023 baselines and carry no "
            "accuracy claim (see /api/ml/suitability)."
        ),
    }
