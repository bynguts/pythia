# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

**Pythia.** AI command-center prototype for municipal waste operations, built for the
AI Open Innovation Challenge 2026 (case provider: DLH DKI Jakarta).

- **Case 1:** fleet supervision — simulated fleet map, route-deviation detection,
  A* reroute, TPA Bantargebang queue, staggered dispatch, SPJ (surat jalan) work orders,
  driver PWA (with AR navigation), WhatsApp alerts.
- **Case 2:** waste-volume forecasting for 42 kecamatan (Prophet + XGBoost residual),
  resource planning (trucks/crews/man-hours/bins), OR-Tools CP-SAT weekly plan.
- **City twin:** 3D twin workspace (deck.gl), WebXR tabletop (`/xr`), Jakarta + a
  simulated Ho Chi Minh City demo city (`app/forecast/cities.py`).

Product principles live in `apps/api/knowledge/PRODUCT.md`; visual rules in `apps/web/DESIGN.md`.

## Layout

```
apps/api/         FastAPI service (Python 3.12)
  app/main.py       create_app(): settings, CORS, lifespan, router wiring
  app/api/          routers/ (one module per area), deps.py (permission deps),
                    schemas.py, state.py (shared singletons/caches), warmup.py
  app/core/         env.py (settings), paths.py (every file location), auth.py,
                    storage.py (SQLite RecordStore), units.py (resource constants)
  app/forecast/     engine.py (Prophet+XGBoost), weather, real_data, impact,
                    facility_planning, forecast_metrics, cities, twin
  app/fleet/        fleet data/generator, GPS feed, deviation, A*/OSRM routing, TPA queue,
                    operations optimizer + plans, facilities, collector registry, CV
  app/field/        spj.py (work orders), permits, pretrip, damage reports, compliance,
                    service history, timbangan (weighbridge) OCR
  app/assistant/    assistant "Ana", tools, rag.py, pdf_vision
  app/integrations/ whatsapp.py (OpenWA), scentinel.py
  app/ai/           background AI engine: detectors/, forecasters/, actions/, engine_loop
  tests/<area>/     pytest, mirrors app/ (conftest.py + spj_testutil.py at tests/)
  knowledge/        assistant RAG corpus: ARCHITECTURE.md, PRODUCT.md, 01_–04_ operator docs
  data/models/      trained Prophet/XGBoost artifacts;  data/assets/ road cache, YOLO weights
                    (Ultralytics, AGPL-3.0);  data/media/ simulated gate-camera clip
  driver_contacts.example.json  placeholder template; real driver_contacts.json is git-ignored
apps/web/         React 19 + Vite 6 + react-router 7 + MapLibre + deck.gl + three.js
  src/main.jsx      bootstrap only (ErrorBoundary → BrowserRouter → LanguageProvider → App)
  src/app/          App.jsx (routes + login gate), CommandCenter, AppShell,
                    workspaces.js (nav registry), serviceWorker.js
  src/features/     command-center workspaces: fleet, forecast, planning, twin,
                    drivers, audit, assistant
  src/surfaces/     standalone surfaces: driver (PWA + AR), field, login, supervisor, xr
  src/shared/       api/client.js, config.js, hooks/, i18n/ (index.jsx + locales/en.js, id.js), ui/
  src/styles/       index.css imports the global cascade (tokens.css … redesign.css last)
  e2e/              Playwright specs, lib/ (budget, readme hygiene), recording/
apps/wa-gateway/  Node/Express + Baileys WhatsApp gateway (:2785, binds 127.0.0.1 unless HOST)
ml/data/          real/ raw/ processed/ sources/ datasets (real/manifest.json = provenance)
ml/scripts/       train_models.py (Case 2), train_fleet_model.py (Case 1), data acquisition
                  (see ml/README.md)
docs/             local only (git-ignored): competition, audit and pilot material
deploy/           docker compose stack (backend, frontend/nginx, wa-gateway, scentinel profile)
scripts/          dev.ps1 / dev.sh one-command launchers
```

