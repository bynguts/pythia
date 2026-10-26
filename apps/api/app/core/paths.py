"""Filesystem locations the API reads, defined once.

Repository layout::

    apps/api/          this service (API_DIR): app/, tests/, knowledge/ (assistant
                       RAG corpus), data/models/, data/assets/
    ml/data/           datasets: real/, raw/, processed/, sources/

The docker image has no repository around it (``/app`` holds the service,
``/data`` the datasets), so the dataset location can be set with
``PYTHIA_DATA_DIR``. The repo README, which the assistant indexes, is
simply skipped when absent.
"""

from __future__ import annotations

from pathlib import Path

from app.core.env import getenv

API_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = API_DIR.parent.parent

MODELS_DIR = API_DIR / "data" / "models"
# Monthly landfill-intake forecaster and its real-data rolling-origin backtest
# (both written by ml/scripts/train_models.py).
MONTHLY_CALENDAR_MODEL = MODELS_DIR / "monthly_calendar_model.json"
FORECAST_EVALUATION = MODELS_DIR / "forecast_evaluation.json"
# TPA queue-input calibration on the real Bantargebang weighing data and its
# daily-arrival backtest (written by ml/scripts/calibrate_queue.py).
QUEUE_CALIBRATION = MODELS_DIR / "queue_calibration.json"
# Product/operations documents the assistant "Ana" retrieves from (RAG).
KNOWLEDGE_DIR = API_DIR / "knowledge"
# Non-code assets the service reads at runtime (cached road geometry, YOLO weights,
# the simulated gate-camera clip).
ASSETS_DIR = API_DIR / "data" / "assets"
ROAD_GEOMETRY_CACHE = ASSETS_DIR / "road_geometry_cache.json"
YOLO_WEIGHTS = ASSETS_DIR / "yolov8n.pt"
# Simplified Jakarta kecamatan boundaries for the twin (ml/scripts/build_district_outlines.py).
DISTRICT_OUTLINES = ASSETS_DIR / "jakarta_kecamatan_outlines.json"
DEMO_MEDIA_DIR = API_DIR / "data" / "media"
# Where `python -m app.forecast.weather save` writes a saved Open-Meteo response;
# PYTHIA_WEATHER_SNAPSHOT=<path> serves one instead of fetching (recording determinism).
WEATHER_SNAPSHOT_DEFAULT = API_DIR / "data" / "weather_snapshot.json"
# Real driver WhatsApp numbers stay local (git-ignored); the example file holds
# placeholders and is what the API serves when no local file exists.
DRIVER_CONTACTS_FILE = API_DIR / "driver_contacts.json"
DRIVER_CONTACTS_EXAMPLE_FILE = API_DIR / "driver_contacts.example.json"
# The Node WhatsApp gateway the API may start for pairing (app/integrations/wa_gateway_process.py).
WA_GATEWAY_DIR = REPO_ROOT / "apps" / "wa-gateway"

DATA_DIR = Path(getenv("DATA_DIR") or REPO_ROOT / "ml" / "data")
REAL_DIR = DATA_DIR / "real"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
SOURCES_DIR = DATA_DIR / "sources"
# Planner rules as data (R7/R8): kecamatan rit quotas, gate caps and dated facility
# acceptance rules, each with its source and classification. Read per plan, so
# editing the file changes the next plan without a deploy.
OPERATIONS_RULES_FILE = DATA_DIR / "config" / "operations_rules.json"
# The real Bantargebang weighing data the monthly intake model is fitted on, with its
# correction table and the Idul Fitri dates; at startup the API refits the monthly model
# in-process (app/forecast/monthly_refit.py) with the training script's own fitting code
# when this dataset holds a month the committed artifact has not seen.
BANTARGEBANG_CSV = REAL_DIR / "bantargebang_hasil_penimbangan.csv"
BANTARGEBANG_CORRECTIONS = REAL_DIR / "bantargebang_corrections.json"
IDUL_FITRI_DATES = REAL_DIR / "idul_fitri_dates.json"
TRAIN_MODELS_SCRIPT = REPO_ROOT / "ml" / "scripts" / "train_models.py"
