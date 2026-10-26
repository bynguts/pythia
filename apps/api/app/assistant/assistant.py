from __future__ import annotations

import json
import os
import re
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from app.assistant.pii import scrub_outgoing
from app.assistant.rag import format_rag_context
from app.assistant.scenario import (
    parse_scenario_question,
    question_language,
    rain_without_amount,
    rain_words_hint,
    scenario_answer,
    with_parse_step,
)
from app.assistant.tools import TOOL_SCHEMAS, ToolContext, execute_tool, run_tools_pass

# Per-request gateway timeouts, and the budget for the whole multi-step tool loop.
_GATEWAY_TIMEOUT = 18
_IMAGE_GATEWAY_TIMEOUT = 30
_AGENT_DEADLINE_SECONDS = 45
# Model calls per question; the last call is offered no tools, so it must answer.
_MAX_AGENT_STEPS = 4
# Tool executions per model turn, and across the whole question.
_MAX_TOOL_CALLS = 2
_MAX_TOOL_CALLS_TOTAL = 5


def _top_prediction(snapshot: dict[str, Any]) -> dict[str, Any]:
    predictions = snapshot.get("critical_predictions", [])
    return max(predictions, key=lambda item: item.get("spike_percent", 0), default={})


def _sanitize_history(history: list[dict] | None, max_messages: int = 8, max_chars: int = 2000) -> list[dict]:
    """Only user/assistant turns; cap count, cap per-message length."""
    if not history:
        return []
    clean: list[dict] = []
    for message in history[-max_messages:]:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        content = str(message.get("content", ""))[:max_chars]
        if not content:
            continue
        clean.append({"role": role, "content": content})
    return clean


SYSTEM_PROMPT = (
    "Kamu Ana, asisten operasional Pythia untuk DLH Jakarta. Jawab pertanyaan pengguna secara langsung "
    "dalam bahasa yang dipakai pengguna; pertanyaan sederhana boleh dijawab satu atau dua kalimat. "
    "Gunakan daftar, tabel, atau langkah tindakan hanya jika membantu pertanyaan itu. Jangan membuka "
    "jawaban dengan prediksi, risiko, atau rekomendasi yang tidak diminta.\n"
    "Gunakan konteks pengetahuan Pythia hanya untuk menjelaskan fitur dan proses, bukan sebagai angka "
    "operasional terkini. Untuk angka/status terkini, prakiraan, atau klaim data, panggil tool yang "
    "sesuai jika tersedia. Jangan mengarang angka atau menyimpulkan status truk rusak sebagai deviasi "
    "rute. Bedakan kota, kecamatan, dan kelurahan; nyatakan keterbatasan sumber atau kegagalan tool.\n"
    "Panggil tool yang relevan jika pertanyaan memerlukan data (paling banyak dua per langkah, "
    "beberapa langkah bila hasil satu tool menentukan tool berikutnya); jangan panggil tool "
    "untuk sapaan atau penjelasan umum. Jika butuh prakiraan kecamatan, minta include_kecamatan=true "
    "pada get_predictions; untuk prakiraan kota saja, jangan minta itu. Untuk pertanyaan what-if "
    "(hujan mm, event/konser + jumlah pengunjung, venue, hari), panggil run_scenario dan sebutkan bahwa "
    "angkanya MODEL OUTPUT, bukan pengamatan. Jika hujan disebut dengan kata (gerimis, hujan deras/lebat, "
    "sangat lebat, ekstrem; light/heavy/very heavy/extreme rain) tanpa mm, isi rain_category, bukan "
    "rainfall_mm, dan sebutkan nilai kategori BMKG yang dipakai; jika scenario.snapped_to_twin_presets bernilai true, "
    "katakan bahwa nilai diminta (scenario.requested) disesuaikan ke preset twin. Semua tool bersifat baca-saja: "
    "jangan klaim telah dispatch, approve, atau mengirim WhatsApp. Tolak permintaan di luar Pythia dengan "
    "sopan. Jangan tampilkan JSON mentah atau nama field teknis kecuali diminta."
)


def _parse_body(text: str) -> dict[str, Any]:
    text = text.replace("data: [DONE]", "").strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        if line.startswith("data: "):
            line = line[6:].strip()
        try:
            return json.loads(line)
        except Exception:
            pass
    raise ValueError("Invalid JSON stream")


