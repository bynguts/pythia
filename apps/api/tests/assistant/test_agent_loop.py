"""Ana's LLM path against a fake OpenAI-compatible server, and BMKG rain words.

The server is a local http.server that plays back scripted chat-completions
responses; no real provider is ever called.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import pytest

from app.assistant import assistant as assistant_module
from app.assistant.assistant import answer_with_openai_if_configured
from app.assistant.scenario import parse_scenario_question, rain_without_amount, scenario_answer
from app.assistant.tools import ToolContext, execute_tool

SERVED_MODEL = "fake-model-2026-10-served"


def _ctx():
    return ToolContext(dispatch_center=MagicMock(audit_log=lambda: []), history_store=MagicMock())


def _scene(city="jakarta", days=7, rainfall_mm=0.0, event_attendance=0, day=0, **_):
    dates = [f"2026-10-{22 + i}" for i in range(days)]
    extra = rainfall_mm / 5
    return {
        "horizon": {"dates": dates},
        "districts": [
            {
                "name": "Gambir",
                "admin_area": "Jakarta Pusat",
                "series": [
                    {"date": d, "predicted_tons": 100.0 + extra, "normal_tons": 100.0, "risk": "high"}
                    for d in dates
                ],
            }
        ],
        "provenance": {"districts": {"class": "MODEL_OUTPUT", "source": "Prophet + XGBoost per kecamatan"}},
        "landfill_queue": {},
    }


@pytest.fixture()
def fake_scene():
    calls = []

    def scene(**kwargs):
        calls.append(kwargs)
        return _scene(**kwargs)

    with patch("app.api.routers.twin.twin_scene", side_effect=scene):
        yield calls


def _tool_call(call_id, name, args):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


@pytest.fixture()
def provider(monkeypatch):
    """A fake OpenAI-compatible /chat/completions server with a scripted reply queue."""
    state = {"replies": [], "requests": []}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 (http.server API)
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["requests"].append({"path": self.path, "auth": self.headers.get("Authorization"), **body})
            status, reply = state["replies"].pop(0) if state["replies"] else (500, {"error": "no reply"})
            data = json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-real")
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
    monkeypatch.setenv("OPENAI_MODEL", "configured-model")
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()


def _message(content=None, tool_calls=None):
    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return (200, {"model": SERVED_MODEL, "choices": [{"message": message}]})


# ---- BMKG rain words --------------------------------------------------------


@pytest.mark.parametrize(
    ("question", "category", "mm"),
    [
        ("What if it rains heavily tomorrow?", "heavy", 75.0),
        ("what if heavy rain hits during the JIS concert tomorrow?", "heavy", 75.0),
        ("kalau hujan deras besok?", "heavy", 75.0),
        ("bagaimana jika hujan lebat di GBK lusa", "heavy", 75.0),
        ("kalau gerimis besok?", "light", 10.0),
        ("what if light rain today", "light", 10.0),
        ("jika hujan sedang besok", "moderate", 35.0),
        ("kalau hujan sangat deras besok", "very_heavy", 125.0),
        ("what if very heavy rain tomorrow", "very_heavy", 125.0),
        ("skenario hujan ekstrem hari ini", "extreme", 150.0),
        ("what if extreme rain hits tomorrow", "extreme", 150.0),
    ],
)
def test_rain_words_map_to_bmkg_category_values(question, category, mm):
    parsed = parse_scenario_question(question)
    assert parsed is not None, question
    assert parsed["rainfall_mm"] == mm
    assert parsed["rain_category"]["key"] == category


def test_a_millimetre_figure_wins_over_a_rain_word():
    parsed = parse_scenario_question("what if 80 mm of heavy rain hits tomorrow")
    assert parsed["rainfall_mm"] == 80.0
    assert "rain_category" not in parsed


def test_rain_word_scenario_states_the_assumed_bmkg_value(fake_scene):
    parsed = parse_scenario_question("What if it rains heavily tomorrow?")
    result = execute_tool("run_scenario", parsed, _ctx())
    category = result["scenario"]["rain_category"]
    assert category["rainfall_mm"] == 75.0 and category["range_mm_per_day"] == "50–100"
    assert category["bmkg_label"] == "lebat" and "BMKG" in category["source"]
    assert fake_scene[-1]["rainfall_mm"] == 75.0
    assert result["trace"][0]["detail"]["rain_category"] == "heavy"
    assert "\"rains heavily\" → 75 mm (BMKG 'lebat' 50–100 mm/day)" in scenario_answer(result, "en")
    assert "assumed from the BMKG category" in scenario_answer(result, "en")
    assert "diasumsikan dari kategori BMKG" in scenario_answer(result, "id")


def test_local_answer_for_a_rain_word_question_is_a_scenario_not_a_dead_end(fake_scene, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = answer_with_openai_if_configured("kalau hujan deras besok?", {}, tool_ctx=_ctx(), language="id")
    assert result["provider"] == "local" and result["mode"] == "local"
    assert result["answer"].startswith("Mode lokal aktif (asisten LLM tidak dikonfigurasi).")
    assert result["scenario"]["scenario"]["rainfall_mm"] == 75.0
    assert result["scenario"]["trace"][0]["detail"]["rain_category"] == "heavy"


def test_rain_without_an_amount_gets_the_category_hint_locally(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert rain_without_amount("what if it rains tomorrow?")
    result = answer_with_openai_if_configured(
        "what if it rains tomorrow?", {}, tool_ctx=_ctx(), language="en"
    )
    assert result["answer"].startswith("Local mode (no LLM assistant configured).")
    assert "heavy 50–100 mm → 75 mm" in result["answer"]
    assert "scenario" not in result


def test_non_scenario_local_answer_says_it_is_local_and_what_it_can_answer(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = answer_with_openai_if_configured(
        "who won the match last night?", {}, tool_ctx=_ctx(), language="en"
    )
    assert result["provider"] == "local"
    assert result["answer"].startswith("Local mode (no LLM assistant configured).")
    assert "what-if scenarios" in result["answer"]


# ---- multi-step tool loop -----------------------------------------------------


def test_llm_runs_tools_over_several_steps_and_applies_the_scenario(provider, fake_scene):
    provider["replies"] = [
        _message(tool_calls=[_tool_call("c1", "get_tpa_queue", {})]),
        _message(tool_calls=[_tool_call("c2", "run_scenario", {"rain_category": "heavy", "day": 1})]),
        _message("Hujan lebat (75 mm, asumsi kategori BMKG) menambah tonase Gambir. MODEL OUTPUT."),
    ]
    with patch("app.assistant.tools._TOOLS_IMPL", {**_impl(), "get_tpa_queue": lambda a, c: {"q": 1}}):
        result = answer_with_openai_if_configured(
            "kalau hujan deras besok, bagaimana antrean TPA?", {}, tool_ctx=_ctx()
        )
    requests = provider["requests"]
    assert len(requests) == 3 and result["steps"] == 3
    assert requests[0]["path"] == "/v1/chat/completions"
    assert requests[0]["auth"] == "Bearer test-key-not-real"
    assert requests[0]["model"] == "configured-model"
    # Step 2 sees step 1's tool result; every step but the last may call tools.
    assert [m["role"] for m in requests[1]["messages"]][-2:] == ["assistant", "tool"]
    assert all("tools" in r for r in requests)
    assert result["provider"] == "openai" and result["mode"] == "llm"
    assert result["provider_name"] == "LLM"  # never the gateway host
    assert result["model"] == SERVED_MODEL
    assert result["tools_used"] == ["get_tpa_queue", "run_scenario"]
    scenario = result["scenario"]
    assert scenario["scenario"]["rainfall_mm"] == 75.0
    assert scenario["scenario"]["rain_category"]["key"] == "heavy"
    assert scenario["trace"][0]["class"] == "LLM" and SERVED_MODEL in scenario["trace"][0]["source"]
    assert result["answer"].startswith("Hujan lebat")


def test_the_last_step_is_offered_no_tools_so_the_loop_ends(provider):
    steps = assistant_module._MAX_AGENT_STEPS
    provider["replies"] = [
        _message(tool_calls=[_tool_call(f"c{i}", "get_weather", {"day": i})]) for i in range(steps - 1)
    ] + [_message("Cuaca: data simulasi.")]
    with patch("app.assistant.tools._TOOLS_IMPL", {**_impl(), "get_weather": lambda a, c: {"ok": True}}):
        result = answer_with_openai_if_configured("bagaimana cuaca minggu ini?", {}, tool_ctx=_ctx())
    requests = provider["requests"]
    assert len(requests) == steps
    assert all("tools" in r for r in requests[:-1]) and "tools" not in requests[-1]
    assert result["answer"] == "Cuaca: data simulasi." and result["mode"] == "llm"


def test_the_tool_budget_across_steps_is_capped(provider):
    executed = []

    def weather(args, ctx):
        executed.append(args)
        return {"ok": True}

    provider["replies"] = [
        _message(
            tool_calls=[
                _tool_call(f"c{i}a", "get_weather", {"n": i}),
                _tool_call(f"c{i}b", "get_weather", {"m": i}),
            ]
        )
        for i in range(3)
    ] + [_message("Selesai.")]
    with patch("app.assistant.tools._TOOLS_IMPL", {**_impl(), "get_weather": weather}):
        answer_with_openai_if_configured("bagaimana cuaca minggu ini?", {}, tool_ctx=_ctx())
    assert len(executed) == assistant_module._MAX_TOOL_CALLS_TOTAL
    # Once the budget is spent the next call is the final one, without tools.
    assert "tools" not in provider["requests"][-1]


@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        ((401, {"error": {"message": "bad key"}}), "HTTP 401"),
        ((200, {"model": SERVED_MODEL, "choices": []}), "invalid provider response"),
        (_message(""), "invalid provider response"),
    ],
)
def test_provider_errors_fall_back_to_the_local_parser_labelled(provider, fake_scene, reply, reason):
    provider["replies"] = [reply]
    result = answer_with_openai_if_configured(
        "What if it rains heavily tomorrow?", {}, tool_ctx=_ctx(), language="en"
    )
    assert result["provider"] == "local" and result["mode"] == "fallback"
    assert result["fallback_reason"] == reason
    assert result["llm_model"] == "configured-model"
    assert result["answer"].startswith(
        f"The LLM provider failed ({reason}); this answer comes from the local parser"
    )
    assert "bad key" not in result["answer"] and "test-key" not in result["answer"]
    # The local parser still ran the scenario, and its trace says so.
    assert result["scenario"]["trace"][0]["class"] == "LOCAL_PARSER"
    assert result["scenario"]["scenario"]["rainfall_mm"] == 75.0


def test_the_agent_deadline_bounds_the_whole_loop(provider, monkeypatch):
    clock = iter([0.0, 0.0, 100.0, 100.0])
    monkeypatch.setattr(assistant_module.time, "monotonic", lambda: next(clock, 100.0))
    provider["replies"] = [_message(tool_calls=[_tool_call("c1", "get_weather", {})]), _message("late")]
    with patch("app.assistant.tools._TOOLS_IMPL", {**_impl(), "get_weather": lambda a, c: {"ok": True}}):
        result = answer_with_openai_if_configured("bagaimana cuaca?", {}, tool_ctx=_ctx())
    assert len(provider["requests"]) == 1
    assert result["mode"] == "fallback" and result["fallback_reason"] == "timeout"


def _impl():
    from app.assistant.tools import _TOOLS_IMPL

    return dict(_TOOLS_IMPL)


def test_extreme_rain_runs_at_the_twin_maximum_and_says_it_is_a_lower_bound(fake_scene):
    result = execute_tool("run_scenario", parse_scenario_question("kalau hujan ekstrem besok?"), _ctx())
    category = result["scenario"]["rain_category"]
    assert category["rainfall_mm"] == 150.0 and category["range_mm_per_day"] == ">150"
    assert category["lower_bound"] is True
    assert "maksimum twin, jadi batas bawah" in scenario_answer(result, "id")
    assert result["scenario"]["snapped_to_twin_presets"] is False


def test_a_what_if_the_llm_answers_without_the_tool_is_run_by_the_local_parser(provider, fake_scene):
    provider["replies"] = [_message("Hujan deras pasti menambah sampah 900 ton.")]
    result = answer_with_openai_if_configured("kalau hujan deras besok?", {}, tool_ctx=_ctx())
    assert result["mode"] == "fallback" and result["fallback_reason"] == "no scenario tool call"
    assert "900" not in result["answer"]
    assert result["scenario"]["scenario"]["rainfall_mm"] == 75.0
    assert result["scenario"]["trace"][0]["class"] == "LOCAL_PARSER"