## Commands

Backend (`cd apps/api`; `pip install -r requirements-dev.txt` = runtime deps + pytest + ruff):

```bash
PYTHIA_AI_ENGINE=on python -m uvicorn app.main:app --port 8001   # warms all 42 models (~20–25 s)
python -m pytest tests -q                                       # full suite (~4 min)
python -m pytest tests/field/test_spj.py -q                     # single file
ruff check . && ruff format --check .                           # lint + format gate
```

- Always use **pytest**, never `unittest discover`: `tests/conftest.py` forces a temp
  `PYTHIA_DB_PATH` and `PYTHIA_SPJ_SEED=off`, defaults (`setdefault`) `PYTHIA_AI_ENGINE=off` and
  `PYTHIA_SPJ_STRAIGHT_FALLBACK=on`, and provides `api_client` / `tokens` / `auth_headers(role)`
  fixtures. Don't run tests from a shell that exported `PYTHIA_AI_ENGINE=on` — it leaks in.
- `tests/fleet/test_osrm.py`, `test_map_truth.py`, `test_astar_routing.py` touch the public
  OSRM server; failures there may be network/upstream drift rather than regressions.

Frontend (`cd apps/web`):

```bash
npm install
npm run dev                       # Vite dev :5173 by default; launchers use --port 5175
npm run lint && npm run format:check
npm run build && npm run budget   # bundle byte budgets (run after build)
npm run preview -- --port 5175
npx playwright test --workers 1   # needs backend on :8001 AND frontend on :5175 already running
node e2e/lib/readme-hygiene.mjs   # fails if root README hardcodes a test count
```

- Playwright has **no `webServer`**: start both servers yourself. Rebuild `dist/` before
  running against `preview` — a stale build causes false failures. Override targets with
  `PLAYWRIGHT_BASE_URL` / `PLAYWRIGHT_API_BASE_URL` (defaults :5175 / `http://127.0.0.1:8001/api`).
- E2E talks to the **real** backend with only a few `page.route` stubs.

Everything at once: `scripts/dev.ps1` (Windows; `-WhatsApp`, `-Install`) or `scripts/dev.sh`.
WhatsApp gateway alone: `cd apps/wa-gateway && npm install && npm start` (scan QR).

**CI** (`.github/workflows/ci.yml`) runs on `main`, `feat/**`, `fix/**`, `refactor/**` and PRs:
API — ruff check, ruff format --check, pytest; Web — lint, format:check, build, budget,
README hygiene. E2E is not in CI: run the relevant Playwright specs locally.

## Backend architecture notes

- **Routing**: each `app/api/routers/*.py` owns an `APIRouter`; `main.py` only includes them.
  Shared mutable state (stores, caches + their locks, AI detectors) lives once in
  `app/api/state.py` — import it from there, never re-create it in a router. When a test
  monkeypatches something, patch the module the router actually reads it from.
- **Auth** (`app/core/auth.py`): login username == role name (`executive`, `dispatcher`,
  `supervisor`, `driver`, `auditor`, `administrator`), password `PYTHIA_PW_<ROLE>` or
  default `<role>-demo-pass`. Bearer token in an in-process registry (12 h TTL, lost on
  restart, not shared across workers). Routes gate with
  `Depends(require_permission(...))` / `require_any_permission(...)` from `app/api/deps.py`
  → 401/403. The SPJ override permission is `spj:override` (supervisor, administrator).
