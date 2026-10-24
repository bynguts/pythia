"""What-if scenarios for Ana: parse a question, run the twin forecast, link to Twin/XR.

The forecast itself is the one behind `/api/twin/scene` (imported, not copied),
and the scenario is snapped to the twin's presets (rain in 5 mm steps up to
150 mm, crowd none/50k/100k) before it runs, so Ana, the 3D twin and the XR
tabletop show the same numbers; the answer says when a value was snapped.
Every figure is model output or simulation and is labelled so.
"""

from __future__ import annotations

import inspect
import math
import re
from typing import Any
from urllib.parse import urlencode

from app.core.units import (
    CREW_SIZE_WORKERS,
    TRUCK_CAPACITY_TONS,
    extra_trucks_for,
    resource_basis,
    resource_requirements,
)
from app.forecast.cities import VENUES, Venue, get_venue

HORIZON_DAYS = 7
MAX_RAIN_MM = 300.0
TWIN_MAX_RAIN_MM = 150
TWIN_RAIN_STEP_MM = 5
MAX_ATTENDANCE = 2_000_000
# Twin deep-link contract: event presets by attendance.
TWIN_EVENT_PRESETS = (("none", 0), ("50k", 50_000), ("100k", 100_000))

# How a question names each venue preset (the venues live in forecast/cities.py).
VENUE_PATTERNS = {
    "gbk": r"\b(gbk|gelora bung karno|senayan)\b",
    "jis": r"\b(jis|jakarta international stadium)\b",
    "monas": r"\b(monas|monumen nasional|national monument)\b",
    "d1": r"\b(district 1|quan 1|quận 1|nguyen hue|nguyễn huệ)\b",
}

_WHAT_IF = re.compile(
    r"\b(what if|what happens if|suppose|imagine|kalau|kalo|jika|bagaimana jika|gimana kalau|"
    r"seandainya|andaikan|andai|skenario|scenario|simulasikan|simulate)\b"
)
# A named venue plus an event word with no crowd size ("the JIS concert") runs the
# smallest crowd preset, and the answer says the size was assumed.
_EVENT_WORDS = re.compile(
    r"\b(concert|konser|event|acara|match|pertandingan|festival|show|pertunjukan|rally|demo|demonstrasi)\b"
)
ASSUMED_ATTENDANCE = 50_000
_HCMC = re.compile(r"\b(hcmc|ho chi minh|hồ chí minh|saigon|sai gon|tp\.? ?hcm)\b")
_RAIN = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:mm|milimeter|millimet(?:er|re)s?)\b")
_DAYS: tuple[tuple[re.Pattern[str], int | None], ...] = (
    (re.compile(r"\b(?:day|hari|d|h)\s*\+\s*(\d+)\b"), None),
    (re.compile(r"\b(?:in|dalam)\s+(\d+)\s+(?:days?|hari)\b"), None),
    (re.compile(r"\b(\d+)\s+hari\s+lagi\b"), None),
    (re.compile(r"\b(day after tomorrow|lusa)\b"), 2),
    (re.compile(r"\b(tomorrow|besok|esok)\b"), 1),
    (re.compile(r"\b(today|tonight|hari ini|malam ini|sekarang)\b"), 0),
)
_ATTENDANCE = re.compile(
    r"(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*"
    r"(k|rb|ribu|thousand|jt|juta|million)?\b\s*(orang|people|pengunjung|penonton|attendees|visitors|fans)?"
)
_MULTIPLIERS = {
    "k": 1_000,
    "rb": 1_000,
    "ribu": 1_000,
    "thousand": 1_000,
    "jt": 1e6,
    "juta": 1e6,
    "million": 1e6,
}
_ID_WORDS = re.compile(
    r"\b(kalau|kalo|jika|hujan|besok|lusa|ribu|orang|pas|saat|bagaimana|seandainya|hari ini|konser|berapa|di)\b"
)
_EN_WORDS = re.compile(r"\b(what|if|rain|tomorrow|today|concert|people|suppose|how|during|hits|at|the|of)\b")


def _number(text: str) -> float:
    return float(text.replace(",", "."))


def question_language(question: str, default: str = "id") -> str:
    """The language the question is written in; the UI locale breaks ties."""
    q = question.lower()
    indonesian, english = len(_ID_WORDS.findall(q)), len(_EN_WORDS.findall(q))
    if indonesian == english:
        return default if default in ("id", "en") else "id"
    return "id" if indonesian > english else "en"


