# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

**JWIS — Jakarta Waste Intelligence System.** AI command-center prototype for the
AI Open Innovation Challenge 2026 (case provider: DLH DKI Jakarta).

- **Case 1:** fleet supervision — simulated fleet map, route-deviation detection,
  A* reroute, TPA Bantargebang queue, staggered dispatch, SPJ (surat jalan) work orders,
  driver PWA, WhatsApp alerts.
- **Case 2:** waste-volume forecasting for 42 kecamatan (Prophet + XGBoost residual),
  resource planning (trucks/crews/man-hours/bins), OR-Tools CP-SAT weekly plan.

Product principles live in `jwis/PRODUCT.md`; visual rules in `jwis/frontend/DESIGN.md`.

## Layout

```
README.md, START_JWIS.bat, TASK_retrain_models.md (stale — see Gotchas)
deploy/                 docker-compose (backend uvicorn :8000, nginx frontend :80, wa-gateway, scentinel)
jwis/
  backend/app/          FastAPI — ALL routes are in main.py (no APIRouters)
  backend/app/ai/       background AI engine (detectors, forecasters, actions)
  backend/tests/        pytest suite (mostly unittest.TestCase style) + conftest.py
  backend/data/models/  42× prophet_<slug>.joblib + 42× xgboost_<slug>.joblib + isolation_forest_fleet.joblib
                        (_synthetic_backup/ = superseded models, not loaded)
  backend/wa-gateway/   Node/Express + Baileys WhatsApp gateway (:2785)
  frontend/src/         React 19 + Vite 6 + MapLibre (plain JS/JSX, plain CSS)
  frontend/e2e/         Playwright specs (+ lib/readme-hygiene.mjs, lib/bundle-budget.mjs)
  data/real|raw|processed|sources/   datasets; data/real/manifest.json holds provenance
  scripts/              train_models.py (Case 2), train_fleet_model.py (Case 1), data acquisition
  docs/                 audit reports, RAG knowledge base (docs/knowledge), pilot plan, evidence dossier
```

## Commands

Backend (Python 3.12; `pip install -r requirements.txt` — also needs `python-dotenv`, which is not listed):

```bash
cd jwis/backend
JWIS_AI_ENGINE=on python -m uvicorn app.main:app --port 8001   # startup warms all 42 models (~20–25 s)
python -m pytest tests -q                                       # full backend suite (~4 min)
python -m pytest tests/test_spj_endpoints.py -q                 # single file
```

- Always use **pytest**, never `unittest discover`: `tests/conftest.py` forces a temp
  `JWIS_DB_PATH` and `JWIS_SPJ_SEED=off`, defaults (`setdefault`) `JWIS_AI_ENGINE=off` and
  `JWIS_SPJ_STRAIGHT_FALLBACK=on`, and provides `api_client` / `tokens` / `auth_headers(role)`
  fixtures. Don't run tests from a shell that exported `JWIS_AI_ENGINE=on` — it leaks in.
- `test_osrm.py`, `test_map_truth.py`, `test_astar_routing.py` touch the public OSRM server;
  failures there may be network/upstream drift rather than regressions.

Frontend:

```bash
cd jwis/frontend
npm install
npm run dev                       # Vite dev :5173 by default; launchers use --port 5175
npm run build && npm run preview -- --port 5175
npm run budget                    # bundle byte budgets (run after build)
npx playwright test --workers 1   # needs backend on :8001 AND frontend on :5175 already running
node e2e/lib/readme-hygiene.mjs   # fails if root README hardcodes a test count
```

- Playwright has **no `webServer`**: start both servers yourself. Rebuild `dist/` before
  running against `preview` — a stale build causes false failures.
- E2E talks to the **real** backend at `http://127.0.0.1:8001/api` with only a few `page.route` stubs.

WhatsApp gateway: `cd jwis/backend/wa-gateway && npm install && node server.js` (scan QR).

There is **no CI** in this repo. Run the relevant suites locally before claiming done.

## Backend architecture notes

- **Auth** (`app/auth.py`): login username == role name (`executive`, `dispatcher`,
  `supervisor`, `driver`, `auditor`, `administrator`), password `JWIS_PW_<ROLE>` or
  default `<role>-demo-pass`. Bearer token in an in-process registry (12 h TTL, lost on
  restart, not shared across workers). Routes gate with
  `Depends(require_permission(...))` / `require_any_permission(...)` → 401/403.
  The SPJ override permission is `spj:override` (supervisor, administrator).
