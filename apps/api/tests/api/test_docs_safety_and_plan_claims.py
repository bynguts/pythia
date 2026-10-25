"""README and knowledge docs describe the daily plan, field sign-in and driver safety as built.

Ana answers from the knowledge docs and judges read the README, so a claim the code
no longer reproduces (a weekly plan, a field app without login) is a wrong answer.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.units import DUTY_BLOCK_MIN, DUTY_WARN_MIN, GATE_ALERT_MIN

API_DIR = Path(__file__).resolve().parents[2]
REPO = API_DIR.parents[1]
DOCS = [REPO / "README.md", *sorted((API_DIR / "knowledge").glob("*.md"))]

OUTDATED = [
    (r"weekly (staggered[- ]\w+ |queue )?plan|constraint-aware weekly", "the plan is a daily plan"),
    (r"`/field`[^\n]{0,20}no login|no login needed", "/field and /driver ask for the driver sign-in"),
    (r"straight to drivers?'? (phones|WhatsApp)", "the Baileys gateway is a prototype"),
    (r"\biPhone\b|\biOS\b", "the users carry budget Android phones"),
]


@pytest.mark.parametrize(("pattern", "why"), OUTDATED, ids=[w for _, w in OUTDATED])
def test_docs_drop_claims_the_code_no_longer_makes(pattern, why):
    hits = [
        f"{doc.name}: {m.group(0)}"
        for doc in DOCS
        for m in re.finditer(pattern, doc.read_text(encoding="utf-8"), re.IGNORECASE)
    ]
    assert not hits, f"{why}: {hits}"


def test_safety_thresholds_in_the_docs_match_units():
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    architecture = (API_DIR / "knowledge" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    for text in (readme, architecture):
        for minutes in (DUTY_WARN_MIN, DUTY_BLOCK_MIN, GATE_ALERT_MIN):
            assert f"{minutes} min" in text
        assert "OBSERVED_APP_EVENTS" in text and "SIMULATED" in text
    assert "Rencana harian" in readme and "Rencana harian" in architecture
    assert "EXAMPLE_CONFIG" in readme
