# ml/ — datasets and training

Everything the API's forecasting and fleet models are built from. The API reads
these files at runtime through `apps/api/app/core/paths.py` (`PYTHIA_DATA_DIR`
overrides the location; the docker image uses `/data`).

## Data folders

| Folder | Contents |
|---|---|
| `data/real/` | Government / official sources (SIPSN, SILIKA, data.go.id, event schedules, holidays, kelurahan polygons). |
| `data/raw/` | Downloaded or generated inputs: Open-Meteo history, holiday and boundary files, the waste seed, and the **synthetic** event calendar. |
| `data/processed/` | Training dataset and the evaluation reports written by the training scripts. |
| `data/sources/` | Research notes and acquisition/scrape manifests. |

## Provenance

`data/real/manifest.json` lists every file in `data/real/` with its source URL,
date, granularity, classification (`real` / `proxy` / …), limitations, columns and
row count. The API exposes the same classifications at `/api/data/provenance`, so a
modelled, proxy or synthetic series is never presented as observed data. When you
add or replace a file in `data/real/`, add its manifest entry too
(`apps/api/tests/forecast/test_real_data.py` checks that every entry exists).

Personal data does not belong here: the SILIKA registries are committed without
names, addresses or phone numbers.

## Retraining

From the repository root, with the API's Python environment
(`pip install -r apps/api/requirements.txt`):

```bash
python ml/scripts/train_models.py        # Case 2: 42 × Prophet + XGBoost residual models
python ml/scripts/train_fleet_model.py   # Case 1: fleet anomaly (Isolation Forest) model
```

Models are written to `apps/api/data/models/`; the previous set is copied to
`apps/api/data/models/_synthetic_backup/` first (git-ignored). Each script also rewrites
its report in `data/processed/` (`hybrid_forecaster_evaluation.md`,
`fleet_anomaly_evaluation.md`). Keep the XGBoost feature order in sync with
`apps/api/app/forecast/engine.py`.

`train_models.py` also writes `monthly_calendar_model.json` and `forecast_evaluation.json`
(the monthly landfill-intake forecaster and its rolling-origin backtest on the real
Bantargebang series, which the API and the audit model card read);
`python ml/scripts/train_models.py --monthly-only` rebuilds just those two. Corrupted
Bantargebang source rows are fixed only through `data/real/bantargebang_corrections.json`,
and training stops when a source row falls outside the tonnes-per-trip bounds listed there.

Data acquisition helpers: `ml/scripts/acquire_data.py` (downloads and seed
files), `scrape_research_sources.py` (Satu Data pages → `data/raw/*.txt`,
git-ignored; needs `scrapling`) and `generate_research_assets.py`.