def parse_scenario_question(question: str) -> dict[str, Any] | None:
    """Deterministic what-if parser (rain mm, attendance, venue, day, city).

    Returns None unless the question is a scenario: a what-if phrase with rain
    or a crowd size, or both rain and a crowd size.
    """
    q = question.lower()
    city = "hcmc" if _HCMC.search(q) else "jakarta"

    rain = None
    rain_match = _RAIN.search(q)
    if rain_match:
        rain = min(MAX_RAIN_MM, _number(rain_match.group(1)))
        q = q[: rain_match.start()] + " " + q[rain_match.end() :]

    day = 0
    for pattern, fixed in _DAYS:
        match = pattern.search(q)
        if match:
            day = fixed if fixed is not None else int(match.group(1))
            q = q[: match.start()] + " " + q[match.end() :]
            break
    day = max(0, min(HORIZON_DAYS - 1, day))

    attendance = None
    for match in _ATTENDANCE.finditer(q):
        raw, unit, noun = match.group(1), match.group(2), match.group(3)
        grouped = re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", raw) is not None
        value = float(re.sub(r"[.,]", "", raw)) if grouped else _number(raw)
        if unit:
            value *= _MULTIPLIERS[unit]
        if unit or grouped or (noun and value >= 1_000):
            attendance = int(min(MAX_ATTENDANCE, value))
            break

    if not ((_WHAT_IF.search(q) and (rain is not None or attendance)) or (rain is not None and attendance)):
        return None

    venues = VENUES[city]
    named = next((v for v in venues if re.search(VENUE_PATTERNS[v.id], q)), None)
    venue = named or venues[0]
    parsed = {
        "city": city,
        "rainfall_mm": rain or 0.0,
        "event_attendance": attendance or 0,
        "venue": venue.name,
        "day": day,
    }
    if not attendance and named and _EVENT_WORDS.search(q):
        parsed.update(event_attendance=ASSUMED_ATTENDANCE, attendance_assumed=True)
    return parsed


def _venue(city: str, key: str | None) -> Venue:
    """Venue by id or display name; the city's default venue when unknown."""
    return get_venue(city, key) or VENUES[city][0]


def snap_to_twin(rain: float, attendance: int) -> tuple[float, int]:
    """The twin's own values for a scenario: rain clamped to 0..150 mm and rounded
    half-up to 5 mm (like the twin's slider), attendance to the nearest crowd preset."""
    clamped = max(0.0, min(float(TWIN_MAX_RAIN_MM), rain))
    snapped_rain = float(math.floor(clamped / TWIN_RAIN_STEP_MM + 0.5) * TWIN_RAIN_STEP_MM)
    snapped_attendance = min(TWIN_EVENT_PRESETS, key=lambda p: abs(p[1] - attendance))[1]
    return snapped_rain, snapped_attendance


def scenario_links(city: str, rain: float, attendance: int, day: int, venue: Venue) -> dict[str, str]:
    """Twin/XR deep links per the cross-surface contract (`venue` only with an event)."""
    preset = min(TWIN_EVENT_PRESETS, key=lambda p: abs(p[1] - attendance))[0]
    twin: dict[str, Any] = {
        "city": city,
        "rain": max(0, min(TWIN_MAX_RAIN_MM, round(rain))),
        "event": preset,
    }
    if attendance:
        twin["venue"] = venue.id
    twin.update(day=day, present=1)
    xr: dict[str, Any] = {"city": city, "rainfall_mm": round(rain, 1), "event_attendance": attendance}
    if attendance:
        xr.update(event_lat=venue.lat, event_lng=venue.lng)
    return {"twin": f"/twin?{urlencode(twin)}", "xr": f"/xr?{urlencode(xr)}"}


def _call_endpoint(fn, **kwargs):
    """Call a FastAPI route function directly: unset params take their Query default."""
    for name, param in inspect.signature(fn).parameters.items():
        if name not in kwargs and param.default is not inspect.Parameter.empty:
            kwargs[name] = getattr(param.default, "default", param.default)
    return fn(**kwargs)


