# JWIS Data Research EDA

Generated: 2026-05-31

## Inventory

- Open-Meteo historical weather: 731 daily records.
- Rainy days >= 10 mm: 205; maximum daily rainfall: 59.9 mm.
- Indonesia 2026 holiday records: 24.
- GADM Jakarta admin-2 features: 6.
- Kelurahan heatmap features: 10.
- Waste forecast seed rows: 5.
- Satu Data/Jakarta Satu pages scraped with Scrapling: 4.

## Data Quality Notes

- Open-Meteo data is machine-readable and directly usable for weather-driven waste prediction.
- Holiday and event data are used as external regressors for demand spikes.
- GADM admin-2 boundaries are real downloaded geospatial boundaries.
- Kelurahan heatmap currently uses fallback generated polygons because direct Navigo raw paths were not reachable quickly.
- Jakarta waste CSV uses realistic seed data and explicit synthetic source labeling until a stable Satu Data CSV/API resource is recovered.

## Highest-Risk Areas In Current Seed

- Maximum kelurahan spike: 41%.
- Average kelurahan spike: 22.5%.

## Proposal Evidence

Satu Data Jakarta states its Open Data menu provides sectoral statistics from 51 regional agencies with tabular metadata and JSON API access. Scrapling evidence files are stored in `data/raw/satudata_*.txt`.