- **Persistence** (`app/core/storage.py`, `app/field/spj.py`, `app/fleet/operations_plans.py`):
  SQLite files next to `PYTHIA_DB_PATH` (default: system temp dir, deliberately, so
  `uvicorn --reload` doesn't restart on every DB write). `RecordStore` uses WAL +
  `BEGIN IMMEDIATE`; `StorageError` → HTTP 503, store `ValueError` → 409 (`_spj_or_409`
  in `routers/spj.py`).
- **Paths** (`app/core/paths.py`): every file location the API uses. Datasets resolve to
  `PYTHIA_DATA_DIR` or `ml/data` in the repo (docker: `/data`). Don't build paths ad hoc.
- **Forecast** (`app/forecast/engine.py`): Prophet yhat + XGBoost residual (11 features) +
  event overlay; falls back to a *labelled* heuristic if models fail to load. Keep feature
  order in sync with `ml/scripts/train_models.py` (which writes to `apps/api/data/models`).
- **Startup** (`_lifespan` in `main.py` → `app/api/warmup.py`, then the AI engine): heavy cache
  warming. Model loading stays on the main thread — xgboost/joblib hangs in daemon threads
  on Windows. Routers are imported inside `create_app()`, after `load_dotenv()`.
- **AI engine** (`app/ai/`, started from `routers/ai.py`): only runs with
  `PYTHIA_AI_ENGINE=on`; otherwise `/api/ai/*` returns empty. State is surfaced in `/api/health`.
- **Assistant "Ana"** (`app/assistant/`): OpenAI-compatible gateway with read-only tools;
  without `OPENAI_API_KEY` it answers locally and says so. RAG sources are listed in
  `rag.py` `DOCUMENT_PATHS` (mostly `apps/api/knowledge/`) — editing those docs changes
  answers. Never index anything holding personal data (contacts, names, addresses).
- **Units**: every resource quantity comes from `app/core/units.py` (18 t/truck,
  4 workers/crew, 8 h shift, 2.5 t bins). Never hardcode these elsewhere.

## Frontend architecture notes

- **Routing** (`src/app/App.jsx`, react-router): public `/field`, `/driver`, `/xr`; behind
  the login gate `/pengawas` and the command-center workspaces `/fleet` (default), `/twin`,
  `/forecast`, `/planning`, `/drivers`, `/audit` (registry: `src/app/workspaces.js`).
  `/` redirects to `/fleet`, or `/twin` for `?workspace=twin` / `?present=1` (the rest of the
  query string is kept). The login gate renders in place, so deep links survive login.
- **API**: every call goes through `src/shared/api/client.js` — `apiFetch` (raw `Response`,
  bearer token from `localStorage.pythia_token`, network errors pass through unwrapped for
  the outboxes), `apiGet` / `apiPost` (parsed JSON, throw `ApiError`). Base URL is
  `src/shared/config.js` `API_URL` (`VITE_API_URL`, default `http://127.0.0.1:8001/api`).
  Don't call `fetch` directly.
- State is `useState` + props; only context is language. Offline writes go through
  localStorage outboxes: `surfaces/driver/DriverOutbox.js` (per-entry `op_id` sent as
  `X-Operation-Id`) and `surfaces/field/OfflineOutbox.js` (dedupes same dispatch + status
  locally; sends a per-entry `operation_id` in the confirm body for the backend replay guard).
- Lazy chunks (`LiveFleetMap`, `TwinWorkspace`, `XrTabletop`, `ArNavigator`) have byte
  budgets in `e2e/lib/bundle-budget.mjs`; keep heavy libraries out of the main chunk.
- Service worker is hand-written (`public/sw.js`, registered from `src/app/serviceWorker.js`)
  only in PROD and **not** under `navigator.webdriver`; navigations fall back to the cached
  shell. The map uses a deterministic style under automation (`IS_AUTOMATION`).
  Keep both behaviours — e2e depends on them.

## Conventions (must follow)

- **Data honesty is a product requirement.** Never present simulated, modelled, proxy or
  cached data as live/real. Keep provenance labels (`SIMULATED`, `SIMULATED_DEMO_CITY`,
  `MODEL OUTPUT`, `classification` real/proxy/modeled/…, `X-Pythia-Stale`) intact, and don't
  add metric claims to the README or knowledge docs that the pipeline doesn't reproduce.
- **i18n**: Indonesian is the default UI language. Add user-facing strings to *both*
  `src/shared/i18n/locales/en.js` and `id.js` and use `t()`; don't add new inline
  `lang === "id" ? … : …` ternaries.
- **Accessibility (enforced by e2e)**: ≥ 44×44 px touch targets, no transitions on
  width/height/padding, respect reduced motion, no horizontal overflow at 320/390 px, axe
  contrast, one `<main>`, localized aria-labels.
- **UI**: plain CSS using the custom properties in `src/styles/tokens.css` (`--ui-*`,
  `--space-*`, `--fs-*`, `--z-*`, `--tap-min`, …) rather than raw values; one
  accent colour, no gradients, no card-in-card, flat metric strip (see `DESIGN.md`).
  Components are `PascalCase.jsx` with named exports, relative imports with explicit
  extensions, icons from `lucide-react`, `data-testid` in kebab-case. New code goes in the
  feature/surface it belongs to; only genuinely shared pieces go in `src/shared/`.
- **Style gates**: ruff (API) and ESLint + Prettier (web, printWidth 110) must pass —
  CI enforces them. `.editorconfig` / `.gitattributes` fix line endings.
- **Tests**: every fix ships with a test. Backend → `apps/api/tests/<area>/test_*.py`;
  UI behaviour → `apps/web/e2e/*.spec.js` headed with `// #NN:` issue reference.
- **Git**: conventional commits with scope — `fix(spj): …`, `feat(pwa): …`, `test(e2e): …`,
  `docs(readme): …` — ending with `(Fixes #NN)` or `(#NN)` when there is an issue. Work is
  batched per branch (`fix/<owner>-<scope>`, `feat/<topic>`, `refactor/<topic>`) and merged
  via PR into `main`.
- **Secrets & personal data**: the repo is public. Never commit `.env`,
  `apps/wa-gateway/baileys_auth_info/`, `apps/api/driver_contacts.json`, `*.db`, or logs, and
  no personal data (phone numbers, people's names/addresses) in code, datasets or docs —
  use placeholders such as `6281234567890@c.us`. Template is `.env.example` (lists every
  variable the code reads; WhatsApp defaults: `PYTHIA_WA_DEFAULT_CHAT_ID` / `_GROUP_ID`).
- **Settings**: read `PYTHIA_*` settings through `app.core.env.getenv("NAME")` (env var
  `PYTHIA_NAME`), not `os.getenv("PYTHIA_…")`. Third-party names (`OPENAI_*`, `OPENWA_*`,
  `GUTS_*`) are read with `os.getenv`.
- **Naming**: the product and the team are Pythia — use no other name in code, docs or
  commit messages. Name tests after the behaviour they cover, not a person or event.

## Gotchas

- Ports: local dev/launchers/e2e use backend **8001** and frontend **5175**; inside docker
  the backend is **8000** behind nginx `/api`. CORS is `PYTHIA_ALLOWED_ORIGINS` — the
  `.env.example` value only allows 5175, so a plain `npm run dev` on 5173 hits CORS errors
  unless you add that origin or set `VITE_API_URL=/api` to go through the Vite proxy.
- Without `PYTHIA_DB_PATH`, every checkout/worktree shares one set of store files in the
  system temp dir — isolate e2e/dev runs with `PYTHIA_DB_PATH`.
- `deploy/docker-compose.yml`'s `scentinel` service is behind the `scentinel` profile and
  builds from `SCENTINEL_SRC` (default `../../scentinel`, outside this repo).
- Parts of `apps/web/DESIGN.md` (accent hex, fonts) drift from the code;
  `src/styles/tokens.css` is the source of truth. `redesign.css` loads last and overrides
  earlier stylesheets.
- The full stack (API warm-up ~600 MB, vite build, Playwright) is memory-hungry: on a small
  machine run pytest, builds and e2e one at a time.
