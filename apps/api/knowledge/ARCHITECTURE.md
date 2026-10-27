# Pythia

Operations software for city waste fleets: it forecasts tomorrow's waste per district,
turns it into a truck plan with landfill gate slots, and follows the day to the
weighbridge ticket. Built on Jakarta's public waste data and ready to plug into an
agency's own fleet and weighbridge feeds; a live demo runs at https://pythia.web.id with a
simulated fleet (labelled as such), and the first agency pilot is the next step. Pythia
has two working surfaces:

- **Dispatcher console** (`/app/<page>`): Operations, Morning readiness, TPA gate, Work
  orders, Tomorrow, Fleet & drivers, Reports and Settings. Supervisor mode is a toggle in
  the console sidebar for accounts that may approve; it turns Tomorrow into the review
  and approval view. Ana opens from every page.
- **Driver app** (`/driver`): an offline-capable web app for budget Android phones. It
  shows the instruction and the stops of the work order (SPJ, the DKI surat jalan), the gate slot, the "I'm at the gate"
  tap, the weigh-ticket photo with OCR, the pre-trip check and damage reports, and AR
  navigation to a stop for crews on foot.

The landing page is `/`. Legacy briefing-room screens (`/twin`, `/xr`) remain in the code
but are not part of the product, and Ana does not offer them as features.

## Project Architecture

- **Frontend:** React + Vite and MapLibre GL, styled with the design tokens in
  `apps/web/src/styles/tokens.css`.
- **Backend:** FastAPI; Prophet + XGBoost district forecast (`app/forecast/engine.py`),
  the outlook (`app/forecast/outlook.py`) and the weighbridge learning loop
  (`app/forecast/learning.py`); OR-Tools CP-SAT daily plan; gate slots
  (`app/fleet/gate_slots.py`); work orders with a sealed audit chain
  (`app/field/spj.py`) and ticket rule checks (`app/field/receipt_checks.py`); ticket OCR
  (`app/field/timbangan_ocr.py`); and the optional OpenAI-compatible Ana gateway. Without
  an assistant key, Ana gives labelled local answers from relevant Pythia tools instead
  of inventing data.
- **WhatsApp Gateway:** A standalone Express + `@whiskeysockets/baileys` gateway running on port 2785 that sends the WhatsApp alerts (no Puppeteer/headless browser overhead). Baileys is an unofficial WhatsApp Web client, fit for the prototype only; a pilot would use the WhatsApp Business Platform. Messages go out in one language chosen in Settings (Indonesian by default).

### Forecast horizon and learning loop

- **Tomorrow and the outlook.** `GET /api/forecast/tomorrow` gives the plan day per
  kecamatan; `GET /api/forecast/outlook?days=7|14|30` gives the city-wide days ahead
  (total, average and peak day) and the next 3 months of Bantargebang intake with its
  backtest; `GET /api/predictions/kecamatan?horizon_days=` gives per-district days (2 to
  30). Inputs fill themselves in (Open-Meteo weather, events, permits, holidays).
  Open-Meteo is fetched 16 days ahead (`app/forecast/weather.py`), so the 7- and 14-day
  outlooks run on real forecast weather; days 17 to 30 run on a dry-day baseline (0 mm,
  31 °C, 10 km/h), flagged `beyond_weather_forecast`, which sharpens as each day enters the
  weather window. Every figure is `MODEL OUTPUT`.
- **Learning loop** (`app/forecast/learning.py`). For each closed day whose weighbridge
  tickets all carry a net weight and that has an approved plan, weighed tonnes
  (`OBSERVED_IN_APP`) are compared with the plan's forecast tonnes, pro-rated to the trips
  weighed. The correction is an EWMA (alpha 0.3) of actual / forecast over the last 14
  weighed days, clamped to +/-25 % so one odd day cannot swing the plan: it learns from
  every weighed day and self-corrects from the third. It is shown next to the raw model
  value, never in place of it.
- **Value per 1,000 gate trips** (`GET /api/reports/value-model`, `app/fleet/value_model.py`):
  truck-hours, driver duty hours, idle diesel and trips over the gate alert, without and
  with staggered slots, in low, base and high cases, never rupiah. The waits come from the
  gate-queue simulation and every other parameter is a labelled assumption
  (`SIMULATED × ASSUMPTION`).

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

Work orders, submitted event permits, pre-trip inspections, damage reports,
and service history live in SQLite record stores (`app/core/storage.py`,
`RecordStore`) whose location follows `PYTHIA_DB_PATH` (its directory when set,
otherwise the temp directory). Mutations are transactional: a request is only
acknowledged after the row commits, a failed commit returns HTTP 503 instead of
a success object, and the work-order lifecycle uses `BEGIN IMMEDIATE` read-modify-write
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

