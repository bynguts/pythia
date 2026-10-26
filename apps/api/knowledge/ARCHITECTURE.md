# Pythia

AI + immersive-media command center prototype for city waste agencies, built and tested on
Jakarta's public waste data (not a deployed or piloted system): fleet supervision (Case 1 module), waste forecasting and planning (Case 2
module), and an immersive layer (3D twin, driver AR, XR tabletop).

## What This Replaces

This version replaces the legacy Streamlit code with a high-performance React/Vite command center, a Python FastAPI backend, and a lightweight Node.js WhatsApp Gateway (Baileys).
The interface is a task-first operations product: a persistent command rail,
single-action decision surfaces, and dedicated desktop/mobile workflows that
follow the design tokens in `apps/web/src/styles/tokens.css`.

## Project Architecture

- **Frontend:** React + Vite, MapLibre GL, and a responsive command-center design system based on Geist Sans/Mono.
- **Backend:** FastAPI, OR-Tools CP-SAT (Integrated Planning optimizer), Prophet + XGBoost (Waste Forecast models), and an optional OpenAI-compatible Ana assistant gateway. Without an assistant key, Ana gives labelled local answers from relevant Pythia tools instead of inventing data.
- **WhatsApp Gateway:** A standalone Express + `@whiskeysockets/baileys` gateway running on port 2785 that sends the WhatsApp alerts (no Puppeteer/headless browser overhead). Baileys is an unofficial WhatsApp Web client, fit for the prototype only; a pilot would use the WhatsApp Business Platform.

### Driver analytics data contract

`GET /api/fleet/driver-analytics` returns one current assignment per truck from
the cached `/api/command-center` fleet snapshot. The response includes
`sampled_at` (UTC ISO timestamp), `source: "command-center.trucks"`, bilingual
`provenance.id`/`provenance.en`, and `drivers` with truck code, driver name,
assigned zone, current status, damage flag, and current route-deviation flag
and distance. The interface refreshes every 15 seconds, marks snapshots older
than 30 seconds or failed refreshes as stale, and keeps the last snapshot visible
on refresh failure. Rows and KPIs describe current assignments, **not**
historical trips, fuel efficiency, or driver performance scores. Fleet telemetry
and assignments are simulated; fleet composition uses the latest DKI truck census
(2025: 1,700 trucks, motor carts excluded).

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
override with a reason and is gated by the `spj:override` permission, which
only the `supervisor` and `administrator` roles hold. Receipt submission is
idempotent per `operation_id`; replacing an existing receipt requires a
`replace_reason` and archives the previous one in `receipt_history`. Destination
coordinates come from `app/fleet/facilities.py`; a destination without a sourced
coordinate (`JRC Pesanggrahan`) is reported as `usable_for_routing: false` and
does not become a deviation-scoring reference path.

### Driver safety

`app/field/safety.py` and `/api/safety/*` turn two promises into per-truck states;
the thresholds are `DUTY_WARN_MIN`, `DUTY_BLOCK_MIN` and `GATE_ALERT_MIN` in
`app/core/units.py`.

- **Duty:** minutes since the truck's first pre-trip check or SPJ activation of the
  local WIB day (an SPJ still active from the day before carries its start over).
  `warn` from 600 min (10 h); `blocked` from 720 min (12 h). While blocked, creating or
  activating an SPJ for that truck returns 409 with an Indonesian reason, unless a
  holder of `spj:override` (supervisor, administrator) recorded an override with a
  reason of at least 10 characters for that truck today. The override is stored with
  the signed-in username and written to `/api/history` (`safety_duty_override`); each
  SPJ start it allows writes `safety_override_used`, and each refusal
  `safety_duty_block`.
