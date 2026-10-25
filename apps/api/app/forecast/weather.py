from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from app.core.env import getenv, today
from app.core.paths import API_DIR, WEATHER_SNAPSHOT_DEFAULT

JAKARTA_LAT = -6.2088
JAKARTA_LNG = 106.8456
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


def build_weather_risk(
    rainfall_mm: float,
    precipitation_probability: float,
    wind_speed_kmh: float,
) -> dict[str, Any]:
    impact = 0
    drivers: list[str] = []

    if rainfall_mm >= 30:
        impact += 16
        drivers.append("Heavy rain can increase wet waste and slow collection.")
    elif rainfall_mm >= 10:
        impact += 8
        drivers.append("Rain can slow collection and raise wet waste weight.")

    if precipitation_probability >= 80:
        impact += 6
        drivers.append("High rain probability increases operational uncertainty.")
    elif precipitation_probability >= 50:
        impact += 3
        drivers.append("Moderate rain probability requires standby capacity.")

    if wind_speed_kmh >= 30:
        impact += 4
        drivers.append("Strong wind can disrupt transfer points and temporary bins.")

    if impact >= 20:
        level = "critical"
        advice = "Delay low-priority departures, protect flood-prone TPS routes, and prepare backup crews."
    elif impact >= 12:
        level = "high"
        advice = "Stage backup trucks near high-risk districts and monitor TPA queue timing."
    elif impact >= 6:
        level = "watch"
        advice = "Monitor rain bands and keep dispatch timing flexible."
    else:
        level = "normal"
        advice = "Normal dispatch plan can continue."

    return {
        "risk_level": level,
        "waste_impact_percent": impact,
        "drivers": drivers or ["No material weather disruption expected."],
        "operational_advice": advice,
    }


def parse_open_meteo_daily(payload: dict[str, Any]) -> list[dict[str, Any]]:
    daily = payload.get("daily", {})
    times = daily.get("time", [])
    max_temps = daily.get("temperature_2m_max", [])
    min_temps = daily.get("temperature_2m_min", [])
    rain = daily.get("precipitation_sum", [])
    rain_probability = daily.get("precipitation_probability_max", [])
    wind = daily.get("wind_speed_10m_max", [])

    forecast = []
    for index, day in enumerate(times):
        rainfall_mm = float(rain[index] if index < len(rain) else 0)
        probability = float(rain_probability[index] if index < len(rain_probability) else 0)
        wind_speed = float(wind[index] if index < len(wind) else 0)
        risk = build_weather_risk(rainfall_mm, probability, wind_speed)
        forecast.append(
            {
                "date": day,
                "temperature_max_c": float(max_temps[index] if index < len(max_temps) else 0),
                "temperature_min_c": float(min_temps[index] if index < len(min_temps) else 0),
                "rainfall_mm": rainfall_mm,
                "precipitation_probability": probability,
                "wind_speed_kmh": wind_speed,
                **risk,
            }
        )
    return forecast


def fallback_weather_forecast() -> list[dict[str, Any]]:
    start = today()
    scenarios = [
        (42.0, 91, 17.1),
        (18.5, 68, 14.2),
        (7.2, 42, 12.0),
        (11.1, 53, 13.4),
        (3.4, 24, 9.8),
        (0.0, 18, 8.5),
        (9.7, 49, 11.2),
    ]
    forecast = []
    for offset, (rainfall, probability, wind) in enumerate(scenarios, 1):
        risk = build_weather_risk(rainfall, probability, wind)
        forecast.append(
            {
                "date": (start + timedelta(days=offset)).isoformat(),
                "temperature_max_c": 31.5 - min(offset, 3) * 0.3,
                "temperature_min_c": 24.8,
                "rainfall_mm": rainfall,
                "precipitation_probability": probability,
                "wind_speed_kmh": wind,
                **risk,
            }
        )
    return forecast


_WEATHER_CACHE: dict[str, Any] | None = None
_WEATHER_CACHE_TIME: float = 0.0


def _open_meteo_url() -> str:
    params = {
        "latitude": JAKARTA_LAT,
        "longitude": JAKARTA_LNG,
        "daily": ",".join(
            [
                "temperature_2m_max",
                "temperature_2m_min",
                "precipitation_sum",
                "precipitation_probability_max",
                "wind_speed_10m_max",
            ]
        ),
        "timezone": "Asia/Jakarta",
        "forecast_days": 7,
    }
    return f"{OPEN_METEO_URL}?{urlencode(params)}"


