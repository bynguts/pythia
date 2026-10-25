"""H11: the compliance score labels its deviation input as SIMULATED.

The deviation term is read from the simulated fleet, while SPJ, damage and
pre-trip terms come from records on this server. A bare `derived` label hid
that mix, so each input now carries its own class.
"""

from __future__ import annotations

import app.field.compliance as comp


def test_score_labels_the_deviation_input_as_simulated(monkeypatch):
    monkeypatch.setattr(
        comp,
        "get_dynamic_trucks",
        lambda: [{"truck_code": "T-900", "driver_name": "Pengemudi Uji", "deviation": {"violated": True}}],
    )
    score = comp.compute_driver_score("Pengemudi Uji", ["T-900"], today="2026-10-26")

    assert score["classification"] == "derived"
    assert score["inputs"]["deviation"] == "SIMULATED"
    assert score["inputs"]["spj"] == "REAL_RECORD"
    assert score["breakdown"]["deviation_violations"] == 1
    assert "simulated" in score["inputs_note"].lower()
