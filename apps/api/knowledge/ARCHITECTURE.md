# Pythia

AI command center prototype for the AI Open Innovation Challenge 2026 DLH waste case (Case 1 & Case 2).

## What This Replaces

This version replaces the legacy Streamlit code with a high-performance React/Vite command center, a Python FastAPI backend, and a lightweight Node.js WhatsApp Gateway (Baileys).
The interface is a task-first operations product: a persistent command rail,
single-action decision surfaces, and dedicated desktop/mobile workflows that
follow the visual rules in `apps/web/DESIGN.md`.

## Project Architecture

- **Frontend:** React + Vite, MapLibre GL, and a responsive command-center design system based on Geist Sans/Mono.
- **Backend:** FastAPI, OR-Tools CP-SAT (Integrated Planning optimizer), Prophet + XGBoost (Waste Forecast models), and an optional OpenAI-compatible Ana assistant gateway. Without an assistant key, Ana gives labelled local answers from relevant Pythia tools instead of inventing data.
- **WhatsApp Gateway:** A standalone Express + `@whiskeysockets/baileys` gateway running on port 2785 for direct WhatsApp alert dispatching (no Puppeteer/headless browser overhead).

### Driver analytics data contract

`GET /api/fleet/driver-analytics` returns one current assignment per truck from
the cached `/api/command-center` fleet snapshot. The response includes
`sampled_at` (UTC ISO timestamp), `source: "command-center.trucks"`, bilingual
`provenance.id`/`provenance.en`, and `drivers` with truck code, driver name,
assigned zone, current status, damage flag, and current route-deviation flag
and distance. The interface refreshes every 15 seconds, marks snapshots older
than 30 seconds or failed refreshes as stale, and keeps the last snapshot visible
on refresh failure. Rows and KPIs describe current assignments, **not**
historical trips, fuel efficiency, or driver performance scores. Pilot telemetry
and assignments are simulated; fleet composition uses the DKI 2023 truck census.

### Durable record storage

SPJ work orders, submitted event permits, pre-trip inspections, damage reports,
and service history live in SQLite record stores (`app/core/storage.py`,
`RecordStore`) whose location follows `PYTHIA_DB_PATH` (its directory when set,
otherwise the temp directory). Mutations are transactional: a request is only
acknowledged after the row commits, a failed commit returns HTTP 503 instead of
a success object, and the SPJ lifecycle uses `BEGIN IMMEDIATE` read-modify-write
transactions so two API workers cannot both activate an order for the same
truck or allocate the same daily number. Any pre-existing `pythia_*.json` store is
imported once on first start and renamed `*.json.migrated`.

### Operational resource units

`app/core/units.py` is the single source for every resource quantity, and each API
response carries a `units` glossary next to the numbers:

| Field | Unit |
|---|---|
| `trucks_required` | trucks (1 truck = 18 t per shift) |
| `crews_required` | crew teams (1 team operates 1 truck) |
| `workers_required` | people (crews × 4) |
| `man_hours_required` | person-hours (workers × 8 h shift) |
| `bins_required` | large bins (2.5 t each) |
| `recommended_extra_*` | the same units, for demand above the baseline |

### SPJ evidence and override

Closing a stop requires field evidence (arrival photo, weighing, officer).
`POST /api/spj/{id}/complete` is the exceptional path: it needs a supervisor
override with a reason and is gated by the `dispatch:override` permission, which
only the `supervisor` and `administrator` roles hold. Receipt submission is
idempotent per `operation_id`; replacing an existing receipt requires a
`replace_reason` and archives the previous one in `receipt_history`. Destination
coordinates come from `app/fleet/facilities.py`; a destination without a sourced
coordinate (`JRC Pesanggrahan`) is reported as `usable_for_routing: false` and
does not become a deviation-scoring reference path.

## Complete Demo Flow

1. **Sign In:** Enter username `dispatcher` and password `dispatcher-demo-pass`.
2. **Fleet Operations (Case 1):**
   - View simulated fleet positions and route deviations on the Live Fleet Map; positions are not live GPS.
   - Observe that `T-047` is off-corridor (marked in yellow).
   - Click the **A* Simulate Jam** button. Watch `T-047` dynamically calculate a new road-following route to TPA Bantargebang.
   - Look at the TPA Queue and staggered dispatch slots.
   - Click **Send Alert** in the Action Queue to dispatch the reroute instruction.
   - Open `/field` in another tab (no login needed) and confirm the dispatch instruction.
   - Back in Fleet Operations, the confirmation is synced instantly.