def _knowledge_context(question: str, images: list[str] | None = None) -> str:
    """Documentation is useful for explanations, not as a substitute for live tools."""
    if images or re.search(r"\b(status|saat ini|sekarang|today|now|berapa|jumlah)\b", question.lower()):
        return ""
    q = question.lower().strip()
    if not any(
        word in q
        for word in (
            "apa itu",
            "bagaimana",
            "gimana",
            "mengapa",
            "kenapa",
            "cara ",
            "alur ",
            "sumber ",
            "metode ",
            "model ",
            "fitur ",
            "batasan ",
            "jelaskan",
            "how ",
            "why ",
            "what is",
            "explain",
            "workflow",
        )
    ):
        return ""
    return format_rag_context(question, top_k=2, max_chars=1600)


# Questions about the days and months ahead go to the outlook (7 days + 3 months).
OUTLOOK_TERMS = (
    "minggu depan",
    "pekan depan",
    "seminggu",
    "7 hari",
    "bulan depan",
    "3 bulan",
    "tiga bulan",
    "next week",
    "next month",
    "7 days",
    "3 months",
    "outlook",
)


def _wants_outlook(q: str) -> bool:
    return any(term in q for term in OUTLOOK_TERMS)


def _outlook_answer(result: dict[str, Any], lang: str) -> str:
    """The outlook tool's figures as one local answer (no LLM)."""
    en = lang == "en"
    days = "; ".join(
        f"{d['date']} {d['total_tons']:,.0f} t"
        + (
            (" (no weather forecast)" if en else " (tanpa prakiraan cuaca)")
            if d["beyond_weather_forecast"]
            else ""
        )
        for d in result["week"]["days"]
    )
    intake = result["monthly_intake"]
    parts = [
        (
            f"City-wide waste per day, next 7 days (MODEL OUTPUT): {days}."
            if en
            else f"Sampah se-kota per hari, 7 hari ke depan (MODEL OUTPUT): {days}."
        )
    ]
    if intake.get("available"):
        within = "within" if en else "di dalam"
        beyond = "beyond" if en else "di luar"
        months = "; ".join(
            f"{m['month']} {m['tons_per_day']:,.0f} t/"
            + ("day" if en else "hari")
            + f" ({within if m['within_backtested_horizon'] else beyond} "
            + ("the 1-3 month backtest)" if en else "horizon backtest 1-3 bulan)")
            for m in intake["months"]
        )
        mape = (intake.get("backtest") or {}).get("mape_model_pct")
        error = (
            (
                f" Backtest error on real weighing data: {mape}% MAPE."
                if en
                else f" Galat backtest pada data timbangan nyata: MAPE {mape}%."
            )
            if mape is not None
            else ""
        )
        parts.append(
            (
                f"Bantargebang intake, next months (MODEL OUTPUT, data through {intake['fitted_through']}): "
                if en
                else f"Asupan TPST Bantargebang bulan ke depan (MODEL OUTPUT, data s.d. {intake['fitted_through']}): "
            )
            + months
            + "."
            + error
        )
    learned = result.get("learned_correction")
    if learned:
        if learned["active"]:
            parts.append(
                f"Learned from {learned['n_days']} weighed days: correction {learned['pct']:+}%."
                if en
                else f"Belajar dari {learned['n_days']} hari tertimbang: koreksi {learned['pct']:+}%."
            )
        else:
            parts.append(
                f"The weighbridge correction starts after {learned['min_days']} weighed days "
                f"({learned['n_days']} so far)."
                if en
                else f"Koreksi dari jembatan timbang mulai setelah {learned['min_days']} hari tertimbang "
                f"(baru {learned['n_days']})."
            )
    return " ".join(parts)


def _required_live_tools(question: str) -> set[str]:
    q = question.lower()
    if parse_scenario_question(question):
        return {"run_scenario"}
    if re.search(r"\b(apa itu|how does|bagaimana cara)\b", q) or "sumber data" in q:
        return set()
    if _wants_outlook(q):
        return {"get_forecast_outlook"}
    if any(term in q for term in ("prediksi", "forecast", "prakiraan ton", "timbulan")):
        return {"get_predictions"}
    if any(term in q for term in ("tpa", "antrean", "antrian")):
        return {"get_tpa_queue", "get_command_center_snapshot"}
    if any(term in q for term in ("truk", "armada", "fleet")):
        if any(term in q for term in ("deviasi", "menyimpang", "rusak", "kerusakan")):
            return {"get_fleet_status"}
        if any(term in q for term in ("berapa", "jumlah", "bermasalah", "how many")):
            return {"get_fleet_status", "get_command_center_snapshot"}
        return {
            "get_fleet_status",
            "get_fleet_history",
            "get_truck_breadcrumbs",
            "simulate_astar_reroute",
            "get_command_center_snapshot",
        }
    if any(term in q for term in ("cuaca", "hujan", "weather")):
        return {"get_weather", "get_command_center_snapshot"}
    if "whatsapp" in q or "gateway" in q:
        return {"get_whatsapp_status"}
    if any(term in q for term in ("berapa", "jumlah", "status saat ini", "how many")):
        return {
            "get_command_center_snapshot",
            "get_fleet_status",
            "get_tpa_queue",
            "get_predictions",
            "get_weather",
            "get_events",
            "get_data_provenance",
        }
    return set()


