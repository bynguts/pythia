# JWIS Data Research Summary

Generated: 2026-05-31

## Competition Checklist Coverage

| Checklist Item | Status | Evidence |
|---|---:|---|
| Download data sampah Jakarta dari data.jakarta.go.id / Satu Data | Partial | `data/raw/jakarta_waste_dataset_metadata.json`, `data/raw/jakarta_waste_forecast_seed.csv`, `data/raw/satudata_open_data.txt`, `data/raw/satudata_waste_detail.txt` |
| Download data cuaca historis dari Open-Meteo | Done | `data/raw/open_meteo_jakarta_history_2y.json` |
| Download GeoJSON batas kelurahan Jakarta dari GADM/Navigo target | Partial | `data/raw/gadm_jakarta_admin2.geojson`, `data/raw/jakarta_kelurahan_heatmap.geojson` fallback |
| Setup OSRM lokal/API routing | Done | `GET /api/routes/osrm`, OSRM public route evidence in dashboard |
| Kumpulkan kalender libur nasional | Done | `data/raw/indonesia_holidays_2026.json` |
| Buat dummy izin keramaian | Done | `data/raw/dummy_event_calendar_2026.csv` |
| Wawancara sopir/petugas | Pending external | Needs real outreach; do not fabricate quotes |
| EDA semua dataset | Done | `data/processed/eda_report.md` |

## Source Notes

- Satu Data Jakarta Open Data portal was scraped with Scrapling. The static page confirms the portal exists and is intended for reusable open data, but the specific waste detail URL currently does not expose a stable CSV/API resource in the captured response.
- Open-Meteo historical data is downloaded from the archive API for Jakarta coordinates.
- GADM admin-2 Jakarta boundary is real downloaded geospatial data. Kelurahan-level heatmap currently uses a transparent fallback polygon seed because the requested Navigo raw path was not reachable during the timed acquisition pass.
- Holiday data comes from the Indonesian holiday API and contains 24 records for 2026.
- Event calendar and waste seed CSV are explicit synthetic/fallback data, labeled in their `source` fields.

## Interview Guide

Use these questions for 1-2 real field quotes:

1. What causes the most delay in daily waste collection routes?
2. How do drivers currently receive route changes or urgent instructions?
3. What happens when TPA Bantargebang has a long queue?
4. What weather or event conditions usually increase workload?
5. What information would make field work easier during a busy shift?

Do not add quotes to the proposal until an actual driver or field officer has answered.