3. **Waste Forecast & AI Assistant (Case 2):**
   - Navigate to **Waste Forecast**.
   - Browse/filter the 42 Kecamatan map/list. Click a Kecamatan to expand its 3-column resource optimization dashboard (predicted waste tonnage, fuel consumption, carbon emissions, crew, and fleet mix).
   - Use **Ana** to ask a specific operational question. It selects relevant read-only tools rather than injecting a prediction into every answer; image/PDF analysis requires a configured assistant gateway.
4. **Integrated Planning:**
   - Review constraints and approve the weekly staggered queue plan.
5. **Data & ML Audit:**
   - Audit per-Kecamatan model suitability: each resolution (Kecamatan, Kelurahan, RW) carries a suitability label — `reliable`, `synthetic-validated`, or `not supported` — together with the data provenance behind it.
   - The audit workspace surfaces validation-target classes and provenance for every predicted series, so planners can see exactly which numbers rest on observed data versus synthetic coverage. (Accuracy metrics like WAPE/MAE are computed in `app/forecast/forecast_metrics.py` for offline evaluation but are not part of the current audit UI/API surface.)


### Driver weighbridge receipt

After completing all SPJ stops, the driver uploads a photo of the loaded truck's
weighbridge receipt. GutsAI vision suggests the gross weight in kilograms when
configured; the driver must check it against the receipt before submission.
If OCR is unavailable or unreadable, the same photo can be submitted with a
confirmed manually entered weight.

Receipt contract:

- One receipt per SPJ. The first accepted submission wins; a replay carrying the
  same `operation_id` returns the original receipt, and any other second
  submission is rejected with `409` rather than silently replacing handover
  evidence. Replacement would need an explicit, audited workflow.
- Weight is optional — not every handover is weighed — but a supplied value must
  be a finite `0 < w <= 60,000` kg, the same operational bound the stop evidence
  schema enforces. Out-of-range values fail field validation and record nothing.
- Metadata (photo name, weight, source, submitter, timestamp) lives in
  the `spj_receipts` table alongside the SPJ. Source is `ocr`, `manual`, or
  `unspecified` when the caller states none — an unlabelled number is never
  recorded as if a human had typed it. `GET /api/spj/{id}` and the SPJ list
  return that metadata and a `has_photo` flag, never the image bytes;
  `GET /api/spj/{id}/receipt/photo` serves the image to authorized roles.
- Every receipt writes an audit entry, readable at `GET /api/spj/{id}/audit`.
  Receipts are retained with the SPJ record in the project SQLite store
  (`pythia_spj.db`); there is no separate expiry, so the receipt outlives the
  browser session that submitted it.

## Installation & Running Locally

### 1. WhatsApp Gateway (Baileys)
Make sure Node.js is installed. Run the gateway server:
```powershell
cd "apps/wa-gateway"
npm install
node server.js
```
*Note: A QR code will display in the terminal. Scan it with the WhatsApp account that should send the alerts (the gateway's own number). Real driver numbers go in the git-ignored `apps/api/driver_contacts.json` (template: `driver_contacts.example.json`).*

### 2. Backend API
Make sure Python 3.12 is installed. Install dependencies and run the API:
```powershell
cd "apps/api"
pip install -r requirements.txt

# Copy the repo-root .env.example to .env and fill only the providers you use:
# OPENAI_API_KEY=             (optional Ana gateway; blank uses local tools)
# OPENAI_BASE_URL=            (optional OpenAI-compatible endpoint)
# OPENAI_MODEL=               (optional compatible model)
# GUTS_API_KEY=               (optional receipt OCR; leave blank for manual entry)
# GUTS_BASE_URL=https://api.gutsai.id/v1
# GUTS_VISION_MODEL=gemini-3.8-flash
# OPENWA_BASE_URL=http://localhost:2785/api
# OPENWA_API_KEY=your-wa-api-key
# OPENWA_SESSION_ID=default

# PYTHIA_AI_ENGINE=on starts the background engine (auto-reroute, TPA queue
# predictor, event forecast). Without it every /api/ai/* endpoint returns
# empty — see /api/health fields ai_engine_configured/ai_engine_running.
PYTHIA_AI_ENGINE=on python -m uvicorn app.main:app --port 8001
```
*Note: The backend will warm all Prophet + XGBoost prediction caches on startup (~20-25 seconds) to ensure instant responses.*

### 3. Frontend Web App
Run the production build preview (optimized layout):
```powershell
cd "apps/web"
npm install
npm run build
npm run preview -- --port 5175
```
Access the app at: **http://localhost:5175**

## Testing & Verification

Run the full end-to-end Playwright tests to verify zero regressions:
```powershell
cd "apps/web"
npm run build   # required: the preview server serves dist/ — a stale dist causes false e2e failures
npx playwright test --workers 1
```
*(The suite covers the current end-to-end workflows.)*