### Work-order evidence and override

Closing a stop requires field evidence (arrival photo, weighing, officer).
`POST /api/spj/{id}/complete` is the exceptional path: it needs a supervisor
override with a reason and is gated by the `spj:override` permission, which
only the `supervisor` and `administrator` roles hold. Receipt submission is
idempotent per `operation_id`; a different second submission is refused with 409, and a
reviewer confirms or corrects the recorded weights once
(`POST /api/spj/{id}/receipt/review`), with the previous weights kept in the audit. Destination
coordinates come from `app/fleet/facilities.py`; a destination without a sourced
coordinate (`JRC Pesanggrahan`) is reported as `usable_for_routing: false` and
does not become a deviation-scoring reference path.

### Driver safety

`app/field/safety.py` and `/api/safety/*` turn two promises into per-truck states;
the thresholds are `DUTY_WARN_MIN`, `DUTY_BLOCK_MIN` and `GATE_ALERT_MIN` in
`app/core/units.py`.

- **Duty:** minutes since the truck's first pre-trip check or work-order activation of the
  local WIB day (a work order still active from the day before carries its start over).
  `warn` from 600 min (10 h); `blocked` from 720 min (12 h). While blocked, creating or
  activating a work order for that truck returns 409 with an Indonesian reason, unless a
  holder of `spj:override` (supervisor, administrator) recorded an override with a
  reason of at least 10 characters for that truck today. The override is stored with
  the signed-in username and written to `/api/history` (`safety_duty_override`); each
  work-order start it allows writes `safety_override_used`, and each refusal
  `safety_duty_block`.
