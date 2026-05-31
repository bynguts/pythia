from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
SOURCES = ROOT / "data" / "sources"


EVENTS = [
    ["event_date", "event_name", "district", "expected_attendance", "waste_impact_percent", "source"],
    ["2026-06-01", "CFD and public holiday spillover", "Jakarta Pusat", 55000, 18, "dummy_case_calendar"],
    ["2026-06-02", "Concert at GBK", "Jakarta Pusat", 85000, 22, "dummy_case_calendar"],
    ["2026-06-03", "Lebaran return traffic", "Jakarta Barat", 120000, 28, "dummy_case_calendar"],
    ["2026-06-04", "Jakarta Fair crowd", "Jakarta Utara", 70000, 20, "dummy_case_calendar"],
    ["2026-06-05", "Local market festival", "Jakarta Timur", 18000, 9, "dummy_case_calendar"],
]


def write_events() -> dict:
    path = RAW / "dummy_event_calendar_2026.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(EVENTS)
    return {"file": str(path.relative_to(ROOT)), "rows": len(EVENTS) - 1}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def eda_report() -> str:
    open_meteo = load_json(RAW / "open_meteo_jakarta_history_2y.json")
    weather_days = len(open_meteo.get("daily", {}).get("time", []))
    rain = open_meteo.get("daily", {}).get("precipitation_sum", [])
    rainy_days = sum(1 for value in rain if float(value or 0) >= 10)
    max_rain = max([float(value or 0) for value in rain], default=0)

    holidays = load_json(RAW / "indonesia_holidays_2026.json")
    if isinstance(holidays, dict) and isinstance(holidays.get("data"), list):
        holiday_count = len(holidays["data"])
    else:
        holiday_count = len(holidays) if isinstance(holidays, list) else 0

    gadm = load_json(RAW / "gadm_jakarta_admin2.geojson")
    gadm_features = len(gadm.get("features", []))

    kelurahan = load_json(RAW / "jakarta_kelurahan_heatmap.geojson")
    kelurahan_features = kelurahan.get("features", [])
    spikes = [float(feature["properties"].get("spike_percent", 0)) for feature in kelurahan_features]

    waste_csv = RAW / "jakarta_waste_forecast_seed.csv"
    waste_rows = max(0, len(waste_csv.read_text(encoding="utf-8").splitlines()) - 1)

    scrape_manifest = load_json(SOURCES / "scrapling_research_manifest.json")
    scraped_ok = [item for item in scrape_manifest["results"] if item["status"] == "scraped"]

    report = f"""# JWIS Data Research EDA

Generated: {date.today().isoformat()}

## Inventory

- Open-Meteo historical weather: {weather_days} daily records.
- Rainy days >= 10 mm: {rainy_days}; maximum daily rainfall: {max_rain:.1f} mm.
- Indonesia 2026 holiday records: {holiday_count}.
- GADM Jakarta admin-2 features: {gadm_features}.
- Kelurahan heatmap features: {len(kelurahan_features)}.
- Waste forecast seed rows: {waste_rows}.
- Satu Data/Jakarta Satu pages scraped with Scrapling: {len(scraped_ok)}.

## Data Quality Notes

- Open-Meteo data is machine-readable and directly usable for weather-driven waste prediction.
- Holiday and event data are used as external regressors for demand spikes.
- GADM admin-2 boundaries are real downloaded geospatial boundaries.
- Kelurahan heatmap currently uses fallback generated polygons because direct Navigo raw paths were not reachable quickly.
- Jakarta waste CSV uses realistic seed data and explicit synthetic source labeling until a stable Satu Data CSV/API resource is recovered.

## Highest-Risk Areas In Current Seed

- Maximum kelurahan spike: {max(spikes, default=0):.0f}%.
- Average kelurahan spike: {(sum(spikes) / len(spikes) if spikes else 0):.1f}%.

## Proposal Evidence

Satu Data Jakarta states its Open Data menu provides sectoral statistics from 51 regional agencies with tabular metadata and JSON API access. Scrapling evidence files are stored in `data/raw/satudata_*.txt`.
"""
    path = PROCESSED / "eda_report.md"
    PROCESSED.mkdir(parents=True, exist_ok=True)
    path.write_text(report, encoding="utf-8")
    return str(path.relative_to(ROOT))


def main() -> int:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    event_result = write_events()
    report_path = eda_report()
    manifest = {
        "generated_at": date.today().isoformat(),
        "event_calendar": event_result,
        "eda_report": report_path,
    }
    (SOURCES / "research_assets_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