- **Gate wait:** from the SPJ `gate_arrival` event (the driver's tap, with the device
  time accepted for offline replays) to the weighbridge receipt, or to now while the
  truck still waits. At 180 min (DLH's 3-hour gate-wait promise) one alert per truck per
  gate visit is stored and, when `PYTHIA_WA_DEFAULT_GROUP_ID` is set, sent once to that
  supervisor group (never to a driver's personal number). Alerts are swept on every
  safety read and by a background timer every 60 s started from the app lifespan
  (`PYTHIA_SAFETY_GATE_TIMER`, on by default), so no panel needs to be open.
- **Classification:** `OBSERVED_APP_EVENTS` when this server holds pre-trip, SPJ,
  gate-arrival or receipt events for the local day; every number then comes from them.
  With none, the overview falls back to a seeded scenario over the simulated fleet,
  labelled `SIMULATED`; it never blocks an SPJ, stores an alert or sends a message.
  The two are never mixed.
- **Access:** `GET /api/safety/driver/{truck}` and `POST /api/safety/gate-arrival` take
  a driver token or an operator token (`dashboard:read`); a personal driver account
  bound to a truck gets 403 for any other truck. `GET /api/safety/overview` needs
  `dashboard:read`; `POST /api/safety/override` needs `spj:override`.

### Dispatcher loop: plan, SPJ, gate, recap

Pythia has two working surfaces: the dispatcher console and the driver app. The
supervisor approves inside the console. The loop runs in this order:

1. **Tomorrow (`GET /api/forecast/tomorrow`, `dashboard:read`).** Gives the forecast
   for the plan day and the drivers behind it: weather (Open-Meteo), official events
   (multi-day events count on every day they run), submitted permits, holiday and
   weekday. Each driver carries `effect_classification`. An unknown effect is `null`,
   never guessed. `total_tonnage_t` stays the no-event baseline, and
   `with_events_total_t` is reported beside it. Nobody types in rain or attendance.
2. **Plan and approval.** `POST /api/operations/plan` proposes and
   `POST /api/operations/{plan_id}/approve` approves (`operations:approve`).
   - Every approve ensures one **draft** SPJ per truck, dated the plan day. The draft
     is labelled `Rencana {plan_id} (MODEL)` and has one planning-centroid stop per
     kecamatan.
   - A truck whose facility is unknown is reported in `spj_drafts`, never given a
     default facility.
   - Drafts are not checked against duty limits; activation is, so a human still
     activates every SPJ.
   - `GET /api/operations/plans/{plan_id}` returns the plan with its `spj_drafts`.
     The console polls it so the dispatcher sees the approval without reloading.
3. **Gate slot and departure.** `app/fleet/gate_slots.py` gives each truck a
   15-minute weighbridge slot at TPST Bantargebang and a `depart_at` (the slot start
   minus `COLLECTION_ROUND_MEAN_H`). The driver's instruction text ends with
   `Berangkat HH:MM · Slot gerbang … (keluaran model)`.
   - Capacity per slot comes from the weighbridge constants, minus the observed
     arrivals not covered by plans.
   - RDF Plant Jakarta (Rorotan) trucks use no Bantargebang capacity.
   - `GET /api/gate/slots` lists live holds of at most 60 minutes, or says
     `saturated` when no hold helps. Accepting a hold
     (`POST /api/gate/slots/recommendations/{rec_id}/accept`, `dispatch:create`)
     sends the driver one instruction.
   - Every figure is `SIMULATED` / `MODEL_OUTPUT`.
4. **Reassign (`POST /api/operations/{plan_id}/reassign`, `dispatch:create`).** Moves
   a truck's draft SPJ, instruction and dispatch to another truck. The steps run in
   order and resume after a failure, so a retry never creates a second dispatch.
   The old dispatch becomes `REASSIGNED`, and a later READY from the old driver's
   outbox gets 409. It refuses (409) a target that is damaged, duty-blocked or
   already in the plan, and an SPJ that is already active.
5. **Morning readiness (`GET /api/readiness`, `dashboard:read`).** Shows, per truck:
   - today's pre-trip;
   - duty state (simulated duty never blocks);
   - instruction acknowledgement;
   - SPJ status, including `spj_active_other`;
   - open damage;
   - service due within 7 days.
6. **Close of day (`GET /api/recap/daily`).** Compares actual against planned:
   - receipt net tonnes and trips;
   - gate waits observed in the app;
   - driver exceptions, damage and supervisor overrides.

   A side with no data is `null`.

Ana answers "who is not ready?" and "how did today go?" through the read-only tools
`get_readiness` and `get_daily_recap`. Both drop person names before anything
reaches the external model gateway.

**ETA labels.** Every ETA carries `eta_source`: `osrm_duration` (road routing time
from the public OSRM server), `fallback_estimate` (straight-line distance at a fixed
speed) or `simulated`. An A* route is `fallback_estimate` if any leg fell back. ETAs
are routing estimates, not AI predictions.

**Queue calibration on real data.** `ml/scripts/calibrate_queue.py` writes
`data/models/queue_calibration.json` from the Bantargebang weighing records. It
reports:
- arrivals of about 1,228 trips/day (12-month median);
- about 5.95 t per trip, against the 18 t truck capacity used for planning;
- an arrival backtest showing no skill over last month's value.

`/api/tpa/queue-metric` exposes this as `calibration`. Gate waiting times are not in
the records, so they stay `SIMULATED` (`wait_validation: "not_observed"`).

## Complete Demo Flow

1. **Sign In:** Enter username `dispatcher` and password `dispatcher-demo-pass`.
2. **Fleet Operations (Case 1):**
   - View simulated fleet positions and route deviations on the Live Fleet Map; positions are not live GPS.
   - Observe that `T-047` is off-corridor (marked in yellow).
   - Click the **A* Simulate Jam** button. Watch `T-047` dynamically calculate a new road-following route to TPA Bantargebang.
   - Look at the TPA Queue and staggered dispatch slots.
   - Click **Send Alert** in the Action Queue to dispatch the reroute instruction.
   - Open `/field` in another tab, sign in as `driver` (`driver-demo-pass`) and confirm the dispatch instruction.
   - Back in Fleet Operations, the confirmation appears within seconds (the dashboard polls every 8 s).
3. **Waste Forecast & AI Assistant (Case 2):**
   - Navigate to **Waste Forecast**.
   - Browse/filter the 42 Kecamatan map/list. Click a Kecamatan to expand its 3-column resource optimization dashboard (predicted waste tonnage, fuel consumption, carbon emissions, crew, and fleet mix).
   - Read the **Bantargebang intake** strip: the monthly forecast backtested on real data
     (`GET /api/ml/monthly-intake`). Its data end in April 2026 and the backtest covers 1–3 months
     ahead, so each month is badged inside or outside the backtested horizon.
   - Use **Ana** to ask a specific operational question. It selects relevant read-only tools rather than injecting a prediction into every answer; image/PDF analysis requires a configured assistant gateway.
4. **Integrated Planning:**
   - Review the rules in force and build the daily plan ("Rencana harian"): CP-SAT assigns
     18 t truck trips per shift and facility for the top forecast districts (5 by default)
     on the simulated fleet. Kecamatan rit quotas, the Bantargebang gate caps, the RDF
     Rorotan rules and per-truck trip limits are hard constraints from an example rules
     file (`EXAMPLE_CONFIG`, every value with its source, to be confirmed with DLH); demand
     they cannot serve is shown as unassigned tonnes. A supervisor approves the plan,
     which creates the per-truck dispatch instructions. The staggered landfill arrivals
     are a separate seeded queue simulation (SIMULATED), not part of this plan.
5. **Data & ML Audit:**
   - Model card: for the monthly landfill-intake forecast (total and per city) it shows the model's error next to the strongest simple baseline on real Bantargebang data (rolling-origin backtest), green when the whole 90% interval of the gain is above zero, red otherwise. The numbers come from `GET /api/ml/suitability` (`monthly_backtest`), which reads `apps/api/data/models/forecast_evaluation.json` written by `ml/scripts/train_models.py`.
   - Suitability labels per resolution: `backtested_real` (monthly landfill and city intake), `synthetic_validated` (city-day and per-district week/month: sums or slices of the calibrated-synthetic series), `reproduces_input` (hotspot ranking: it reproduces the SILIKA 2023 input ranking, not evidence of skill) and `not_supported` (district-day). No daily or per-district accuracy is claimed.


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

Run the end-to-end Playwright tests against the built app:
```powershell
cd "apps/web"
npm run build   # required: the preview server serves dist/ — a stale dist causes false e2e failures
npx playwright test --workers 1
```
*(The suite covers the current end-to-end workflows.)*
