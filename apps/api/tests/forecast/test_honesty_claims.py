"""Claims Ana, the PDF and the forecast API make must be ones the code reproduces.

Ana answers from `apps/api/knowledge/*.md`, so a stale figure there becomes a wrong
spoken answer. Every paragraph or list item that states a percentage or a distance
must also name where it comes from (a code reference, the evaluation artifact, the
data source) or say it is an assumption or a simulation.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

KNOWLEDGE_DIR = Path(__file__).resolve().parents[2] / "knowledge"
KNOWLEDGE_DOCS = sorted(KNOWLEDGE_DIR.glob("*.md"))

FIGURE = re.compile(r"\d+(?:[.,]\d+)?\s*(?:%|km\b)")
SOURCE_TAG = re.compile(
    r"`[^`]+`|forecast_evaluation|data\.go\.id|asumsi|assumption|simulasi|simulated|"
    r"kalibrasi-sintetik|calibrated-synthetic",
    re.IGNORECASE,
)
BLOCK_START = re.compile(r"^(#|- |\d+\. |> )")


def _blocks(text: str) -> list[tuple[int, str]]:
    """Paragraphs and top-level list items, each with nested/continuation lines."""
    blocks: list[tuple[int, list[str]]] = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            blocks.append((number, []))
        elif BLOCK_START.match(line) or not blocks:
            blocks.append((number, [line]))
        else:
            blocks[-1][1].append(line)
    return [(n, " ".join(lines)) for n, lines in blocks if lines]


def test_knowledge_docs_exist():
    names = {p.name for p in KNOWLEDGE_DOCS}
    assert {"01_OPERATIONS_AND_DECISION_LOGIC.md", "04_DEMO_NARRATIVE_AND_LIMITS.md"} <= names


@pytest.mark.parametrize("doc", KNOWLEDGE_DOCS, ids=lambda p: p.name)
def test_every_percentage_or_distance_in_the_knowledge_docs_names_its_source(doc):
    untagged = [
        f"{doc.name}:{line}: {block[:120]}"
        for line, block in _blocks(doc.read_text(encoding="utf-8"))
        if FIGURE.search(block) and not SOURCE_TAG.search(block)
    ]
    assert not untagged, "figures without a source tag:\n" + "\n".join(untagged)


# Claims a hostile review found in the corpus that the code does not reproduce.
STALE_CLAIMS = [
    (r"41\s*%", "past literal-default spike figure"),
    (r"lonjakan volume \d+% di Jakarta Barat", "fixed spike narrative"),
    (r"50\s*jt", "50 juta is 50 million; the event presets are 50k/100k"),
    (r">\s*2 km", "T-047 deviation distance is computed live"),
    (r"\.2\.373", "malformed T-047 distance"),
    (r"per kelurahan", "the models are per kecamatan"),
    (r"`app/units\.py`", "the units module is app/core/units.py"),
    (r"OpenWA live", "the gateway is Baileys"),
    (r"20 menit|20 minutes", "the stagger slot is 15 minutes"),
    (r"\bpiloted on\b|\bdipilotkan\b", "no pilot exists"),
    (r"synced instantly|real time|waktu nyata", "the dashboard polls"),
    (r"`dispatch:override`", "the SPJ override permission is spj:override"),
    (r"ekstr[ei]m\w*\s*\(?\s*(?:>=|≥)\s*30", "BMKG extreme is >150 mm; 30 mm is the planning step"),
]


@pytest.mark.parametrize(("pattern", "why"), STALE_CLAIMS, ids=[p for p, _ in STALE_CLAIMS])
def test_knowledge_docs_drop_claims_the_code_does_not_reproduce(pattern, why):
    hits = [
        f"{doc.name}: {m.group(0)}"
        for doc in KNOWLEDGE_DOCS
        for m in re.finditer(pattern, doc.read_text(encoding="utf-8"), re.IGNORECASE)
    ]
    assert not hits, f"{why}: {hits}"


def test_knowledge_docs_state_the_validated_horizon():
    text = (KNOWLEDGE_DIR / "04_DEMO_NARRATIVE_AND_LIMITS.md").read_text(encoding="utf-8")
    assert "April 2026" in text
    assert "1–3 bulan" in text
    assert "di luar" in text


# ── Ana's risk scale and rain words are the ones the code uses (teardown v3 N5) ──

DECISION_DOC = KNOWLEDGE_DIR / "01_OPERATIONS_AND_DECISION_LOGIC.md"
LEGACY_HEADING = "### Endpoint lama `/api/predictions?event_scale=`"


def _risk_section() -> str:
    text = DECISION_DOC.read_text(encoding="utf-8")
    start = text.index("## B. ")
    return text[start : text.index(LEGACY_HEADING, start)]


@pytest.mark.parametrize(
    ("constant", "level"),
    [("RISK_CRITICAL_RATIO", "critical"), ("RISK_HIGH_RATIO", "high"), ("RISK_ELEVATED_RATIO", "elevated")],
)
def test_decision_doc_states_the_spike_risk_thresholds_from_the_code(constant, level):
    from app.forecast import engine

    ratio = getattr(engine, constant)
    pct = round((ratio - 1) * 100)
    lines = [line for line in _risk_section().splitlines() if f"`{level}`" in line]
    assert any(re.search(rf">=\s*{pct}%", line) and f"`engine.{constant}`" in line for line in lines), (
        f"doc 01 section B must say >= {pct}% -> `{level}` (`engine.{constant}`)"
    )
    # The level it names is the one spike_risk returns just above the threshold.
    assert engine.spike_risk(100 * ratio + 0.01, 100)[1] == level


def test_web_risk_ratios_mirror_the_backend_spike_risk():
    """The planning review classifies in the browser (useSnapshot.js spikeRisk); same thresholds."""
    from app.forecast import engine

    source = (
        Path(__file__).resolve().parents[4] / "apps" / "web" / "src" / "shared" / "hooks" / "useSnapshot.js"
    ).read_text(encoding="utf-8")
    match = re.search(r"RISK_RATIOS = \{([^}]*)\}", source)
    assert match, "useSnapshot.js must export RISK_RATIOS"
    ratios = {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", match.group(1))}
    assert ratios == {
        "critical": engine.RISK_CRITICAL_RATIO,
        "high": engine.RISK_HIGH_RATIO,
        "elevated": engine.RISK_ELEVATED_RATIO,
    }
    levels = re.search(r"AT_RISK_LEVELS = \[([^\]]*)\]", source)
    assert levels and set(re.findall(r'"(\w+)"', levels.group(1))) == set(engine.AT_RISK_LEVELS)


def test_decision_doc_names_at_risk_levels_and_the_normal_day():
    from app.forecast.engine import AT_RISK_LEVELS

    section = _risk_section()
    assert "`engine.AT_RISK_LEVELS`" in section
    assert all(f"`{level}`" in section for level in AT_RISK_LEVELS)
    assert "`engine.NORMAL_DAY_BASIS`" in section
    assert "tanpa hujan dan tanpa event" in section


def test_legacy_risk_scale_only_appears_under_the_legacy_endpoint_heading():
    text = DECISION_DOC.read_text(encoding="utf-8")
    legacy = re.compile(r">=\s*30%\s*critical")
    assert legacy.search(text[text.index(LEGACY_HEADING) :])
    assert not legacy.search(text[: text.index(LEGACY_HEADING)])
    for doc in KNOWLEDGE_DOCS:
        if doc != DECISION_DOC:
            assert not legacy.search(doc.read_text(encoding="utf-8")), doc.name


@pytest.mark.parametrize("category", ["light", "moderate", "heavy", "very_heavy", "extreme"])
def test_decision_doc_states_the_bmkg_rain_categories_ana_parses(category):
    from app.assistant.scenario import RAIN_CATEGORIES

    spec = RAIN_CATEGORIES[category]
    expected = f"{spec['id']}{spec['range']}mm/hari->{spec['mm']:g}mm".replace(" ", "")
    flat = [re.sub(r"\s+", "", line) for line in _risk_section().splitlines()]
    assert any(expected in line for line in flat), f"doc 01 must state {expected!r}"


def test_decision_doc_states_the_rain_carry_over_the_scene_serves():
    from app.api.routers.twin import CARRY_OVER
    from app.forecast.engine import RAIN_3D_WINDOW_DAYS

    section = _risk_section()
    assert "`engine.RAIN_3D_WINDOW_DAYS`" in section
    assert f"jumlah hujan {RAIN_3D_WINDOW_DAYS} hari bergulir" in section
    # A what-if's rain counts on its own day only; forecast rain keeps the rolling sum.
    assert CARRY_OVER == {**CARRY_OVER, "scenario": False, "forecast": True}
    assert "(`weather.carry_over.scenario` = false)" in section
    assert "hanya dihitung pada harinya sendiri" in section
    assert "skenario masih dihitung" not in section


def test_decision_doc_states_where_the_served_rain_effect_is_held():
    from app.forecast.engine import TRAINING_RAIN_MAX_MM, rain_response_block

    section = _risk_section()
    held = f"{TRAINING_RAIN_MAX_MM:g}"
    assert f"`engine.TRAINING_RAIN_MAX_MM` = {held.replace('.', ',')} mm" in section
    block = rain_response_block(TRAINING_RAIN_MAX_MM + 1)
    assert block["beyond_training_range"] is True
    assert block["held_at_mm"] == TRAINING_RAIN_MAX_MM
    assert rain_response_block(TRAINING_RAIN_MAX_MM)["held_at_mm"] is None


def test_district_forecast_source_says_calibrated_synthetic(api_client):
    body = api_client.get("/api/predictions/kecamatan").json()
    assert "real 5yr" not in body["source"]
    assert "calibrated-synthetic" in body["source"]
    assert "MODEL OUTPUT" in body["source"]


def test_executive_summary_queue_is_the_modelled_peak_hour_not_now(api_client, auth_headers):
    body = api_client.get("/api/reports/executive-summary", headers=auth_headers("dispatcher")).json()
    assert "saat ini" not in body["summary"]
    assert "jam puncak model (simulasi)" in body["summary"]
    assert "armada simulasi" in body["summary"]


# ── Monthly intake: which months are inside the backtested horizon ─────────


def test_monthly_intake_defaults_to_the_backtested_months(api_client):
    body = api_client.get("/api/ml/monthly-intake").json()
    assert body["fitted_through"] == "2026-04"
    assert body["backtested_horizon_months"] == [1, 2, 3]
    assert [m["month"] for m in body["months"]] == ["2026-05", "2026-06", "2026-07"]
    assert all(m["within_backtested_horizon"] for m in body["months"])


def test_monthly_intake_from_a_later_month_flags_unvalidated_horizons(api_client):
    res = api_client.get("/api/ml/monthly-intake", params={"months": 3, "start_month": "2026-07"})
    assert res.status_code == 200
    months = res.json()["months"]
    assert [(m["month"], m["horizon_months"]) for m in months] == [
        ("2026-07", 3),
        ("2026-08", 4),
        ("2026-09", 5),
    ]
    assert [m["within_backtested_horizon"] for m in months] == [True, False, False]
    assert res.json()["classification"] == "MODEL OUTPUT"


@pytest.mark.parametrize("start", ["2026-04", "2025-12"])
def test_monthly_intake_refuses_an_observed_start_month(api_client, start):
    res = api_client.get("/api/ml/monthly-intake", params={"start_month": start})
    assert res.status_code == 422
    assert "2026-04" in res.json()["detail"]


@pytest.mark.parametrize("start", ["2026-13", "26-11", "2026-1", "november"])
def test_monthly_intake_rejects_a_malformed_start_month(api_client, start):
    res = api_client.get("/api/ml/monthly-intake", params={"start_month": start})
    assert res.status_code == 422
