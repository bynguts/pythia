"""Ana what-if scenarios: parser, run_scenario payload, Twin/XR links, local answer, privacy."""

import json
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

import pytest

from app.assistant.assistant import _required_live_tools, answer_with_openai_if_configured
from app.assistant.scenario import (
    parse_scenario_question,
    question_language,
    scenario_answer,
    scenario_links,
    snap_to_twin,
)
from app.assistant.tools import _TOOLS_IMPL, TOOL_SCHEMAS, ToolContext, execute_tool
from app.core.units import CREW_SIZE_WORKERS, TRUCK_CAPACITY_TONS
from app.forecast.cities import get_venue

GBK = get_venue("jakarta", "gbk")


def _ctx():
    return ToolContext(dispatch_center=MagicMock(audit_log=lambda: []), history_store=MagicMock())


def _fake_twin_scene(
    city="jakarta",
    days=7,
    rainfall_mm=0.0,
    event_attendance=0,
    event_lat=None,
    event_lng=None,
    venue=None,
    day=0,
):
    """Two districts, seven days: Gambir spikes 40 t over normal, Menteng 5 t."""
    dates = [f"2026-10-{22 + i}" for i in range(days)]

    def district(name, normal, extra, risk):
        return {
            "name": name,
            "admin_area": "Jakarta Pusat",
            "series": [
                {"date": d, "predicted_tons": normal + extra, "normal_tons": normal, "risk": risk}
                for d in dates
            ],
        }

    return {
        "horizon": {"dates": dates},
        "districts": [
            district("Gambir", 100.0, 40.0, "critical"),
            district("Menteng", 80.0, 5.0, "elevated"),
        ],
        "provenance": {"districts": {"class": "MODEL_OUTPUT", "source": "Prophet + XGBoost per kecamatan"}},
        "landfill_queue": {
            "minutes_per_truck": {
                "baseline_mean": 42.5,
                "staggered_mean": 18.0,
                "baseline_p95": 90.0,
                "staggered_p95": 35.0,
                "replications": 30,
                "trucks_per_day": 1400,
                "classification": "SIMULATED",
                "source": "Seeded discrete-event queue simulation",
                "scenario_scaled": True,
                "normal_day": {"trucks_per_day": 1233, "baseline_mean": 30.0, "staggered_mean": 6.0},
                "sensitivity": {"baseline_band": [28.9, 47.1], "rows": []},
            }
        },
        "scenario": {"rainfall_mm": rainfall_mm, "event_attendance": event_attendance},
    }


@pytest.fixture()
def fake_scene():
    calls = []

    def scene(**kwargs):
        calls.append(kwargs)
        return _fake_twin_scene(**kwargs)

    with patch("app.api.routers.twin.twin_scene", side_effect=scene):
        yield calls


@pytest.mark.parametrize(
    ("question", "expected", "language"),
    [
        (
            "What if 80 mm of rain hits during a 50k concert at GBK tomorrow?",
            {"city": "jakarta", "rainfall_mm": 80.0, "event_attendance": 50_000, "venue": "GBK", "day": 1},
            "en",
        ),
        (
            "kalau hujan 80 mm pas konser 50 ribu di GBK besok?",
            {"city": "jakarta", "rainfall_mm": 80.0, "event_attendance": 50_000, "venue": "GBK", "day": 1},
            "id",
        ),
        (
            "jika hujan 12,5 mm dan event 50.000 orang di JIS lusa",
            {"city": "jakarta", "rainfall_mm": 12.5, "event_attendance": 50_000, "venue": "JIS", "day": 2},
            "id",
        ),
        (
            "what if 100k people at Monas today",
            {"city": "jakarta", "rainfall_mm": 0.0, "event_attendance": 100_000, "venue": "Monas", "day": 0},
            "en",
        ),
        (
            "what if 60 mm rain hits Ho Chi Minh City day +3",
            {"city": "hcmc", "rainfall_mm": 60.0, "event_attendance": 0, "venue": "District 1", "day": 3},
            "en",
        ),
        (
            "seandainya hujan 30 mm 9 hari lagi",
            {"city": "jakarta", "rainfall_mm": 30.0, "event_attendance": 0, "venue": "GBK", "day": 6},
            "id",
        ),
    ],
)
def test_parser_reads_rain_crowd_venue_and_day(question, expected, language):
    assert parse_scenario_question(question) == expected
    assert question_language(question, "id" if language == "en" else "en") == language