def _queue_metric(scene: dict[str, Any]) -> dict[str, Any] | None:
    """The twin's TPA queue metric, already scaled by the twin to the scenario day."""
    metric = (scene.get("landfill_queue") or {}).get("minutes_per_truck")
    if not isinstance(metric, dict):
        return None
    keep = (
        "baseline_mean",
        "staggered_mean",
        "baseline_p95",
        "staggered_p95",
        "replications",
        "trucks_per_day",
        "normal_day",
    )
    return {
        **{k: metric.get(k) for k in keep},
        # The unstaggered mean's departure-spread sensitivity band (same simulated day),
        # so the card shows "65.2 (42.9-74.2) -> 9.7" like the Twin HUD, not a bare point.
        "baseline_band": (metric.get("sensitivity") or {}).get("baseline_band"),
        "classification": metric.get("classification", "SIMULATED"),
        "source": metric.get("source"),
        "scenario_scaled": bool(metric.get("scenario_scaled")),
    }


def run_scenario(args: dict[str, Any]) -> dict[str, Any]:
    """Read-only what-if: the twin's district forecast for one day, summarised for Ana."""
    from app.api.routers import twin as twin_router

    city = args.get("city") or "jakarta"
    if city not in VENUES:
        raise ValueError(f"unknown city {city!r}")
    requested = {
        "rainfall_mm": max(0.0, min(MAX_RAIN_MM, float(args.get("rainfall_mm") or 0))),
        "event_attendance": max(0, min(MAX_ATTENDANCE, int(args.get("event_attendance") or 0))),
    }
    # Run exactly what the Twin/XR links will show, not a value they cannot display.
    rain, attendance = snap_to_twin(requested["rainfall_mm"], requested["event_attendance"])
    snapped = (rain, attendance) != (requested["rainfall_mm"], requested["event_attendance"])
    day = max(0, min(HORIZON_DAYS - 1, int(args.get("day") or 0)))
    venue = _venue(city, args.get("venue"))

    scene = _call_endpoint(
        twin_router.twin_scene,
        city=city,
        days=HORIZON_DAYS,
        rainfall_mm=rain,
        event_attendance=attendance,
        event_lat=venue.lat if attendance else None,
        event_lng=venue.lng if attendance else None,
        venue=venue.id if attendance else None,
        day=day,
    )
    dates = scene["horizon"]["dates"]
    day = min(day, len(dates) - 1)
    rows = []
    for district in scene["districts"]:
        row = district["series"][day]
        rows.append(
            {
                "name": district["name"],
                "admin_area": district.get("admin_area"),
                "tons": round(row["predicted_tons"], 1),
                "normal_tons": round(row["normal_tons"], 1),
                "extra_tons": round(row["predicted_tons"] - row["normal_tons"], 1),
                "risk": row["risk"],
                "extra_trucks": extra_trucks_for(row["predicted_tons"], row["normal_tons"]),
            }
        )
    total = sum(r["tons"] for r in rows)
    normal_total = sum(r["normal_tons"] for r in rows)
    resources = resource_requirements(total, baseline_tons=normal_total)
    top = sorted((r for r in rows if r["extra_tons"] > 0), key=lambda r: -r["extra_tons"])[:5]
    provenance = scene["provenance"]
    queue = _queue_metric(scene)

    sources = [
        {"id": "district_forecast", **provenance["districts"]},
        {"id": "resource_units", "class": "PLANNING_RULE", "source": resource_basis()},
    ]
    plan = ["parse_scenario", "district_forecast", "normal_day_baseline", "resource_units"]
    # What the tool actually ran, in order, with each step's source and provenance.
    # The caller prepends the parse step (local parser or LLM tool call).
    trace = [
        {
            "step": "run_scenario",
            "class": "READ_ONLY_TOOL",
            "source": "run_scenario: the /api/twin/scene forecast, snapped to the twin presets",
            "detail": {
                "rainfall_mm": rain,
                "event_attendance": attendance,
                "venue": venue.id if attendance else None,
                "day": day,
                "snapped": snapped,
            },
        },
        {
            "step": "forecast_model",
            "class": provenance["districts"]["class"],
            "source": provenance["districts"]["source"],
            "detail": {"districts": len(rows), "date": dates[day]},
        },
        {
            "step": "resource_rule",
            "class": "PLANNING_RULE",
            "source": resource_basis(),
            "detail": {"trucks_required": resources["trucks_required"]},
        },
    ]
    if queue:
        sources.append(
            {"id": "landfill_queue", "class": queue["classification"], "source": queue["source"] or ""}
        )
        plan.append("queue_metric")
        trace.append(
            {
                "step": "queue_simulation",
                "class": queue["classification"],
                "source": queue["source"] or "",
                "detail": {
                    "trucks_per_day": queue["trucks_per_day"],
                    "scenario_scaled": queue["scenario_scaled"],
                },
            }
        )
    return {
        "tool": "run_scenario",
        "classification": provenance["districts"]["class"],
        "city": city,
        "scenario": {
            "rainfall_mm": rain,
            "event_attendance": attendance,
            "venue": venue.name if attendance else None,
            "venue_id": venue.id if attendance else None,
            "day": day,
            "date": dates[day],
            "requested": requested,
            "snapped_to_twin_presets": snapped,
            "attendance_assumed": bool(args.get("attendance_assumed")) and attendance > 0,
        },
        "summary": {
            "total_tons": round(total, 1),
            "normal_tons": round(normal_total, 1),
            "extra_tons": round(total - normal_total, 1),
            "districts_at_risk": sum(r["risk"] in ("high", "critical") for r in rows),
            "trucks_required": resources["trucks_required"],
            "extra_trucks": resources["recommended_extra_trucks"],
            "extra_crews": resources["recommended_extra_crews"],
            "extra_workers": resources["recommended_extra_workers"],
            "truck_capacity_tons": TRUCK_CAPACITY_TONS,
            "crew_size_workers": CREW_SIZE_WORKERS,
        },
        "top_districts": top,
        "queue_minutes_per_truck": queue,
        "plan": plan,
        "sources": sources,
        "trace": trace,
        "links": scenario_links(city, rain, attendance, day, venue),
        "note": (
            "Scenario forecast, not an observation. Read-only: Ana recommends, the operator "
            "decides; nothing is dispatched, approved or sent."
        ),
    }


