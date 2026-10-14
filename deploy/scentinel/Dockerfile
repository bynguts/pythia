# syntax=docker/dockerfile:1

# Headless scentinel: CFD pipeline (gmsh mesh + case write + probe sampling)
# WITHOUT Qt/PySide6. OpenFOAM solves run in the OpenFOAM container via the
# host engine socket mounted from compose.
#
# Build context: deploy/scentinel, source as named context "app".

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /work

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
 && chmod +x /usr/local/bin/docker

RUN pip install fastapi "uvicorn[standard]" numpy gmsh

COPY --from=app src/scentinel ./scentinel
COPY --from=app service/runner_api.py ./runner_api.py
COPY --from=app service/podman-shim.sh /usr/local/bin/podman
RUN chmod +x /usr/local/bin/podman

ENV SCENTINEL_HOME=/data/scentinel-home \
    PYTHONPATH=/work

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/scentinel/health || exit 1

CMD ["python", "-m", "uvicorn", "runner_api:app", "--host", "0.0.0.0", "--port", "8090"]
