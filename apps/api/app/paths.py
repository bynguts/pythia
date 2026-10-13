"""Filesystem locations the API reads, defined once.

Repository layout::

    apps/api/          this service (API_DIR): app/, tests/, data/models/
    ml/data/           datasets: real/, raw/, processed/, sources/
    docs/              product, competition and knowledge documents (RAG)

The docker image has no repository around it (``/app`` holds the service,
``/data`` the datasets), so the dataset location can be set with
``PYTHIA_DATA_DIR``.
"""

from __future__ import annotations

from pathlib import Path

from app.env import getenv

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parent.parent

MODELS_DIR = API_DIR / "data" / "models"
DEMO_MEDIA_DIR = API_DIR / "demo_media"

DATA_DIR = Path(getenv("DATA_DIR") or REPO_ROOT / "ml" / "data")
REAL_DIR = DATA_DIR / "real"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
SOURCES_DIR = DATA_DIR / "sources"
