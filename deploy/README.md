# Deploying Pythia with Docker

One server runs three containers from `docker-compose.yml`:

| Service      | What it is                                                                          | Host port                       |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------------- |
| `backend`    | FastAPI, the forecast models and the stores (SQLite on the `pythia-history` volume) | none                            |
| `frontend`   | nginx serving the built web app and proxying `/api` to the backend                  | `PYTHIA_HTTP_BIND` (default 80) |
| `wa-gateway` | Baileys WhatsApp gateway; its session lives on the `wa-auth` volume                 | none                            |

Images build for the server's own architecture (amd64 or arm64). The Python wheels the
backend needs (Prophet, XGBoost, OR-Tools, PyMuPDF) exist for both.

## Server

- 2 vCPU and 4 GB RAM or more. The backend peaks at about 600 MB while it warms 42
  forecast models; the compose caps add up to about 2 GB.
- About 6 GB of free disk for the build (Python wheels, the web build's `node_modules`,
  the images). Run `docker builder prune -f` after a build to get most of it back.
- Docker Engine with the compose plugin (v2.24 or newer, for the optional `env_file`).

## First deploy

```bash
git clone https://github.com/bynguts/pythia.git && cd pythia/deploy
cp .env.example .env        # then edit: origin, passwords, model gateway
docker compose up -d --build
docker compose ps           # backend turns "healthy" after the model warm-up
```

Set every `PYTHIA_PW_<ROLE>` in `.env`: the defaults are public. Usernames are the role
names (`dispatcher`, `supervisor`, `driver`, `executive`, `auditor`, `administrator`).

## HTTPS

The driver app needs HTTPS for GPS, the camera and offline mode.

**Behind Caddy (or another proxy that owns 80/443).** Keep `PYTHIA_HTTP_BIND=127.0.0.1:8080`
and add a site to the Caddyfile:

```caddyfile
pythia.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

Then `sudo systemctl reload caddy`. Caddy gets the certificate by itself once the DNS
name points at the server.

**Bare server.** Set `PYTHIA_HTTP_BIND=80` and put a TLS proxy in front, or use the
server's own HTTPS setup.

`PYTHIA_ALLOWED_ORIGINS` must contain the public origin, e.g. `https://pythia.example.org`.

## Models and WhatsApp

- **Ana and the ticket OCR:** set `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`
  (any OpenAI-compatible gateway; the OCR needs a model that accepts images, or set
  `OPENAI_VISION_MODEL`). Without a key, Ana answers locally and says so, and drivers
  type the ticket weights.
- **A gateway on the server's loopback** (behind a firewall that drops container
  traffic): run with the host-network override, which binds every container to
  127.0.0.1, and set `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`:
  `docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build`.
- **WhatsApp:** sign in as `dispatcher` or `administrator`, open Settings → WhatsApp and
  scan the QR code. The session survives restarts on the `wa-auth` volume.

## Updating

```bash
git pull
docker compose up -d --build
docker builder prune -f
```

The stores and the WhatsApp session are on volumes, so they survive a rebuild.

## Backups

```bash
docker run --rm -v pythia-stack_pythia-history:/v -v "$PWD":/b alpine \
  tar czf /b/pythia-history-$(date +%F).tgz -C /v .
```

## Notes

- Fleet positions are simulated, and gate waits come from a seeded queue simulation.
  The app labels both; a deploy does not make them live.
- SPJ activation follows roads through the public OSRM server. When it is unreachable,
  activation answers 409 instead of drawing a straight line; set
  `PYTHIA_SPJ_STRAIGHT_FALLBACK=on` in `.env` to activate anyway; the SPJ audit then
  records that the road geometry was unresolved.
- The optional `scentinel` profile builds from a separate repository
  (`SCENTINEL_SRC`); leave it off unless you have it.