@pytest.mark.parametrize(
    "question",
    [
        "berapa truk rusak?",
        "hujan hari ini?",
        "prakiraan cuaca besok",
        "apa itu Pythia?",
        "laporan 2026 orang",
    ],
)
def test_parser_ignores_non_scenario_questions(question):
    assert parse_scenario_question(question) is None


def test_scenario_questions_require_the_scenario_tool():
    assert _required_live_tools("kalau hujan 80 mm pas konser 50 ribu di GBK besok?") == {"run_scenario"}
    assert _required_live_tools("berapa antrean TPA?") == {"get_tpa_queue", "get_command_center_snapshot"}


def test_links_follow_the_twin_and_xr_contract():
    links = scenario_links("jakarta", 80.0, 70_000, 1, GBK)
    twin = urlparse(links["twin"])
    assert twin.path == "/twin"
    assert parse_qs(twin.query) == {
        "city": ["jakarta"],
        "rain": ["80"],
        "event": ["50k"],
        "venue": ["gbk"],
        "day": ["1"],
        "present": ["1"],
    }
    xr = urlparse(links["xr"])
    assert xr.path == "/xr"
    assert parse_qs(xr.query) == {
        "city": ["jakarta"],
        "rainfall_mm": ["80.0"],
        "event_attendance": ["70000"],
        "event_lat": ["-6.2183"],
        "event_lng": ["106.8022"],
    }
    # Presets snap to the nearest; rain clamps to the twin slider range.
    assert "event=100k" in scenario_links("jakarta", 200.0, 80_000, 0, GBK)["twin"]
    assert "rain=150" in scenario_links("jakarta", 200.0, 80_000, 0, GBK)["twin"]
    no_event = scenario_links("hcmc", 10.0, 0, 2, GBK)
    assert "event=none" in no_event["twin"] and "city=hcmc" in no_event["twin"]
    assert "venue=" not in no_event["twin"]
    assert "event_lat" not in no_event["xr"]


def test_run_scenario_payload_is_compact_labelled_and_reuses_the_twin_forecast(fake_scene):
    result = execute_tool(
        "run_scenario",
        {"rainfall_mm": 80, "event_attendance": 50_000, "venue": "JIS", "day": 1},
        _ctx(),
    )
    call = fake_scene[0]
    assert call["city"] == "jakarta" and call["rainfall_mm"] == 80.0 and call["event_attendance"] == 50_000
    assert (call["event_lat"], call["event_lng"]) == (-6.1246, 106.8584)
    assert call["venue"] == "jis" and call["day"] == 1  # the twin scales the queue to this day

    assert result["classification"] == "MODEL_OUTPUT"
    assert result["scenario"] == {
        "rainfall_mm": 80.0,
        "event_attendance": 50_000,
        "venue": "JIS",
        "venue_id": "jis",
        "day": 1,
        "date": "2026-10-23",
        "requested": {"rainfall_mm": 80.0, "event_attendance": 50_000},
        "snapped_to_twin_presets": False,
        "attendance_assumed": False,
        "rain_category": None,
    }
    summary = result["summary"]
    assert summary["extra_tons"] == pytest.approx(45.0)
    assert summary["total_tons"] == pytest.approx(225.0)
    assert summary["trucks_required"] == 13  # ceil(225 / 18)
    assert summary["extra_trucks"] == summary["extra_crews"] == 3  # ceil(45 / 18)
    assert summary["extra_workers"] == 12
    assert summary["truck_capacity_tons"] == TRUCK_CAPACITY_TONS
    assert summary["districts_at_risk"] == 1
    assert [d["name"] for d in result["top_districts"]] == ["Gambir", "Menteng"]
    assert result["queue_minutes_per_truck"]["classification"] == "SIMULATED"
    queue = result["queue_minutes_per_truck"]
    assert queue["scenario_scaled"] is True
    assert queue["trucks_per_day"] == 1400 and queue["normal_day"]["trucks_per_day"] == 1233
    assert result["plan"] == [
        "parse_scenario",
        "district_forecast",
        "normal_day_baseline",
        "resource_units",
        "queue_metric",
    ]
    assert {s["id"] for s in result["sources"]} == {"district_forecast", "resource_units", "landfill_queue"}
    assert result["links"]["twin"] == "/twin?city=jakarta&rain=80&event=50k&venue=jis&day=1&present=1"
    assert "event_lat=-6.1246" in result["links"]["xr"]
    assert len(json.dumps(result)) < 8000