- **Gate wait:** from the work order's `gate_arrival` event (the driver's tap, with the device
  time accepted for offline replays) to the weighbridge receipt, or to now while the
  truck still waits. At 180 min (DLH's 3-hour gate-wait promise) one alert per truck per
  gate visit is stored and, when `PYTHIA_WA_DEFAULT_GROUP_ID` is set, sent once to that
  supervisor group (never to a driver's personal number). Alerts are swept on every
  safety read and by a background timer every 60 s started from the app lifespan
  (`PYTHIA_SAFETY_GATE_TIMER`, on by default), so no panel needs to be open.
- **Classification:** `OBSERVED_APP_EVENTS` when this server holds pre-trip, work-order,
  gate-arrival or receipt events for the local day; every number then comes from them.
  With none, the overview falls back to a seeded scenario over the simulated fleet,
  labelled `SIMULATED`; it never blocks a work order, stores an alert or sends a message.
  The two are never mixed.
- **Access:** `GET /api/safety/driver/{truck}` and `POST /api/safety/gate-arrival` take
  a driver token or an operator token (`dashboard:read`); a personal driver account
  bound to a truck gets 403 for any other truck. `GET /api/safety/overview` needs
  `dashboard:read`; `POST /api/safety/override` needs `spj:override`.

### Dispatcher loop: plan, work order, gate, recap

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
   - Every approve ensures one **draft** work order per truck, dated the plan day. The draft
     is labelled `Rencana {plan_id} (MODEL)`. Its stops are real SILIKA TPS points of the
     districts the truck serves (up to 3 per district, `TPS_STOPS_PER_AREA` in
     `app/api/routers/operations.py`); a district without a SILIKA TPS keeps a labelled
     centroid planning point.
   - A truck whose facility is unknown is reported in `spj_drafts`, never given a
     default facility.
   - Drafts are not checked against duty limits; activation is, so a human still
     activates every work order.
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
   a truck's draft work order, instruction and dispatch to another truck. The steps run in
   order and resume after a failure, so a retry never creates a second dispatch.
   The old dispatch becomes `REASSIGNED`, and a later READY from the old driver's
   outbox gets 409. It refuses (409) a target that is damaged, duty-blocked or
   already in the plan, and a work order that is already active.
5. **Morning readiness (`GET /api/readiness`, `dashboard:read`).** Shows, per truck:
   - today's pre-trip;
   - duty state (simulated duty never blocks);
   - instruction acknowledgement;
   - work-order status, including `spj_active_other`;
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

### Ana's proposals, driver messages and escalations

- **`propose_action` (Ana's tool, `app/assistant/proposals.py`).** Ana drafts at most 3
  actions per answer: `message_driver`, `send_instruction` (kind `general`, `use_route` or
  `handle_alert`) or `escalate_to_supervisor`. The tool writes, sends and records nothing.
  The console shows each draft as a card with the recipient, the channels and the full
  text; the operator sends it, edits it first, or dismisses it, and only that click (with
  the operator's own token) calls the endpoints below. Nothing runs on its own.
- **`GET /api/driver/messages/channels/{truck}`** (`dispatch:create`): where a message to
  that truck's driver would go, as channel names only, never a number.
- **`POST /api/driver/messages`** (`dispatch:create`): one text or instruction to one
  truck's driver. 404 for an unknown truck, 422 for empty or over-long text.
- **`POST /api/escalations`** (`dispatch:create`): puts an escalation in the supervisor's
  queue (Needs you and the bell); it sends nothing else.
- **Delivery rule** (`app/field/driver_messages.py`): a message for one truck goes only to
  that driver: the driver app inbox, a phone notification when the driver has allowed
  them, and a private WhatsApp when a contact exists. The WhatsApp group carries
  fleet-wide alerts only.

## Complete Demo Flow

1. **Tomorrow:** sign in as `dispatcher` (`dispatcherpw` on pythia.web.id,
   `dispatcher-demo-pass` locally) and open **Tomorrow**.
   - Read the forecast and its reasons (weather, events, holidays) and the 7/14/30-day
     outlook (`GET /api/forecast/outlook`).
   - Read the monthly **Bantargebang intake** chart under the outlook: the forecast
     backtested on real weighbridge data (`GET /api/ml/monthly-intake`; model card in
     Settings → Data). Its data end in April 2026 and the backtest covers 1–3 months ahead,
     so each month is marked inside or outside the backtested horizon.
2. **Plan and approve:**
   - Build the daily plan ("Rencana harian"): CP-SAT assigns
     18 t truck trips per shift and facility for the top forecast districts (5 by default)
     on the simulated fleet. Kecamatan rit quotas, the Bantargebang gate caps, the RDF
     Rorotan rules and per-truck trip limits are hard constraints from an example rules
     file (`EXAMPLE_CONFIG`, every value with its source, to be confirmed with DLH); demand
     they cannot serve is shown as unassigned tonnes.
   - Sign in as `supervisor`, switch on **Supervisor mode** and approve. Approval creates
     one draft work order per truck with its stops, gate slot and departure time, and the driver
     instruction.
3. **Driver:** open `/driver` on a phone, sign in as `driver` (`driverpw` on pythia.web.id,
   `driver-demo-pass` locally), pick the truck, accept the instruction and do the pre-trip check.
4. **Morning:** **Morning readiness** shows which trucks are ready; activate today's work
   orders there. **Operations** is map-first (simulated positions, not live GPS) and lists
   what needs a person; send an instruction to one truck or a WhatsApp message to the
   alert group.
5. **Gate and ticket:** the driver taps "I'm at the gate" and photographs the
   weigh ticket. **TPA gate** shows the slot, the queue and recommended holds;
   **Work orders** shows the ticket, its rule checks and the seal state.
6. **Close of day:** **Reports** compares actual against forecast and shows the value per
   1,000 gate trips; the learning loop takes the weighed day into the next forecast.
7. **Ana:** ask a specific operational question ("how many tonnes tomorrow?", "who is not
   ready?"). It selects relevant read-only tools rather than injecting a prediction into
   every answer; image/PDF analysis requires a configured assistant gateway.
8. **Model card** (Settings, Data tab):
   - Model card: for the monthly landfill-intake forecast (total and per city) it shows the model's error next to the strongest simple baseline on real Bantargebang data (rolling-origin backtest), green when the whole 90% interval of the gain is above zero, red otherwise. The numbers come from `GET /api/ml/suitability` (`monthly_backtest`), which reads `apps/api/data/models/forecast_evaluation.json` written by `ml/scripts/train_models.py`.
   - Suitability labels per resolution: `backtested_real` (monthly landfill and city intake), `synthetic_validated` (city-day and per-district week/month: sums or slices of the calibrated-synthetic series), `reproduces_input` (hotspot ranking: it reproduces the SILIKA 2023 input ranking, not evidence of skill) and `not_supported` (district-day). No daily or per-district accuracy is claimed.


### Driver weighbridge receipt

After completing all work-order stops, the driver photographs the weighbridge ticket.
`POST /api/ocr/timbangan` (`app/field/timbangan_ocr.py`, the dedicated vision provider when
`GUTS_API_KEY` is set, otherwise the OpenAI-compatible gateway) reads gross, tare, net,
ticket number, plate, weighing times and site, or says the photo is not a ticket. The
reading is `MODEL OUTPUT` and only prefills the form; the driver confirms or corrects it
before submission. If OCR is unavailable or unreadable, the same photo can be submitted
with a confirmed manually entered weight.

- **Seal:** every work-order audit entry carries the SHA-256 of the previous one (canonical
  JSON), and the receipt stores the photo digest. `GET /api/spj/{id}/integrity`
  re-verifies the chain; the console shows "Sealed" or "Seal broken".
- **Rule checks** (`app/field/receipt_checks.py`, not AI): gross - tare = net on the
  ticket, net within the 18 t truck capacity, OCR against the recorded gross, duplicate
  ticket numbers or photos, the ticket plate against the work order's truck. A failed check
  becomes a Needs-you item (`receipt_check`) that cites its rule; it never changes a
  recorded weight.

Receipt contract:

- One receipt per work order. The first accepted submission wins; a replay carrying the
  same `operation_id` returns the original receipt, and any other second
  submission is rejected with `409` rather than silently replacing handover
  evidence. Replacement would need an explicit, audited workflow.
- Weight is optional — not every handover is weighed — but a supplied value must
  be a finite `0 < w <= 60,000` kg, the same operational bound the stop evidence
  schema enforces. Out-of-range values fail field validation and record nothing.
- Metadata (photo name, weight, source, submitter, timestamp) lives in
  the `spj_receipts` table alongside the work order. Source is `ocr`, `manual`, or
  `unspecified` when the caller states none — an unlabelled number is never
  recorded as if a human had typed it. `GET /api/spj/{id}` and the work-order list
  return that metadata and a `has_photo` flag, never the image bytes;
  `GET /api/spj/{id}/receipt/photo` serves the image to authorized roles.
- Every receipt writes an audit entry, readable at `GET /api/spj/{id}/audit`.
  Receipts are retained with the work-order record in the project SQLite store
  (`pythia_spj.db`); there is no separate expiry, so the receipt outlives the
  browser session that submitted it.

## Installation & Running Locally

The repository README has the full quick start. In short: copy `.env.example` to `.env`
(every provider is optional; `OPENAI_API_KEY` enables the Ana gateway and the ticket
OCR, without it Ana answers locally and drivers type the weights), then run
`scripts/dev.ps1` (Windows) or `scripts/dev.sh`, which start the API on port 8001 with
`PYTHIA_AI_ENGINE=on` and the web app on port 5175. The API warms all Prophet + XGBoost
caches on startup (about 20-25 seconds). The WhatsApp gateway is optional; pair it from
Settings, WhatsApp by scanning the QR code. Real driver numbers go in the git-ignored
`apps/api/driver_contacts.json` (template: `driver_contacts.example.json`).

Tests: `python -m pytest tests -q` in `apps/api`; Playwright end-to-end tests in
`apps/web` run against a built app (`npm run build`, then `npx playwright test --workers 1`).

## Console endpoints

Each figure carries its provenance (`classification`: FIELD, MODEL_OUTPUT or SIMULATED);
a value with no source is `null` with a `reason`.

- `GET /api/ops/needs-you`: one feed of open items (simulated corridor deviations, today's
  driver exceptions, open heavy damage, unaccepted gate holds, duty alerts from observed
  events only). An item's `id` is its follow-up key; a RESOLVED follow-up drops it.
- `GET /api/field/devices`: trucks whose driver app called this server in the last 30 min.
- `GET/POST/DELETE /api/field-facts`: the dispatcher's field facts, the only manual plan
  input. Only `truck_unavailable` changes a plan; other facts are recorded, not modelled.
- `POST /api/operations/plan?auto_inputs=true`: rain, the largest located event and the
  holiday come from the forecast; field facts take trucks out. Plans carry `solve_seconds`.
- `POST /api/operations/plans/{id}/return` (approver, with a note), `/withdraw` (planner),
  `/swap` (exchange two trucks' work before approval; logged in `edits`). With `draft=true` a
  plan stays out of the approver's inbox until `POST /api/operations/plans/{id}/submit`.
- `POST /api/whatsapp/summary`: sends the day's summary text to the alert group only; the
  event log keeps its length, not the text.
- `GET /api/fleet/drivers-week`: trips, proof, gate punctuality and duty per driver from
  field records (history:read).
- `GET /api/driver/trip/{truck}`: next stop and TPA drive time from the phone's position
  (OSRM), today's gate slot and the modelled queue of the next two hours.
- `POST /api/spj/{id}/stops/{i}/skip`: dispatch skips a stop; it is never counted as collected.
- Additions to existing reads: recap `planned_trips`, gate wait mean/max and
  `summary_lines`; readiness `first_departure`, `backup_candidates`, per-truck `zone` and
  `gate_slot`; gate board `impact`; work-order audit `plan_events`; driver exceptions carry their
  follow-up status and a driver may read its own truck's reports.
