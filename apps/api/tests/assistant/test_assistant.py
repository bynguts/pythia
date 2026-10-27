import unittest
from unittest.mock import patch

from app.assistant.assistant import answer_with_openai_if_configured, build_executive_summary


class AssistantTests(unittest.TestCase):
    def test_answer_falls_back_to_local_responder_without_api_key(self):
        snapshot = {
            "kpis": {"active_trucks": 0, "trucks_with_issues": 0, "tpa_wait_minutes": 10},
            "alerts": [],
            "predictions": [],
            "critical_predictions": [],
        }

        with patch.dict("os.environ", {}, clear=True):
            result = answer_with_openai_if_configured("berapa truk?", snapshot, tool_ctx=None)

        # No key → labelled local responder, not a 502 (issue #9).
        self.assertEqual(result["provider"], "local")
        self.assertEqual(result["mode"], "local")
        self.assertIn("Mode lokal", result["answer"])

    def test_gateway_failure_falls_back_to_the_labelled_local_parser(self):
        snapshot = {
            "kpis": {"active_trucks": 5, "trucks_with_issues": 2, "tpa_wait_minutes": 116},
            "predictions": [
                {
                    "district": "Jakarta Barat",
                    "date": "2026-07-18",
                    "predicted_tons": 2202.2,
                    "spike_percent": -1,
                },
                {
                    "district": "Jakarta Utara",
                    "date": "2026-07-18",
                    "predicted_tons": 1844.4,
                    "spike_percent": -2,
                },
                {
                    "district": "Jakarta Timur",
                    "date": "2026-07-18",
                    "predicted_tons": 2510.0,
                    "spike_percent": 0,
                },
            ],
            "critical_predictions": [],
            "alerts": [],
        }

        called = {}

        def fake_urlopen(request, timeout=0):
            called["url"] = str(request.full_url)
            from urllib.error import URLError

            raise URLError("offline test")

        with patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}):
            with patch("app.assistant.assistant.urlopen", side_effect=fake_urlopen):
                result = answer_with_openai_if_configured(
                    "perkiraan total tonase sampah dki 7 hari kedepan", snapshot
                )

        self.assertIn("/chat/completions", called["url"])
        # Never a dead end, never an answer that claims the LLM ran.
        self.assertEqual(result["provider"], "local")
        self.assertEqual(result["mode"], "fallback")
        self.assertEqual(result["fallback_reason"], "provider unreachable")
        self.assertIn("parser lokal, bukan LLM", result["answer"])
        self.assertNotIn("offline test", result["answer"])

    def test_answer_with_openai_accepts_history(self):
        snapshot = {
            "kpis": {"active_trucks": 0, "trucks_with_issues": 0, "tpa_wait_minutes": 10},
            "alerts": [],
            "predictions": [],
            "critical_predictions": [],
        }
        sent_messages = {}

        def fake_urlopen(request, timeout=0):
            import json as _json

            payload = _json.loads(request.data.decode("utf-8"))
            sent_messages["count"] = len(payload["messages"])
            sent_messages["roles"] = [m["role"] for m in payload["messages"]]
            body = _json.dumps({"choices": [{"message": {"role": "assistant", "content": "oi"}}]}).encode()
            from unittest.mock import MagicMock

            mock = MagicMock()
            mock.read.return_value = body
            mock.__enter__.return_value = mock
            return mock

        with patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}):
            with patch("app.assistant.assistant.urlopen", side_effect=fake_urlopen):
                result = answer_with_openai_if_configured(
                    "terus?", snapshot, history=[{"role": "user", "content": "berapa truk?"}]
                )

        self.assertEqual(result["provider"], "openai")
        self.assertEqual(sent_messages["count"], 3)
        self.assertEqual(sent_messages["roles"][:2], ["system", "user"])

    def test_history_sanitized_to_user_assistant_roles(self):
        from app.assistant.assistant import _sanitize_history

        history = [
            {"role": "system", "content": "hack"},
            {"role": "user", "content": "a" * 5000},
            {"role": "assistant", "content": ""},
            {"role": "tool", "content": "t"},
        ]
        clean = _sanitize_history(history)
        self.assertTrue(all(m["role"] in {"user", "assistant"} for m in clean))
        self.assertLessEqual(len(clean[0]["content"]), 2000)

    def test_tool_calls_per_turn_are_capped_and_duplicates_skipped(self):
        snapshot = {}
        calls = []
        executed = []

        def fake_urlopen(request, timeout=0):
            import json
            from unittest.mock import MagicMock

            payload = json.loads(request.data)
            calls.append(payload)
            if len(calls) == 1:
                content = {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": f"call-{i}",
                                        "type": "function",
                                        "function": {
                                            "name": "get_tpa_queue",
                                            "arguments": "{}",
                                        },
                                    }
                                    for i in range(3)
                                ],
                            }
                        }
                    ],
                }
            else:
                # Not the last step, so the model may still call tools after seeing the results.
                self.assertIn("tools", payload)
                self.assertEqual(len([m for m in payload["messages"] if m["role"] == "tool"]), 3)
                self.assertIn("limit", payload["messages"][-1]["content"])
                content = {"choices": [{"message": {"role": "assistant", "content": "Antrean TPA padat."}}]}
            mock = MagicMock()
            mock.read.return_value = json.dumps(content).encode()
            mock.__enter__.return_value = mock
            return mock

        def fake_execute(name, args, ctx):
            executed.append(name)
            return {"status_label": "padat"}

        with (
            patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}),
            patch("app.assistant.assistant.urlopen", side_effect=fake_urlopen),
            patch("app.assistant.tools.execute_tool", side_effect=fake_execute),
        ):
            from app.assistant.tools import ToolContext

            result = answer_with_openai_if_configured(
                "berapa antrean TPA?",
                snapshot,
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertEqual(result["answer"], "Antrean TPA padat.")
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(executed), 1, "duplicate tool calls should not execute twice")
        self.assertEqual(calls[0]["messages"][-1]["content"], "berapa antrean TPA?")
        self.assertNotIn("prediksi", calls[0]["messages"][-1]["content"].lower())

    def test_local_fallback_uses_matching_fleet_tool_only(self):
        from app.assistant.tools import ToolContext

        data = {"total_trucks": 8, "problem_count": 2}
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.assistant.assistant.execute_tool", return_value=data) as tool,
        ):
            result = answer_with_openai_if_configured(
                "berapa truk bermasalah?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        tool.assert_called_once()
        self.assertEqual(tool.call_args.args[0], "get_fleet_status")
        self.assertIn("2", result["answer"])
        self.assertNotIn("prediksi", result["answer"].lower())
        self.assertEqual(result["tools_used"], ["get_fleet_status"])

    def test_local_fleet_counts_keep_damage_and_deviation_separate(self):
        from app.assistant.tools import ToolContext

        fleet = {
            "total_trucks": 8,
            "active_count": 6,
            "problem_count": 3,
            "damaged_count": 2,
            "deviation_count": 1,
            "problem_trucks": [
                {"truck_code": "T-001", "is_damaged": True, "deviation_violated": False},
                {"truck_code": "T-002", "is_damaged": True, "deviation_violated": False},
                {"truck_code": "T-003", "is_damaged": False, "deviation_violated": True},
            ],
        }
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.assistant.assistant.execute_tool", return_value=fleet),
        ):
            result = answer_with_openai_if_configured(
                "berapa truk yang mengalami deviasi rute?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertIn("1 truk mengalami deviasi rute", result["answer"])
        self.assertNotIn("3 truk", result["answer"])

    def _outlook_week(self):
        from datetime import timedelta

        from app.core.env import today

        start = today()
        days = []
        for i in range(7):
            days.append(
                {
                    "date": (start + timedelta(days=i)).isoformat(),
                    "total_tons": 7000.0 + i * 100,
                    "corrected_tons": None,
                    "with_events_total_t": 7000.0 + i * 100,
                    "beyond_weather_forecast": False,
                    "drivers": [],
                }
            )
        return {
            "week": {"days": days},
            "monthly_intake": {"available": False, "months": []},
            "learned_correction": None,
        }

    def test_local_mode_answers_tomorrows_tonnes_in_indonesian_and_english(self):
        from datetime import timedelta

        from app.assistant.tools import ToolContext
        from app.core.env import today

        tomorrow = (today() + timedelta(days=1)).isoformat()
        for question, lang, expected in (
            ("berapa ton besok?", "id", f"Besok ({tomorrow}), sampah se-kota (MODEL OUTPUT): 7,100 t/hari."),
            (
                "how many tonnes tomorrow?",
                "en",
                f"Tomorrow ({tomorrow}), city-wide waste (MODEL OUTPUT): 7,100 t/day.",
            ),
        ):
            with (
                patch.dict("os.environ", {}, clear=True),
                patch("app.assistant.assistant.execute_tool", return_value=self._outlook_week()) as tool,
            ):
                result = answer_with_openai_if_configured(
                    question,
                    {},
                    tool_ctx=ToolContext(dispatch_center=None, history_store=None),
                    language=lang,
                )
            # The same outlook tool as "next week", read for tomorrow's day only.
            self.assertEqual(tool.call_args.args[0], "get_forecast_outlook")
            self.assertEqual(result["tools_used"], ["get_forecast_outlook"])
            self.assertIn(expected, result["answer"])
            self.assertNotIn("mode lokal. Mode lokal dapat", result["answer"])
            self.assertNotIn("no data matching", result["answer"])

    def test_local_mode_tomorrow_says_when_no_weather_forecast_covers_it(self):
        from app.assistant.tools import ToolContext

        week = self._outlook_week()
        tomorrow = week["week"]["days"][1]
        tomorrow.update(corrected_tons=6900.0, with_events_total_t=7300.0, beyond_weather_forecast=True)
        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.assistant.assistant.execute_tool", return_value=week),
        ):
            result = answer_with_openai_if_configured(
                "berapa ton sampah besok?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertIn("koreksi dari jembatan timbang: 6,900 t", result["answer"])
        self.assertIn("acara berizin hari itu: 7,300 t", result["answer"])
        self.assertIn("hujan 0 mm", result["answer"])

    def test_local_mode_next_week_still_answers_the_whole_week(self):
        from app.assistant.tools import ToolContext

        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.assistant.assistant.execute_tool", return_value=self._outlook_week()),
        ):
            result = answer_with_openai_if_configured(
                "berapa ton besok dan minggu depan?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertIn("7 hari ke depan", result["answer"])
        self.assertNotIn("tanpa prakiraan", result["answer"])

    def test_local_mode_answers_14_and_30_days_as_a_summary(self):
        from datetime import timedelta

        from app.assistant.tools import ToolContext
        from app.core.env import today

        def outlook(name, args, ctx):
            n = args["days"]
            days = [
                {
                    "date": (today() + timedelta(days=i)).isoformat(),
                    "total_tons": 9000.0 if i == 4 else 8000.0,
                    "corrected_tons": None,
                    "beyond_weather_forecast": i >= 16,
                }
                for i in range(n)
            ]
            total = sum(d["total_tons"] for d in days)
            summary = {
                "total_tons": total,
                "avg_tons_per_day": round(total / n, 1),
                "peak_date": days[4]["date"],
                "peak_tons": 9000.0,
                "peak_trucks_needed": 520,
                "corrected_total_tons": None,
            }
            return {
                "week": {"days": days, "summary": summary},
                "monthly_intake": {"available": False, "months": []},
                "learned_correction": None,
            }

        peak = (today() + timedelta(days=4)).isoformat()
        for question, lang, days, expected in (
            (
                "berapa ton sampah 30 hari ke depan?",
                "id",
                30,
                f"Sampah se-kota, 30 hari ke depan (MODEL OUTPUT): total 241,000 t, rata-rata 8,033 t/hari, "
                f"puncak {peak} sebesar 9,000 t, 520 truk saat puncak.",
            ),
            (
                "how much waste over the next two weeks?",
                "en",
                14,
                f"City-wide waste, next 14 days (MODEL OUTPUT): 113,000 t in total, 8,071 t/day on average, "
                f"peak {peak} at 9,000 t, 520 trucks at the peak.",
            ),
        ):
            with (
                patch.dict("os.environ", {}, clear=True),
                patch("app.assistant.assistant.execute_tool", side_effect=outlook) as tool,
            ):
                result = answer_with_openai_if_configured(
                    question,
                    {},
                    tool_ctx=ToolContext(dispatch_center=None, history_store=None),
                    language=lang,
                )
            self.assertEqual(tool.call_args.args[:2], ("get_forecast_outlook", {"days": days}))
            self.assertIn(expected, result["answer"])
            # A summary, not every date.
            self.assertNotIn((today() + timedelta(days=10)).isoformat(), result["answer"])
            if days == 30:
                self.assertIn("16 hari pertama; 14 hari terakhir memakai basis hari kering", result["answer"])
            else:
                self.assertNotIn("dry-day baseline", result["answer"])

    def test_local_fallback_does_not_invent_metrics_when_tool_fails(self):
        from app.assistant.tools import ToolContext

        with (
            patch.dict("os.environ", {}, clear=True),
            patch("app.assistant.assistant.execute_tool", return_value={"error": "offline"}),
        ):
            result = answer_with_openai_if_configured(
                "berapa truk?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertIn("belum tersedia", result["answer"])
        self.assertEqual(result["tools_used"], [])

    def test_photo_goes_to_gateway_without_unrelated_snapshot(self):
        import json
        from unittest.mock import MagicMock

        sent = {}

        def fake_urlopen(request, timeout=0):
            sent["payload"] = json.loads(request.data)
            sent["timeout"] = timeout
            response = MagicMock()
            response.read.return_value = b'{"choices":[{"message":{"content":"Foto memperlihatkan truk."}}]}'
            response.__enter__.return_value = response
            return response

        with (
            patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}),
            patch("app.assistant.assistant.urlopen", side_effect=fake_urlopen),
        ):
            result = answer_with_openai_if_configured(
                "apa ini?",
                {},
                images=["data:image/jpeg;base64,YQ=="],
            )
        self.assertEqual(result["provider"], "openai")
        self.assertEqual(sent["payload"]["messages"][-1]["content"][1]["type"], "image_url")
        self.assertNotIn("prediksi", sent["payload"]["messages"][-1]["content"][0]["text"].lower())
        self.assertGreater(sent["timeout"], 18)

    def test_gateway_timeout_falls_back_without_fabricated_answer(self):
        observed = {}

        def timeout(request, timeout=0):
            observed["seconds"] = timeout
            raise TimeoutError("gateway timed out")

        with (
            patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}),
            patch("app.assistant.assistant.urlopen", side_effect=timeout),
        ):
            result = answer_with_openai_if_configured("berapa antrean TPA?", {}, tool_ctx=None)
        self.assertEqual(observed["seconds"], 18)
        self.assertEqual(result["provider"], "local")
        self.assertEqual(result["fallback_reason"], "timeout")
        self.assertIn("Layanan LLM gagal (waktu habis)", result["answer"])

    def test_local_photo_does_not_claim_to_interpret_image(self):
        with patch.dict("os.environ", {}, clear=True):
            result = answer_with_openai_if_configured("apa ini?", {}, images=["data:image/jpeg;base64,YQ=="])
        self.assertIn("memerlukan layanan AI", result["answer"])
        self.assertEqual(result["tools_used"], [])

    def test_live_data_question_without_matching_tool_does_not_relay_model_numbers(self):
        from unittest.mock import MagicMock

        response = MagicMock()
        response.read.return_value = b'{"choices":[{"message":{"content":"Ada 999 truk."}}]}'
        response.__enter__.return_value = response
        with (
            patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}),
            patch("app.assistant.assistant.urlopen", return_value=response),
        ):
            from app.assistant.tools import ToolContext

            result = answer_with_openai_if_configured(
                "berapa truk saat ini?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertNotIn("999", result["answer"])
        self.assertIn("belum dapat memverifikasi", result["answer"])
        self.assertEqual(result["tools_used"], [])

    def test_fleet_deviation_requires_fleet_status_not_general_snapshot(self):
        import json
        from unittest.mock import MagicMock

        from app.assistant.tools import ToolContext

        first = MagicMock()
        first.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "type": "function",
                                    "function": {"name": "get_command_center_snapshot", "arguments": "{}"},
                                }
                            ],
                        }
                    }
                ]
            }
        ).encode()
        first.__enter__.return_value = first
        second = MagicMock()
        second.read.return_value = b'{"choices":[{"message":{"content":"3 truk deviasi rute."}}]}'
        second.__enter__.return_value = second
        with (
            patch.dict("os.environ", {"OPENAI_API_KEY": "fake-key"}),
            patch("app.assistant.assistant.urlopen", side_effect=[first, second]),
            patch("app.assistant.tools.execute_tool", return_value={"kpis": {"trucks_with_issues": 3}}),
        ):
            result = answer_with_openai_if_configured(
                "berapa truk mengalami deviasi rute?",
                {},
                tool_ctx=ToolContext(dispatch_center=None, history_store=None),
            )
        self.assertNotIn("3 truk deviasi", result["answer"])
        self.assertIn("belum dapat memverifikasi", result["answer"])

    def test_build_executive_summary_is_concise_and_actionable(self):
        snapshot = {
            "kpis": {"active_trucks": 5, "trucks_with_issues": 2, "tpa_wait_minutes": 116},
            "critical_predictions": [
                {"district": "Jakarta Barat", "spike_percent": 41, "recommended_extra_trucks": 29}
            ],
            "alerts": [{"truck_code": "T-047", "title": "Route deviation"}],
        }

        summary = build_executive_summary(snapshot)

        self.assertLessEqual(len(summary.split()), 150)
        self.assertIn("29", summary)
        self.assertIn("T-047", summary)
        # The queue is the modelled peak hour of a simulation, and the fleet is simulated.
        self.assertIn("modelled peak hour (simulated) is 116 minutes", summary)
        self.assertIn("simulated fleet", summary)
        self.assertNotIn("TPA delay", summary)

    def test_local_fleet_and_queue_answers_follow_the_ui_language(self):
        from app.assistant.tools import ToolContext

        fleet = {
            "total_trucks": 40,
            "active_count": 35,
            "damaged_count": 3,
            "deviation_count": 2,
            "problem_count": 5,
            "problem_trucks": [{"truck_code": "T-007", "is_damaged": True, "deviation_violated": False}],
        }
        queue = {"trucks_in_queue": 12, "avg_wait_minutes": 41, "status_label": "WARNING (Padat Merayap)"}
        cases = (
            # The UI language wins over the question's language.
            ("berapa truk rusak?", "en", fleet, "Pythia fleet data: 3 of 40 trucks damaged."),
            ("how many trucks are damaged?", "id", fleet, "Data armada Pythia: 3 truk mengalami kerusakan"),
            ("TPA queue now?", "en", queue, "Simulated TPST Bantargebang queue: 12 trucks"),
            ("antrean TPA?", "id", queue, "Simulasi antrean TPST Bantargebang: 12 truk"),
        )
        for question, lang, result, expected in cases:
            with (
                patch.dict("os.environ", {}, clear=True),
                patch("app.assistant.assistant.execute_tool", return_value=result),
            ):
                answer = answer_with_openai_if_configured(
                    question,
                    {},
                    tool_ctx=ToolContext(dispatch_center=None, history_store=None),
                    language=lang,
                )["answer"]
            self.assertIn(expected, answer)
            if lang == "en":
                self.assertNotIn("Padat", answer)
                self.assertIn("Local mode", answer)

    def test_curated_knowledge_never_calls_the_simulated_fleet_live(self):
        from app.assistant.rag import CURATED_KNOWLEDGE

        for doc in CURATED_KNOWLEDGE:
            self.assertNotIn("live supervision", doc["text"])

    def test_local_knowledge_skips_excerpts_with_no_telling_words(self):
        from app.assistant import assistant as module

        chunks = [
            {
                "title": "Package",
                "source": "apps/wa-gateway/package.json",
                "score": 0.9,
                "text": '"name": "pythia-wa-gateway", "version": "1.0.0"',
            },
            {
                "title": "Alur",
                "source": "knowledge/02.md",
                "score": 0.8,
                "text": "Dispatcher menyetujui rencana dan sopir menerima surat jalan untuk besok.",
            },
        ]
        with (
            patch.object(module, "_knowledge_context", return_value="context"),
            patch.object(module, "retrieve_pythia_context", return_value=chunks),
        ):
            id_answer = module._local_knowledge("bagaimana alur kerja pythia?", "id")
            en_answer = module._local_knowledge("how does pythia work?", "en")

        self.assertIn("surat jalan", id_answer)
        self.assertNotIn("package.json", id_answer)
        self.assertNotIn("package.json", en_answer)


if __name__ == "__main__":
    unittest.main()