def build_executive_summary(snapshot: dict[str, Any]) -> str:
    kpis = snapshot.get("kpis", {})
    top = _top_prediction(snapshot)
    first_alert = (snapshot.get("alerts") or [{}])[0]
    return (
        f"Pythia detects {kpis.get('trucks_with_issues', 0)} operational issues across "
        f"{kpis.get('active_trucks', 0)} active trucks of the simulated fleet. The highest predicted "
        f"waste spike (model output) is {top.get('spike_percent', 0)}% in "
        f"{top.get('district', 'the monitored district')}, requiring "
        f"{top.get('recommended_extra_trucks', 0)} additional trucks. The Bantargebang queue at the "
        f"modelled peak hour (simulated) is {kpis.get('tpa_wait_minutes', 0)} minutes. "
        "Immediate action: resolve "
        f"{first_alert.get('truck_code', 'priority truck')} via dispatch and stagger landfill arrivals."
    )


def _local_prefix(language: str, fallback_reason: str | None) -> str:
    """The first line of every local answer: it says no LLM produced it, and why."""
    if fallback_reason:
        if language == "en":
            return (
                f"The LLM provider failed ({fallback_reason}); this answer comes from the local parser, "
                "not the LLM."
            )
        return f"Layanan LLM gagal ({fallback_reason}); jawaban ini dari parser lokal, bukan LLM."
    if language == "en":
        return "Local mode (no LLM assistant configured)."
    return "Mode lokal aktif (asisten LLM tidak dikonfigurasi)."