def test_run_scenario_snaps_to_the_twin_presets_and_keeps_the_request(fake_scene):
    result = execute_tool(
        "run_scenario", {"rainfall_mm": 83, "event_attendance": 70_000, "venue": "gbk", "day": 1}, _ctx()
    )
    call = fake_scene[0]
    # The twin runs what its slider and crowd presets can show: 85 mm, the 50k preset.
    assert call["rainfall_mm"] == 85.0 and call["event_attendance"] == 50_000
    scenario = result["scenario"]
    assert scenario["rainfall_mm"] == 85.0 and scenario["event_attendance"] == 50_000
    assert scenario["requested"] == {"rainfall_mm": 83.0, "event_attendance": 70_000}
    assert scenario["snapped_to_twin_presets"] is True
    assert result["links"]["twin"] == "/twin?city=jakarta&rain=85&event=50k&venue=gbk&day=1&present=1"
    assert "rainfall_mm=85.0" in result["links"]["xr"] and "event_attendance=50000" in result["links"]["xr"]


@pytest.mark.parametrize(
    ("rain", "attendance", "expected"),
    [
        (2.5, 0, (5.0, 0)),  # half-up like the twin slider's Math.round
        (2.4, 24_999, (0.0, 0)),
        (240, 2_000_000, (150.0, 100_000)),
        (150, 75_001, (150.0, 100_000)),
    ],
)
def test_snap_to_twin_matches_the_twin_controls(rain, attendance, expected):
    assert snap_to_twin(rain, attendance) == expected


def test_local_answer_says_when_the_scenario_was_snapped(fake_scene):
    with patch.dict("os.environ", {}, clear=True):
        en = answer_with_openai_if_configured(
            "What if 83 mm of rain hits during a 70k concert at GBK tomorrow?", {}, tool_ctx=_ctx()
        )["answer"]
        id_ = answer_with_openai_if_configured(
            "kalau hujan 83 mm pas konser 70 ribu di GBK besok?", {}, tool_ctx=_ctx()
        )["answer"]
    assert "85 mm rain + 50,000-person event at GBK" in en
    assert "Snapped to the twin's presets" in en and "you asked 83 mm rain + 70,000-person event" in en
    assert "Disesuaikan ke preset twin" in id_ and "Anda meminta 83 mm hujan + event 70,000 orang" in id_
    exact = execute_tool("run_scenario", {"rainfall_mm": 80, "event_attendance": 50_000}, _ctx())
    assert "Snapped" not in scenario_answer(exact, "en")


def test_run_scenario_keeps_the_queue_sensitivity_band(fake_scene):
    # The card showed "42.5 -> 18" without the band the Twin HUD prints next to it.
    queue = execute_tool("run_scenario", {"rainfall_mm": 80}, _ctx())["queue_minutes_per_truck"]
    assert queue["baseline_band"] == [28.9, 47.1]
    assert queue["baseline_band"][0] <= queue["baseline_mean"] <= queue["baseline_band"][1]
    assert queue["classification"] == "SIMULATED"

    def scene(**kwargs):
        payload = _fake_twin_scene(**kwargs)
        del payload["landfill_queue"]["minutes_per_truck"]["sensitivity"]
        return payload

    with patch("app.api.routers.twin.twin_scene", side_effect=scene):
        bare = execute_tool("run_scenario", {"rainfall_mm": 80}, _ctx())["queue_minutes_per_truck"]
    assert bare["baseline_band"] is None


def test_extra_crews_equal_extra_trucks_by_the_one_crew_per_truck_rule(fake_scene):
    summary = execute_tool("run_scenario", {"rainfall_mm": 80}, _ctx())["summary"]
    # Not a copy-paste bug: one crew team operates one truck per shift (core/units).
    assert summary["extra_crews"] == summary["extra_trucks"] > 0
    assert summary["crew_size_workers"] == CREW_SIZE_WORKERS
    assert summary["extra_workers"] == summary["extra_crews"] * CREW_SIZE_WORKERS


