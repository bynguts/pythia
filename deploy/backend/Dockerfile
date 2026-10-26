# syntax=docker/dockerfile:1

# Build context: deploy/backend, with the backend source mounted as the
# named context "app" (docker-compose additional_contexts).

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# libgomp1: xgboost/ortools; libgcc: prophet wheels; curl: healthcheck
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libgcc-s1 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=app requirements.txt .
RUN pip install --retries 10 --timeout 120 -r requirements.txt

COPY --from=app app ./app
# Assistant RAG corpus (app/core/paths.py KNOWLEDGE_DIR).
COPY --from=app knowledge ./knowledge
# Placeholder driver list; mount a real driver_contacts.json at /app to override.
COPY --from=app driver_contacts.example.json ./

# /app = apps/api (with data/models), /data = ml/data (real/raw government
# datasets + kelurahan GeoJSON). The image has no repo around it, so
# app/core/paths.py is told where the datasets are.
COPY --from=app data ./data
COPY --from=dataset . /data/

ENV PYTHIA_ALLOWED_ORIGINS="http://localhost" \
    PYTHIA_DATA_DIR=/data

EXPOSE 8000

# Single worker: the 42 forecast models are loaded once per process
# (~600 MB peak warmup); more workers would multiply that on a 4 GB box.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1