def with_parse_step(result: dict[str, Any], parser: str, model: str | None = None) -> dict[str, Any]:
    """Prepend how the question became tool arguments: `local_parser` or `llm_tool_call`."""
    requested = result["scenario"].get("requested") or {}
    source = (
        f"LLM tool call ({model})"
        if parser == "llm_tool_call"
        else "Deterministic local parser (rules, no LLM): rain mm, crowd size, venue, day"
    )
    step = {
        "step": "parse_scenario",
        "class": "LLM" if parser == "llm_tool_call" else "LOCAL_PARSER",
        "source": source,
        "detail": {
            "rainfall_mm": requested.get("rainfall_mm"),
            "event_attendance": requested.get("event_attendance"),
            "venue": result["scenario"].get("venue_id"),
            "day": result["scenario"].get("day"),
        },
    }
    return {**result, "trace": [step, *result.get("trace", [])]}


def _fmt(value: float) -> str:
    return f"{value:,.0f}"


def scenario_answer(result: dict[str, Any], language: str) -> str:
    """Deterministic answer text for a run_scenario payload, in `language`."""
    s, sc = result["summary"], result["scenario"]
    english = language == "en"
    city = "Ho Chi Minh City" if result["city"] == "hcmc" else "Jakarta"
    label = result["classification"].replace("_", " ")
    when = sc["date"]

    def describe(rain: float, attendance: int, venue: str | None) -> str:
        parts = []
        if rain:
            parts.append(f"{rain:g} mm {'rain' if english else 'hujan'}")
        if attendance:
            crowd = _fmt(attendance)
            at = (f" at {venue}" if english else f" di {venue}") if venue else ""
            parts.append(f"{crowd}-person event{at}" if english else f"event {crowd} orang{at}")
        return " + ".join(parts) or ("no rain, no event" if english else "tanpa hujan dan event")

    what = describe(sc["rainfall_mm"], sc["event_attendance"], sc["venue"])
    requested = sc.get("requested") or {}
    asked = describe(requested.get("rainfall_mm", 0), requested.get("event_attendance", 0), None)
    delta = f"{'+' if s['extra_tons'] >= 0 else ''}{_fmt(s['extra_tons'])}"
    top = result["top_districts"]
    queue = result.get("queue_minutes_per_truck")
    if english:
        lines = [
            f"**Scenario ({label}, not an observation):** {what}, {city}, {when}.",
            f"- Total {_fmt(s['total_tons'])} t vs {_fmt(s['normal_tons'])} t on a normal day ({delta} t).",
        ]
        if sc.get("attendance_assumed"):
            lines.insert(
                1,
                f"- Crowd size not given: assumed {_fmt(sc['event_attendance'])} (the twin's smallest preset).",
            )
        if sc.get("snapped_to_twin_presets"):
            lines.insert(
                1,
                f"- Snapped to the twin's presets (rain in 5 mm steps up to 150 mm, crowd none/50k/100k) "
                f"so the Twin and XR show these same numbers: you asked {asked}.",
            )
        if top:
            lines.append(
                "- Top districts at risk: "
                + "; ".join(f"{d['name']} +{d['extra_tons']:g} t ({d['risk']})" for d in top[:3])
                + "."
            )
        lines.append(
            f"- Resources: {s['trucks_required']} trucks needed; +{s['extra_trucks']} trucks, "
            f"+{s['extra_crews']} crews (+{s['extra_workers']} workers) above normal "
            f"({s['truck_capacity_tons']:g} t/truck, {s['crew_size_workers']} workers/crew)."
        )
        if queue and None not in (queue["baseline_mean"], queue["staggered_mean"]):
            normal = queue.get("normal_day") or {}
            scope = (
                f"scaled to this scenario: {_fmt(queue['trucks_per_day'])} trucks/day vs "
                f"{_fmt(normal.get('trucks_per_day', 0))} on a normal day "
                f"({normal.get('baseline_mean', 0):g} min/truck)"
                if queue["scenario_scaled"]
                else "same truck arrivals as a normal day"
            )
            lines.append(
                f"- TPA queue (SIMULATED, {scope}): {queue['baseline_mean']:g} min/truck unstaggered, "
                f"{queue['staggered_mean']:g} min/truck with staggered dispatch."
            )
        lines.append("Ana only recommends — open the scenario in the Twin or XR to review it with the team.")
    else:
        lines = [
            f"**Skenario ({label}, bukan pengamatan):** {what}, {city}, {when}.",
            f"- Total {_fmt(s['total_tons'])} t vs {_fmt(s['normal_tons'])} t pada hari normal ({delta} t).",
        ]
        if sc.get("attendance_assumed"):
            lines.insert(
                1,
                f"- Jumlah pengunjung tidak disebut: diasumsikan {_fmt(sc['event_attendance'])} (preset twin terkecil).",
            )
        if sc.get("snapped_to_twin_presets"):
            lines.insert(
                1,
                f"- Disesuaikan ke preset twin (hujan per 5 mm hingga 150 mm, keramaian none/50k/100k) "
                f"agar Twin dan XR menampilkan angka yang sama: Anda meminta {asked}.",
            )
        if top:
            lines.append(
                "- Kecamatan paling berisiko: "
                + "; ".join(f"{d['name']} +{d['extra_tons']:g} t ({d['risk']})" for d in top[:3])
                + "."
            )
        lines.append(
            f"- Sumber daya: {s['trucks_required']} truk dibutuhkan; +{s['extra_trucks']} truk, "
            f"+{s['extra_crews']} kru (+{s['extra_workers']} petugas) di atas normal "
            f"({s['truck_capacity_tons']:g} t/truk, {s['crew_size_workers']} petugas/kru)."
        )
        if queue and None not in (queue["baseline_mean"], queue["staggered_mean"]):
            normal = queue.get("normal_day") or {}
            scope = (
                f"disesuaikan dengan skenario: {_fmt(queue['trucks_per_day'])} truk/hari vs "
                f"{_fmt(normal.get('trucks_per_day', 0))} pada hari normal "
                f"({normal.get('baseline_mean', 0):g} menit/truk)"
                if queue["scenario_scaled"]
                else "kedatangan truk sama dengan hari normal"
            )
            lines.append(
                f"- Antrean TPA (SIMULASI, {scope}): {queue['baseline_mean']:g} menit/truk tanpa penjadwalan, "
                f"{queue['staggered_mean']:g} menit/truk dengan staggered dispatch."
            )
        lines.append("Ana hanya merekomendasikan — buka skenario di Twin atau XR untuk ditinjau bersama tim.")
    return "\n".join(lines)