def test_run_scenario_without_queue_metric_omits_the_queue_step():
    def scene(**kwargs):
        payload = _fake_twin_scene(**kwargs)
        payload["landfill_queue"] = None
        return payload

    with patch("app.api.routers.twin.twin_scene", side_effect=scene):
        result = execute_tool("run_scenario", {"rainfall_mm": 20}, _ctx())
    assert result["queue_minutes_per_truck"] is None
    assert "queue_metric" not in result["plan"]
    assert result["scenario"]["venue"] is None


def test_run_scenario_on_the_demo_city_uses_the_real_twin_path():
    result = execute_tool("run_scenario", {"city": "hcmc", "event_attendance": 50_000, "day": 0}, _ctx())
    assert result["classification"] == "SIMULATED_DEMO_CITY"
    assert result["top_districts"][0]["name"] == "District 1"
    assert result["top_districts"][0]["extra_tons"] == pytest.approx(60.0, abs=0.2)
    assert result["queue_minutes_per_truck"] is None
    assert result["links"]["twin"] == "/twin?city=hcmc&rain=0&event=50k&venue=d1&day=0&present=1"


def test_invalid_city_returns_a_tool_error_not_a_crash():
    result = execute_tool("run_scenario", {"city": "atlantis"}, _ctx())
    assert "error" in result


def test_local_fallback_answers_in_english_with_the_scenario_card(fake_scene):
    with patch.dict("os.environ", {}, clear=True):
        result = answer_with_openai_if_configured(
            "What if 80 mm of rain hits during a 50k concert at GBK tomorrow?",
            {},
            tool_ctx=_ctx(),
            language="id",
        )
    assert result["provider"] == "local"
    assert result["tools_used"] == ["run_scenario"]
    assert (
        result["scenario"]["links"]["twin"]
        == "/twin?city=jakarta&rain=80&event=50k&venue=gbk&day=1&present=1"
    )
    answer = result["answer"]
    assert answer.startswith("Local mode")
    assert "MODEL OUTPUT" in answer and "not an observation" in answer
    assert "Gambir" in answer and "13 trucks" in answer and "+3 trucks" in answer
    assert "42.5 min/truck" in answer and "SIMULATED" in answer
    # The queue is scaled to the scenario, not a baseline-only figure.
    assert "scaled to this scenario" in answer and "1,400 trucks/day" in answer and "1,233" in answer
    assert "not recomputed" not in answer
    for claim in ("dispatched", "approved", "sent"):
        assert claim not in answer.lower()


def test_local_fallback_answers_in_indonesian(fake_scene):
    with patch.dict("os.environ", {}, clear=True):
        result = answer_with_openai_if_configured(
            "kalau hujan 80 mm pas konser 50 ribu di GBK besok?", {}, tool_ctx=_ctx(), language="en"
        )
    assert result["answer"].startswith("Mode lokal")
    assert "Skenario" in result["answer"] and "bukan pengamatan" in result["answer"]
    assert "13 truk" in result["answer"]
    assert "disesuaikan dengan skenario" in result["answer"] and "1,400 truk/hari" in result["answer"]


def test_gateway_path_attaches_the_scenario_payload(fake_scene):
    calls = []

    def fake_urlopen(request, timeout=0):
        payload = json.loads(request.data.decode())
        calls.append(payload)
        if len(calls) == 1:
            assert any(t["function"]["name"] == "run_scenario" for t in payload["tools"])
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "run_scenario",
                            "arguments": json.dumps({"rainfall_mm": 80, "event_attendance": 50000, "day": 1}),
                        },
                    }
                ],
            }
        else:
            message = {"role": "assistant", "content": "Gambir paling berisiko (MODEL OUTPUT)."}
        mock = MagicMock()
        mock.read.return_value = json.dumps({"choices": [{"message": message}]}).encode()
        mock.__enter__.return_value = mock
        return mock

    with (
        patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}),
        patch("app.assistant.assistant.urlopen", side_effect=fake_urlopen),
    ):
        result = answer_with_openai_if_configured(
            "kalau hujan 80 mm pas konser 50 ribu di GBK besok?", {}, tool_ctx=_ctx()
        )
    assert result["provider"] == "openai"
    assert result["tools_used"] == ["run_scenario"]
    assert result["scenario"]["summary"]["extra_trucks"] == 3
    assert len(calls) == 2
    # The trace names the LLM as the parser, then the steps the tool ran.
    trace = result["scenario"]["trace"]
    assert trace[0]["step"] == "parse_scenario" and trace[0]["class"] == "LLM"
    assert "gpt-4.1-mini" in trace[0]["source"]


