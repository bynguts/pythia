"""Filesystem locations the API reads, defined once.

Repository layout::

    apps/api/          this service (API_DIR): app/, tests/, data/models/, data/assets/
    ml/data/           datasets: real/, raw/, processed/, sources/
    docs/              product, competition and knowledge documents (RAG)

The docker image has no repository around it (``/app`` holds the service,
``/data`` the datasets), so the dataset location can be set with
``PYTHIA_DATA_DIR``.
"""

from __future__ import annotations

from pathlib import Path

from app.core.env import getenv

API_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = API_DIR.parent.parent

MODELS_DIR = API_DIR / "data" / "models"
# Non-code assets the service reads at runtime (cached road geometry, YOLO weights).
ASSETS_DIR = API_DIR / "data" / "assets"
ROAD_GEOMETRY_CACHE = ASSETS_DIR / "road_geometry_cache.json"
YOLO_WEIGHTS = ASSETS_DIR / "yolov8n.pt"
DEMO_MEDIA_DIR = API_DIR / "demo_media"

DATA_DIR = Path(getenv("DATA_DIR") or REPO_ROOT / "ml" / "data")
REAL_DIR = DATA_DIR / "real"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
SOURCES_DIR = DATA_DIR / "sources"