- **Persistence** (`app/storage.py`, `app/spj.py`, `app/operations_plans.py`): SQLite files
  next to `JWIS_DB_PATH` (default: system temp dir, deliberately, so `uvicorn --reload` —
  used by `run-dev.ps1` — doesn't restart on every DB write). `RecordStore` uses WAL + `BEGIN IMMEDIATE`; `StorageError` → HTTP 503,
  store `ValueError` → 409 (`_spj_or_409`). Legacy `jwis_*.json` is imported once then renamed `*.migrated`.
- **Forecast** (`app/engine.py`): Prophet yhat + XGBoost residual (11 features) + event
  overlay; falls back to a *labelled* heuristic if models fail to load. Keep feature order in
  sync with `scripts/train_models.py`.
- **Startup** (`_lifespan` in `main.py`): heavy cache warming. Model loading stays on the
  main thread — xgboost/joblib hangs in daemon threads on Windows.
- **AI engine**: only runs with `JWIS_AI_ENGINE=on`; otherwise `/api/ai/*` returns empty.
  State is surfaced in `/api/health`.
- **Assistant "Ana"** (`assistant.py`, `tools.py`, `rag.py`): OpenAI-compatible gateway
  with read-only tools; without `OPENAI_API_KEY` it answers locally and says so. RAG
  sources are listed in `rag.py` `DOCUMENT_PATHS` — editing those docs changes answers.
- **Units**: every resource quantity comes from `app/units.py` (18 t/truck, 4 workers/crew,
  8 h shift, 2.5 t bins). Never hardcode these elsewhere.

## Frontend architecture notes

- No router: `src/main.jsx` dispatches by pathname (`/field`, `/driver` without login;
  `/pengawas` and the command center behind login). Workspaces (`fleet | forecast |
  planning | drivers | audit`) are React state, registered in `layout/AppShell.jsx`.
- API base: `src/config.js` `API_URL` (`VITE_API_URL`, default absolute `http://127.0.0.1:8001/api`).
  Prefer `authenticatedRequest` from `src/dispatchApi.js` for authed calls.
- State is `useState` + props; only context is language. Offline writes go through
  localStorage outboxes: `driver/DriverOutbox.js` (per-entry `op_id` sent as `X-Operation-Id`)
  and `field/OfflineOutbox.js` (only dedupes same dispatch + status locally; no operation id is sent).
- Service worker is hand-written (`public/sw.js`), registered only in PROD and **not** under
  `navigator.webdriver`; the map uses a deterministic style under automation (`IS_AUTOMATION`).
  Keep both behaviours — e2e depends on them.

## Conventions (must follow)

- **Data honesty is a product requirement.** Never present simulated, modelled, proxy or
  cached data as live/real. Keep provenance labels (`SIMULATED`, `MODEL OUTPUT`,
  `classification` real/proxy/modeled/…, `X-Jwis-Stale`) intact, and don't add metric claims
  to docs/README that the pipeline doesn't reproduce.
- **i18n**: Indonesian is the default UI language. Add user-facing strings to *both* `en` and
  `id` in `src/i18n.jsx` and use `t()`; don't add new inline `lang === "id" ? … : …` ternaries.
- **Accessibility (enforced by e2e)**: ≥ 44×44 px touch targets, no transitions on
  width/height/padding, respect reduced motion, no horizontal overflow at 320/390 px, axe
  contrast, one `<main>`, localized aria-labels.
- **UI**: plain CSS using the custom properties in `src/styles/tokens.css` (`--ui-*`,
  `--space-*`, `--fs-*`, `--z-*`, `--tap-min`, …) rather than raw values; one
  accent colour, no gradients, no card-in-card, flat metric strip (see `DESIGN.md`).
  Components are `PascalCase.jsx` with named exports, relative imports with explicit
  extensions, icons from `lucide-react`, `data-testid` in kebab-case.
- **Tests**: every fix ships with a test. Backend → `jwis/backend/tests/test_*.py`;
  UI behaviour → `jwis/frontend/e2e/*.spec.js` headed with `// #NN:` issue reference.
- **Git**: conventional commits with scope — `fix(spj): …`, `feat(pwa): …`, `test(e2e): …`,
  `docs(readme): …` — ending with `(Fixes #NN)` or `(#NN)`. Work is batched per branch
  (`fix/<owner>-<scope>`, `feat/<topic>`) and merged via PR into `main`.
- **Secrets**: the repo is public. Never commit `.env`, `wa-gateway/baileys_auth_info/`,
  `*.db`, or logs. Template is `jwis/.env.example`.

## Gotchas

- Ports: local dev/launchers/e2e use backend **8001** and frontend **5175**; inside docker
  the backend is **8000** behind nginx `/api`. CORS is `JWIS_ALLOWED_ORIGINS` — the
  `.env.example` value only allows 5175, so a plain `npm run dev` on 5173 hits CORS errors
  unless you add that origin or set `VITE_API_URL=/api` to go through the Vite proxy.

- `TASK_retrain_models.md` is **outdated** (old machine path, 10 kelurahan, 6 features,
  `unittest discover`). The real pipeline is `jwis/scripts/train_models.py` (42 kecamatan, 11 features).
- Launchers (`START_JWIS.bat`, `jwis/run-dev.ps1`, `jwis/launch_all.bat`,
  `jwis/backend/launch_backend.bat`) hardcode user-specific Python paths, and some use stale
  ports or paths. `START_JWIS.bat` prints `admin/admin123`, which is not a valid login.
- `deploy/docker-compose.yml`'s `scentinel` service builds from an absolute path outside the repo.
- `jwis/frontend/FRONTEND_DOCS.md` and parts of `DESIGN.md` (accent hex, fonts) drift from
  the code; `src/styles/tokens.css` is the source of truth. `redesign.css` loads last and
  overrides earlier stylesheets.
- `jwis/.env.example` omits several vars the code reads: `OPENAI_BASE_URL`,
  `OPENAI_MODEL`, `JWIS_DB_PATH`, `JWIS_SPJ_SEED`, `JWIS_SPJ_STRAIGHT_FALLBACK`,
  `JWIS_GPS_SOURCE`, `OPENWA_TIMEOUT_SECONDS`.
