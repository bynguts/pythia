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

# real_data.py resolves datasets at parents[2]/data = jwis/data (real/raw
# government datasets + kelurahan GeoJSON), one level ABOVE backend/.
# Layout inside the image mirrors that: /app = backend, /data = jwis/data.
COPY --from=app data ./data
COPY --from=dataset . /data/

ENV JWIS_ALLOWED_ORIGINS="http://localhost"

EXPOSE 8000

# Single worker: the 42 forecast models are loaded once per process
# (~600 MB peak warmup); more workers would multiply that on a 4 GB box.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1