def _answer_locally(
    question: str,
    snapshot: dict[str, Any],
    tool_ctx: ToolContext | None = None,
    images: list[str] | None = None,
    language: str = "id",
    fallback_reason: str | None = None,
) -> dict[str, Any]:
    """No-LLM answer from the tool matching the question; also the fallback when the provider fails."""
    lang = question_language(question, language)
    prefix = _local_prefix(lang, fallback_reason)
    base: dict[str, Any] = {"provider": "local", "mode": "fallback" if fallback_reason else "local"}
    if fallback_reason:
        base["fallback_reason"] = fallback_reason
    if images:
        needs_ai = (
            "Photo/PDF analysis needs the AI service."
            if lang == "en"
            else "Analisis foto/PDF memerlukan layanan AI."
        )
        return {**base, "tools_used": [], "answer": f"{prefix} {needs_ai}"}
    scenario = parse_scenario_question(question) if tool_ctx is not None else None
    if scenario:
        result = execute_tool("run_scenario", scenario, tool_ctx)
        if "error" not in result:
            return {
                **base,
                "answer": f"{prefix}\n\n{scenario_answer(result, lang)}",
                "tools_used": ["run_scenario"],
                "scenario": with_parse_step(result, "local_parser"),
            }
    q = question.lower()
    answer = None
    used: list[str] = []
    if tool_ctx is not None and not re.search(r"\b(apa itu|how does|bagaimana cara)\b", q):
        name = None
        args: dict[str, Any] = {}
        if _wants_outlook(q):
            name = "get_forecast_outlook"
        elif any(term in q for term in ("prediksi", "forecast", "prakiraan ton", "timbulan")):
            name = "get_predictions"
        elif "tpa" in q or "antrean" in q or "antrian" in q:
            name = "get_tpa_queue"
        elif any(term in q for term in ("truk", "armada", "fleet")):
            name = "get_fleet_status"
            code = re.search(r"\bT-\d+\b", question, re.IGNORECASE)
            if code:
                args["truck_code"] = code.group().upper()
        if name:
            result = execute_tool(name, args, tool_ctx)
            if "error" not in result:
                used = [name]
                if name == "get_fleet_status":
                    if args.get("truck_code"):
                        truck = (result.get("trucks") or [None])[0]
                        if truck:
                            answer = (
                                f"Armada {truck['truck_code']}: status {truck['status']}; "
                                f"kerusakan: {'ya' if truck['is_damaged'] else 'tidak'}; "
                                f"deviasi rute: {'ya' if truck['deviation_violated'] else 'tidak'}."
                            )
                        else:
                            answer = f"Data armada {args['truck_code']} tidak tersedia."
                    else:
                        if any(term in q for term in ("deviasi", "menyimpang")):
                            label, count = "mengalami deviasi rute", result["deviation_count"]
                            affected = [t for t in result["problem_trucks"] if t["deviation_violated"]]
                        elif any(term in q for term in ("rusak", "kerusakan")):
                            label, count = "mengalami kerusakan", result["damaged_count"]
                            affected = [t for t in result["problem_trucks"] if t["is_damaged"]]
                        elif "aktif" in q:
                            label, count = "aktif", result["active_count"]
                            affected = []
                        else:
                            label, count = "bermasalah", result["problem_count"]
                            affected = result.get("problem_trucks", [])
                        answer = (
                            f"Data armada Pythia: {count} truk {label} dari {result['total_trucks']} truk."
                        )
                        if affected and re.search(r"\b(mana|which|siapa)\b", q):
                            codes = ", ".join(t["truck_code"] for t in affected[:5])
                            answer += f" Truk terkait: {codes}."
                elif name == "get_forecast_outlook":
                    answer = _outlook_answer(result, lang)
                elif name == "get_tpa_queue":
                    answer = (
                        f"Simulasi antrean TPST Bantargebang: {result['trucks_in_queue']} truk, "
                        f"perkiraan tunggu rata-rata {result['avg_wait_minutes']} menit "
                        f"({result['status_label']}). Ini simulasi, bukan pengamatan langsung."
                    )
                else:
                    predictions = result.get("predictions_daily_city", [])
                    if predictions:
                        district = next(
                            (p["district"] for p in predictions if p.get("district", "").lower() in q), None
                        )
                        first_date = predictions[0]["date"]
                        day = [
                            p
                            for p in predictions
                            if p["date"] == first_date and (district is None or p["district"] == district)
                        ]
                        figures = "; ".join(f"{p['district']}: {p['predicted_tons']} ton" for p in day)
                        answer = f"Prediksi Pythia {first_date} per kota: {figures}."
    if answer is None and rain_without_amount(question):
        answer = rain_words_hint(lang)
    if answer is None:
        rag = _knowledge_context(question).strip()
        if rag and rag.lower() != "no matching pythia knowledge found.":
            heading = (
                "Related information from the Pythia knowledge base:"
                if lang == "en"
                else "Informasi terkait dari basis pengetahuan Pythia:"
            )
            answer = f"{heading}\n{rag}"
        elif lang == "en":
            answer = (
                "Local mode has no data matching this question. It can answer what-if scenarios "
                '(rain in mm or words like "heavy rain", a crowd, a venue, a day), fleet status, '
                "the TPA queue and the forecast; other questions need the AI service."
            )
        else:
            answer = (
                "Data yang sesuai pertanyaan belum tersedia dalam mode lokal. Mode lokal dapat menjawab "
                'skenario what-if (hujan dalam mm atau kata seperti "hujan deras", keramaian, venue, hari), '
                "status armada, antrean TPA dan prakiraan; pertanyaan lain memerlukan layanan AI."
            )
    return {**base, "answer": f"{prefix}\n\n{answer}", "tools_used": used}