def _open_meteo_result(payload: dict[str, Any], fetched_at: str, snapshot: bool) -> dict[str, Any]:
    return {
        "source": "open-meteo",
        # A forecast, never an observation: these are predicted daily totals.
        "kind": "forecast",
        "fetched_at": fetched_at,
        # True when PYTHIA_WEATHER_SNAPSHOT served a saved response (fetched_at is its fetch time).
        "snapshot": snapshot,
        "location": "Jakarta, Indonesia",
        "latitude": JAKARTA_LAT,
        "longitude": JAKARTA_LNG,
        "forecast": parse_open_meteo_daily(payload),
    }


def _fallback_result() -> dict[str, Any]:
    return {
        "source": "fallback-demo",
        # Invented demo values for the weather panel: never a model input.
        "kind": "demo",
        "fetched_at": None,
        "snapshot": False,
        "location": "Jakarta, Indonesia",
        "latitude": JAKARTA_LAT,
        "longitude": JAKARTA_LNG,
        "forecast": fallback_weather_forecast(),
    }


def save_weather_snapshot(path: Path | str = WEATHER_SNAPSHOT_DEFAULT, timeout_seconds: float = 10.0) -> Path:
    """Fetch the current Open-Meteo Jakarta forecast and save it for PYTHIA_WEATHER_SNAPSHOT.

    The file holds public forecast numbers only: the raw response, its URL and fetch time.
    """
    url = _open_meteo_url()
    with urlopen(url, timeout=timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    saved = {
        "source": "open-meteo",
        "url": url,
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "response": payload,
    }
    target.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")
    return target


def _snapshot_forecast(path: str) -> dict[str, Any]:
    """The saved response at `path` (relative to apps/api); the labelled demo fallback when it
    cannot be read."""
    try:
        saved = json.loads((API_DIR / path).read_text(encoding="utf-8"))
        return _open_meteo_result(saved["response"], str(saved["fetched_at"]), snapshot=True)
    except (OSError, ValueError, KeyError, TypeError):
        logging.getLogger(__name__).exception("PYTHIA_WEATHER_SNAPSHOT %s is unreadable", path)
        return _fallback_result()


def fetch_jakarta_weather_forecast(timeout_seconds: float = 5.0) -> dict[str, Any]:
    """The Open-Meteo daily forecast for Jakarta (5-minute cache).

    With PYTHIA_WEATHER_SNAPSHOT set, the saved response at that path is served
    instead (no network), so a recording sees the same weather on every take.
    """
    global _WEATHER_CACHE, _WEATHER_CACHE_TIME
    import time

    snapshot = getenv("WEATHER_SNAPSHOT")
    if snapshot:
        return _snapshot_forecast(snapshot)

    now = time.time()
    if _WEATHER_CACHE is not None and (now - _WEATHER_CACHE_TIME) < 300:
        return _WEATHER_CACHE

    try:
        with urlopen(_open_meteo_url(), timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        res = _open_meteo_result(payload, datetime.now(UTC).isoformat(timespec="seconds"), snapshot=False)
    except Exception:
        res = _fallback_result()
    # Cache the fallback too so we don't spam if offline/rate-limited
    _WEATHER_CACHE = res
    _WEATHER_CACHE_TIME = now
    return res


def real_forecast_by_date(weather: dict[str, Any]) -> dict[str, dict[str, float]]:
    """{date: rain/temp/wind} from an Open-Meteo forecast; empty for any other source.

    The demo fallback's numbers are invented for the weather panel, so they must
    never reach a model as if they were a forecast.
    """
    if weather.get("source") != "open-meteo":
        return {}
    return {
        day["date"]: {
            "rainfall_mm": float(day.get("rainfall_mm") or 0.0),
            "temp_max_c": float(day.get("temperature_max_c") or 31.0),
            "wind_max_kmh": float(day.get("wind_speed_kmh") or 10.0),
        }
        for day in weather.get("forecast", [])
        if day.get("date")
    }


if __name__ == "__main__":
    # python -m app.forecast.weather save [path]   (from apps/api)
    if len(sys.argv) < 2 or sys.argv[1] != "save":
        sys.exit("usage: python -m app.forecast.weather save [path]")
    print(f"saved {save_weather_snapshot(*sys.argv[2:3])}")