def test_run_scenario_returns_a_tool_trace_with_sources_and_provenance(fake_scene):
    result = execute_tool(
        "run_scenario", {"rainfall_mm": 120, "event_attendance": 50_000, "venue": "JIS", "day": 1}, _ctx()
    )
    trace = result["trace"]
    assert [s["step"] for s in trace] == [
        "run_scenario",
        "forecast_model",
        "resource_rule",
        "queue_simulation",
    ]
    assert trace[0]["detail"] == {
        "rainfall_mm": 120.0,
        "event_attendance": 50_000,
        "venue": "jis",
        "day": 1,
        "snapped": False,
        "rain_category": None,
    }
    assert trace[1]["class"] == "MODEL_OUTPUT" and "Prophet + XGBoost" in trace[1]["source"]
    assert trace[2]["class"] == "PLANNING_RULE"
    assert trace[3]["class"] == "SIMULATED" and trace[3]["detail"]["trucks_per_day"] == 1400
    assert all(step["source"] for step in trace)
    assert len(json.dumps(result)) < 8000  # still fits the LLM tool message


def test_named_venue_concert_without_a_crowd_size_assumes_the_smallest_preset(fake_scene):
    question = "what if 120 mm of rain hits during the JIS concert tomorrow"
    parsed = parse_scenario_question(question)
    assert parsed == {
        "city": "jakarta",
        "rainfall_mm": 120.0,
        "event_attendance": 50_000,
        "venue": "JIS",
        "day": 1,
        "attendance_assumed": True,
    }
    # No venue named, or no event word: nothing is assumed.
    assert parse_scenario_question("what if 120 mm of rain hits tomorrow")["event_attendance"] == 0
    assert parse_scenario_question("what if 120 mm of rain hits JIS tomorrow")["event_attendance"] == 0
    with patch.dict("os.environ", {}, clear=True):
        result = answer_with_openai_if_configured(question, {}, tool_ctx=_ctx(), language="en")
    scenario = result["scenario"]
    assert scenario["scenario"]["attendance_assumed"] is True
    assert scenario["scenario"]["venue_id"] == "jis" and scenario["scenario"]["day"] == 1
    assert scenario["links"]["twin"] == "/twin?city=jakarta&rain=120&event=50k&venue=jis&day=1&present=1"
    assert "Crowd size not given: assumed 50,000" in result["answer"]
    steps = [s["step"] for s in scenario["trace"]]
    assert steps == ["parse_scenario", "run_scenario", "forecast_model", "resource_rule", "queue_simulation"]
    assert scenario["trace"][0]["class"] == "LOCAL_PARSER"
    assert result["provider"] == "local"


def test_fleet_status_tool_never_sends_driver_names_to_the_llm():
    truck = {
        "truck_code": "T-001",
        "driver_name": "Placeholder Driver",
        "assigned_zone": "Gambir",
        "status": "active",
        "is_damaged": True,
        "deviation": {"violated": False, "distance_meters": 0, "severity": "none"},
        "latest_position": {"speed_kmh": 20},
    }
    with patch("app.assistant.tools.get_dynamic_trucks", return_value=[truck]):
        for args in ({}, {"truck_code": "T-001"}):
            text = json.dumps(execute_tool("get_fleet_status", args, _ctx()))
            assert "driver_name" not in text and "Placeholder Driver" not in text


def test_route_options_tool_with_fixed_coordinates_is_not_offered():
    names = {s["function"]["name"] for s in TOOL_SCHEMAS}
    assert "get_route_options" not in names and "get_route_options" not in _TOOLS_IMPL
    assert names == set(_TOOLS_IMPL)
    # Every tool the answer gate may require must be one Ana can actually call.
    required = _required_live_tools("status armada truk hari ini")
    assert "get_route_options" not in required and required <= names