def answer_with_openai_if_configured(
    question, snapshot, history=None, tool_ctx=None, images=None, language="id"
) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return _answer_locally(question, snapshot, tool_ctx, images, language)

    rag_context = _knowledge_context(question, images)
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    url = f"{base_url}/chat/completions"
    model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

    clean_history = _sanitize_history(history)
    user_prompt = question
    if rag_context:
        user_prompt += f"\n\nReferensi dokumentasi Pythia (bukan status/angka live):\n{rag_context}"

    # #76: the UI sends the selected locale explicitly; answers stay in that
    # language for the whole conversation.
    language_name = "Bahasa Indonesia" if language == "id" else "English"
    system_prompt = f"{SYSTEM_PROMPT}\nJawab selalu dalam {language_name}."

    if images:
        content: list[dict[str, Any]] = [{"type": "text", "text": user_prompt}]
        for img in images[:5]:
            content.append({"type": "image_url", "image_url": {"url": img}})
        user_message: dict[str, Any] = {"role": "user", "content": content}
    else:
        user_message = {"role": "user", "content": user_prompt}

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(clean_history)
    messages.append(user_message)

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": 600,
        "stream": False,
    }
    if tool_ctx is not None:
        payload["tools"] = TOOL_SCHEMAS
        payload["tool_choice"] = "auto"

    per_call_timeout = _IMAGE_GATEWAY_TIMEOUT if images else _GATEWAY_TIMEOUT
    deadline = time.monotonic() + _AGENT_DEADLINE_SECONDS

    def call_gateway() -> dict[str, Any]:
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise TimeoutError("agent deadline reached")
        # R9: names, phone numbers and plates are scrubbed before anything leaves the server.
        request = Request(
            url,
            data=json.dumps(scrub_outgoing(payload)).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=min(per_call_timeout, remaining)) as response:
            body = _parse_body(response.read().decode("utf-8"))
        if not isinstance(body, dict) or not body.get("choices"):
            raise ValueError("response has no choices")
        return body

    # Multi-step tool loop: the model may call read-only tools over several turns
    # (capped per turn, per question, in steps and in wall-clock time); the last
    # turn is offered no tools, so it has to answer from what the tools returned.
    tools_used: list[str] = []
    scenario: dict[str, Any] | None = None
    served_model = model
    budget = _MAX_TOOL_CALLS_TOTAL if tool_ctx is not None else 0
    steps = 0
    try:
        for step in range(_MAX_AGENT_STEPS):
            final = step == _MAX_AGENT_STEPS - 1 or budget <= 0
            if final:
                payload.pop("tools", None)
                payload.pop("tool_choice", None)
            body = call_gateway()
            steps += 1
            # The badge names the model the provider says answered, not just the one configured.
            served_model = str(body.get("model") or served_model)
            message = body["choices"][0].get("message") or {}
            tool_calls = message.get("tool_calls") or []
            if final or not tool_calls:
                break
            messages.append(message)
            slots = min(_MAX_TOOL_CALLS, budget)
            budget -= min(slots, len(tool_calls))
            tool_messages = run_tools_pass(tool_calls, tool_ctx, max_calls=slots)
            messages.extend(tool_messages)
            for tool_message in tool_messages:
                result = json.loads(tool_message["content"])
                if not isinstance(result, dict) or "error" not in result:
                    name = tool_message["name"]
                    if name not in tools_used:
                        tools_used.append(name)
                    if name == "run_scenario":
                        # The latest scenario is the one the final answer describes.
                        scenario = with_parse_step(result, "llm_tool_call", served_model)
            payload["messages"] = messages
        answer = message.get("content") or ""
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError("empty model content")
    except Exception as error:
        # Any provider failure answers locally, labelled as a fallback: never a dead end,
        # and never an answer that claims an LLM ran.
        result = _answer_locally(
            question, snapshot, tool_ctx, images, language, fallback_reason=_provider_error_reason(error)
        )
        result["llm_model"] = model
        return result
    required = _required_live_tools(question)
    if tool_ctx is not None and required and not required.intersection(tools_used):
        if "run_scenario" in required:
            # A what-if the model answered without running it: the local parser runs it instead.
            result = _answer_locally(
                question, snapshot, tool_ctx, images, language, fallback_reason="no scenario tool call"
            )
            result["llm_model"] = served_model
            return result
        answer = (
            "I could not verify operational data matching this question from the Pythia tools."
            if language == "en"
            else "Saya belum dapat memverifikasi data operasional yang sesuai pertanyaan dari tool Pythia."
        )
    response = {
        "provider": "openai",
        "provider_name": urlparse(base_url).hostname or base_url,
        "model": served_model,
        "mode": "llm",
        "steps": steps,
        "answer": answer,
        "tools_used": tools_used,
    }
    if scenario is not None:
        response["scenario"] = scenario
    return response


def _provider_error_reason(error: Exception) -> str:
    """A short, secret-free reason for the fallback label (no URLs, keys or bodies)."""
    if isinstance(error, HTTPError):
        return f"HTTP {error.code}"
    if isinstance(error, TimeoutError) or "timed out" in str(error).lower():
        return "timeout"
    if isinstance(error, URLError):
        return "provider unreachable"
    if isinstance(error, (ValueError, KeyError, IndexError, TypeError)):
        return "invalid provider response"
    return type(error).__name__
