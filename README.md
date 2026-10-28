# Pythia

**Waste operations, decided before dawn.** Waste software optimises the curb; Pythia plans the
landfill gate. Pythia is operations software for city waste
fleets. It forecasts tomorrow's waste for every district, turns the forecast into a truck
plan, gives each truck a landfill gate slot, and follows the day through to the
weighbridge ticket. Dispatchers and supervisors work in one console; drivers work in a
phone app built for budget Android handsets.

- **Live demo:** [pythia.web.id](https://pythia.web.id) (demo accounts below).
- **Validated on real data:** the monthly Bantargebang intake forecast is backtested on 66
  forecasts across 23 months of real weighbridge records, with 13.4 % less error than the
  strongest simple baseline, and 40.8 % less in the Ramadan and Lebaran months when the
  spikes hit.
- **Ready for an agency's own data:** built on Jakarta's public waste data, it plugs into
  a city's fleet, weighbridge and calendar feeds. How every number is validated:
  [How we validate](#how-we-validate).
- **Startup entry** for the 2026 Global Startup Competition (Chung-Ang University,
  College of Virtual Convergence & Center for eXtended Reality, COSS Immersive Media).

---

## Contents

- [The problem](#the-problem)
- [What Pythia does](#what-pythia-does)
- [The two surfaces](#the-two-surfaces)
- [The AI in the product](#the-ai-in-the-product)
- [Driver-safety guard](#driver-safety-guard)
- [Data](#data)
- [How we validate](#how-we-validate)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Demo accounts](#demo-accounts)
- [Demo flow](#demo-flow)
- [Deploy](#deploy)
- [Repository layout](#repository-layout)
- [Tests and CI](#tests-and-ci)
- [Security and credentials](#security-and-credentials)

---

## The problem

City waste operations are **reactive**. A city learns how much waste there is only after
it has piled up, and the trucks, the crews and the landfill all find out at the same
moment: at the gate.

- On 8 March 2026 part of **TPST Bantargebang**, the landfill that takes Jakarta's
  waste, slid after heavy rain *while trucks were queuing to unload*. Seven people
  were killed ([Katadata, Jun 2026](https://katadata.co.id/ekonomi-hijau/investasi-hijau/6a21b5bd1d019/bantargebang-dan-ujian-pengelolaan-sampah-jakarta)).
  One victim was reportedly a truck driver queueing to unload ([NU Online](https://nu.or.id/nasional/diduga-sopir-truk-1-korban-longsor-sampah-bantargebang-kembali-ditemukan-qU5V9);
  identity unconfirmed at the time; see also [Asia News Network](https://asianews.network/deadly-landfill-collapse-exposes-jakartas-decades-long-waste-mismanagement/)).
- Jakarta produces about **7,200–9,200 tonnes of waste a day** (SIPSN 2021–2025), almost all of it
  trucked to that one site (SIPSN data via [RRI](https://rri.co.id/en/archipelago/2248964/jakarta-targets-rorotan-rdf-to-process-1000-tons-daily)).
  On a median day about 1,228 trips pass its weighbridge (Bantargebang weighing
  records, latest 12 months; `ml/scripts/calibrate_queue.py`).
- The pattern repeats across Southeast Asia. In December 2025 Ho Chi Minh City's
  Da Phuoc landfill moved to night-only intake, and backlogs followed
  ([Tuổi Trẻ](https://news.tuoitre.vn/ho-chi-minh-city-faces-waste-backlogs-as-landfill-restricts-daytime-operations-103251118145703962.htm)).

Rain, holidays and crowd events drive the spikes, so they can be predicted. What is
missing is a plan made from that prediction: which trucks leave when, which gate slot
each one takes, and who acts when something goes wrong.

**Who pays:** city environment agencies (B2G), as a software subscription sized by
fleet. Jakarta first, then other Indonesian metros, then Southeast Asia. Collection and
landfill operators can run the same stack.

---

## What Pythia does

One daily loop, from the forecast to the ticket and back into the forecast.

| Step | What happens | Where |
|---|---|---|
| **Forecast** | Tonnes per district (42 Jakarta kecamatan) for tomorrow, and a city outlook up to 30 days ahead. The inputs fill themselves in: Open-Meteo weather, the official event calendar, submitted permits, holidays and the weekday. Nobody types in rain or attendance. | Tomorrow |
| **Plan** | OR-Tools CP-SAT turns the forecast into the daily plan (Rencana harian): truck trips per shift within the gate caps and trip limits. A supervisor approves it in the same console. | Tomorrow |
| **Instruct** | Approval creates one draft work order (SPJ, the DKI surat jalan) per truck with a 15-minute Bantargebang gate slot and a departure time. Each driver gets the instruction on the phone. | Work orders, driver app |
| **Run the day** | Morning readiness per truck, a map-first operations view, one "Needs you" list, gate slot recommendations, and WhatsApp alerts. | Operations, Morning readiness, TPA gate |
| **Close the day** | Actual against forecast from weighbridge tickets and trips, gate waits and incidents. A figure with no source stays empty. | Reports |
| **Learn** | Every weighed day teaches the forecast: from the third one, a correction learned from the weighbridge appears next to the raw model value. | Tomorrow |
| **Ask** | Ana answers "how many tonnes tomorrow?" or "which trucks are not ready?" from read-only tools. It proposes actions for the dispatcher to send; it never dispatches or approves on its own. | Every console page |

Every number carries its source (observed, model output, simulated or assumption) in a
tooltip and in Settings → Data and provenance.

---

## The two surfaces

### Dispatcher console (`/app`)

The console is for the dispatcher on shift. **Supervisor mode** is a toggle in the same
sidebar (for accounts that hold the approval permission): it turns the Tomorrow page
into the review-and-approve view instead of opening a separate app. **Ask Ana** opens
the assistant from any page, and the bell shows the open "Needs you" items from
anywhere.

| Page | What happens there |
|---|---|
| **Operations** (`/app/operations`) | Map-first view of the day. "Needs you" lists what waits on a person: an instruction not acknowledged, a truck off its corridor, a duty-hour warning, a long gate wait, a weigh ticket that failed a check. Send a **New instruction** to one truck (it lands in that driver's app) or **Message drivers** through the WhatsApp alert group. |
| **Morning readiness** (`/app/readiness`) | Per truck before departure: pre-trip check, duty state, instruction acknowledged, work-order status, open damage, service due. Activate today's work orders from here. |
| **TPA gate** (`/app/gate`) | Bantargebang gate slots (15 minutes, at most 30 trucks each), the queue ahead, recommended holds the dispatcher can accept, and the gate-wait alert at 180 min. |
| **Work orders** (`/app/work-orders`) | Work-order list and detail: stops, route, gate slot, the weigh ticket with its photo and rule checks, the seal state and the audit trail. A work order dated tomorrow can't be activated before its day. |
| **Tomorrow** (`/app/tomorrow`) | Tomorrow's forecast and why (weather, events, holidays), the outlook ahead, the monthly Bantargebang intake with its backtest, the plan and its approval. |
| **Fleet & drivers** (`/app/fleet`) | Trucks, drivers' week (trips, proof, gate punctuality, duty) and service history. |
| **Reports** (`/app/reports`) | The close-of-day recap and the value per 1,000 gate trips. |
| **Settings** (`/app/settings`) | Account and team, notifications, WhatsApp pairing by QR code (no terminal needed) and the one language WhatsApp messages go out in (Indonesian by default), data sources with their labels and the model card, the audit log, and language. |

### Driver app (`/driver`)

A progressive web app for budget Android handsets. It signs in with the driver account
and keeps working offline.

- **Instruction:** the approved plan as trips, in the UI language ("Tomorrow's
  instruction" for a plan dated tomorrow); accept with one tap.
- **Route:** stops in order on a map, then **Go to TPA** with the gate slot and the
  arrival time counted from departure. Optional AR navigation (camera, GPS and compass)
  guides crews on foot to a stop and captures the arrival photo; it locks while the
  phone moves at vehicle speed.
- **Gate:** "I'm at the gate" starts the gate-wait clock.
- **Weigh ticket:** a photo of the weighbridge ticket; a vision model reads it and the
  driver confirms or corrects the numbers.
- **Pre-trip check, damage and exception reports** with photos.
- **Offline:** every write waits in an outbox and is sent once, with an operation id,
  when the signal returns.

The landing page at `/` explains the product and links to both surfaces.

---

## The AI in the product

Forecasting, optimisation, vision, an assistant and tamper-evident records, each tagged
with its provenance in the API responses, in tooltips and in Settings → Data and provenance.

| Piece | What it does | Provenance label |
|---|---|---|
| **District forecast** | Prophet plus an XGBoost residual (11 features) per kecamatan, with an event overlay (`app/forecast/engine.py`). If a model fails to load, a heuristic takes over and says so. | MODEL OUTPUT |
| **Outlook horizon** | Tomorrow per district, and a city outlook of up to 30 days (`GET /api/forecast/outlook`; per district `GET /api/predictions/kecamatan?horizon_days=2…30`). The console offers 7, 14 or 30 days (`?days=`). Open-Meteo weather is fetched 16 days ahead, so the 7- and 14-day outlooks run on real forecast weather; days 17–30 run on a dry-day baseline (0 mm, 31 °C, 10 km/h), flagged `beyond_weather_forecast`, that sharpens as each day enters the weather window. | MODEL OUTPUT |
| **Monthly Bantargebang intake** | Calendar-adjusted 12-month level with a Ramadan and Lebaran adjustment, fitted on real weighing data: 4.3 % mean absolute percentage error 1–3 months ahead (see [Data](#data)). | MODEL OUTPUT, backtested on real data |
| **Learning loop** | `app/forecast/learning.py`: learns from every weighed day, self-correcting from the third. Each closed day's weighed tonnes are compared with the approved plan's forecast; the correction is an exponentially weighted average (alpha 0.3) of actual / forecast over the last 14 weighed days, capped at ±25 % so one odd day cannot swing the plan. The dispatcher sees it next to the raw model value. | OBSERVED_IN_APP vs MODEL OUTPUT |
| **Daily plan** | OR-Tools CP-SAT assigns 18 t truck trips per shift and facility. Gate caps, RDF Rorotan intake and per-truck trip limits are hard constraints from a dated example rules file (`ml/data/config/operations_rules.json`, classified `EXAMPLE_CONFIG`, each rule with its source, to be confirmed with DLH). Demand beyond the caps surfaces as unassigned tonnes for the dispatcher to act on. | Optimisation |
| **Gate slots and recommendations** | `app/fleet/gate_slots.py` gives each planned truck a 15-minute slot and a departure time. Slot capacity is weighbridge lanes × slot length / weigh cycle; the rest of the gate's traffic is the observed daily arrivals. `GET /api/gate/slots` recommends holds of at most 60 minutes, or says the gate is saturated; accepting one sends the driver one instruction. | SIMULATED / MODEL OUTPUT |
| **Ana** | An OpenAI-compatible LLM with read-only tools (forecast, outlook, readiness, recap, gate queue, weather, events, provenance…) and retrieval over the docs in `apps/api/knowledge/` and this README (`app/assistant/rag.py`). Phone numbers, plates and known people's names are replaced with placeholders before text reaches the model gateway (`app/assistant/pii.py`). Without an API key, Ana answers locally from the same tools and says so. | Assistant |
| **Ana's proposals** | `propose_action` drafts a message or instruction to one driver, or an escalation to the supervisor, as a card with the full text. The dispatcher sends, edits or dismisses it; nothing runs on its own. A one-truck message reaches only that driver (app inbox, phone notification, private WhatsApp when a contact exists); the WhatsApp group carries fleet-wide alerts. | Human in the loop |
| **Weigh-ticket OCR** | `POST /api/ocr/timbangan` reads gross, tare, net, ticket number, plate, weighing times and site, or says the photo is not a ticket. It prefills the form, and a person confirms it before it becomes a recorded weight. | MODEL OUTPUT |
| **Sealed work order** | Every work-order audit entry carries the SHA-256 of the previous one, and the receipt stores the photo digest. `GET /api/spj/{id}/integrity` re-verifies the chain; the console shows "Sealed" or "Seal broken". | Rule |
| **Ticket cross-checks** | `app/field/receipt_checks.py`: gross − tare = net, net within the 18 t truck capacity, OCR against the recorded gross, duplicate ticket numbers or photos, the ticket plate against the work order's truck. A failed check becomes a "Needs you" item that cites its rule. | Rule, not AI |
| **Value per 1,000 gate trips** | `GET /api/reports/value-model`: truck-hours, driver duty hours, idle diesel and trips over the gate alert, without and with staggered slots, in low, base and high cases. Never rupiah. | SIMULATED × ASSUMPTION |
| **ETA** | An OSRM road-routing duration, or a labelled straight-line fallback. | Routing estimate, not AI |

---

## Driver-safety guard

Duty time per truck runs from the first pre-trip check or work-order activation of the local
(WIB) day:

- At 600 min (10 h) the console shows a warning.
- From 720 min (12 h) no new work order can be created or activated until a supervisor
  records an override with a reason. Every override is written to the audit history.
- The gate wait runs from the driver's gate-arrival tap to the weighbridge ticket. At
  180 min (DLH's 3-hour gate-wait promise) one alert per wait is stored and sent to the
  supervisor WhatsApp group when one is configured.

The numbers are classified `OBSERVED_APP_EVENTS` (pre-trip, work-order, gate-arrival and receipt
events recorded on this server). A server with no such events today shows a seeded
scenario labelled SIMULATED, which never blocks a work order or sends an alert. The thresholds
live in `app/core/units.py`.

---

## Data

Every real input is listed with its source URL, date and limitations in
[`ml/data/real/manifest.json`](ml/data/real/manifest.json).

| Data | Source | Used for |
|---|---|---|
| Bantargebang weighing records, monthly trips and tonnes per source, 2022-12 to 2026-04 | data.go.id | Monthly intake model and backtest, gate arrival rate, tonnes per trip |
| Waste generation per kecamatan, 2023 | SILIKA (DLH DKI Jakarta) | District forecast calibration, hotspot ranking |
| City waste generation, 2018–2025 | SIPSN (KLHK) | City totals |
| TPS and retribution-point locations | SILIKA, data.go.id | Stops on work-order routes, the map |
| Truck census per area | data.go.id | Size and mix of the simulated fleet |
| Event calendar 2021–2026, national holidays, Idul Fitri dates | Published event schedules, holiday API, setneg.go.id | Forecast inputs |
| Kelurahan boundaries, population | Open boundary data, data.go.id | Map and per-district features |
| Daily weather forecast | Open-Meteo (live API) | Forecast input |

Two corrupted source rows are corrected, and one missing month is kept as a gap, as
listed in `ml/data/real/bantargebang_corrections.json`.

**Monthly intake forecast** (`apps/api/data/models/forecast_evaluation.json`, written by
`ml/scripts/train_models.py`): 13.4 % less error than the strongest simple baseline, a
12-month moving average (90 % CI 4.3–22.9 %), and 40.8 % less in the Ramadan and Lebaran
months; mean absolute percentage error 4.3 %. Rolling-origin backtest: 66 forecasts from 23
origins, 2024-06 to 2026-04, 1–3 months ahead, each model seeing only the months before
its origin.

**Staggered gate slots** (`GET /api/tpa/queue-metric`, `app/fleet/queue_simulation.py`)
cut the mean weighbridge wait on a normal day from 57.1 to 5.6 minutes per truck, a 90 %
reduction, in Pythia's seeded gate-queue simulation driven by the real median of 1,228
daily trips. Current practice spans 35.2–65.9 minutes across 10–60-minute departure
spreads.

---

## How we validate

Every number Pythia shows carries its provenance (observed, model output, simulated or
assumption), and Settings → Data lists the source of each. This is the one place the
whole picture is written down.

- **Monthly intake** is validated on real data 1–3 months ahead, through April 2026, the
  latest published weighing records; further months join the backtest as new weighings
  arrive. The gain comes from the Ramadan and Lebaran months; in other months the model
  matches the baseline (0.3 %). Full report: `ml/data/processed/hybrid_forecaster_evaluation.md`.
- **Daily and per-district forecasts** are calibrated-synthetic: generated from SILIKA 2023
  district totals, SIPSN growth and the Bantargebang month index, so they carry no
  accuracy claim yet. The learning loop is how that changes: every weighed day is stored
  as actual against forecast, and a pilot's tickets become the per-district accuracy record.
- **Gate waits** come from the seeded queue simulation, because the weighing records do
  not carry waiting times. The driver's gate tap measures real dwell from the first day of
  a pilot.
- **Fleet positions** in the demo are simulated, and the console says so ("Coming soon ·
  Live GPS tracking"). Everything the driver app records (pre-trip, gate tap, tickets) is real
  phone data on the server it talks to.
- **Plan rules** come from a dated example file (`EXAMPLE_CONFIG`), each rule with its
  source, ready to be confirmed with DLH.
- **Value per 1,000 gate trips** combines the queue simulation with labelled
  assumptions, each with a low and high case.
- **WhatsApp** runs through Baileys, an unofficial WhatsApp Web client, for the
  prototype; an agency deployment moves to the WhatsApp Business Platform.
- **Pilot:** Pythia runs today as a public demo; the first agency pilot is the next step.

---

## Architecture

Detailed notes: [`apps/api/knowledge/ARCHITECTURE.md`](apps/api/knowledge/ARCHITECTURE.md)
(data contracts, storage, receipts) and [`apps/api/knowledge/PRODUCT.md`](apps/api/knowledge/PRODUCT.md)
(users, product principles). Ana answers from the same documents.

```text
┌───────────────────────────────────────────────────────────────┐
│ WEB (React 19 + Vite + MapLibre GL)                           │
│   Landing (/)   Dispatcher console (/app/:page)               │
│   Driver app (/driver: PWA, offline outbox, AR to a stop)     │
└────────────────────────────┬──────────────────────────────────┘
                             │  HTTP / JSON
┌────────────────────────────▼──────────────────────────────────┐
│ API (Python 3.12, FastAPI)                                    │
│   • Prophet + XGBoost  · 42-district forecast, outlook        │
│   • learning loop      · weighed actual vs forecast           │
│   • OR-Tools CP-SAT    · daily plan within gate caps          │
│   • plan → work orders · stops, gate slots, seal              │
│   • OSRM routing       · routes, ETA, deviation checks        │
│   • ticket OCR, Ana    · vision model, LLM + read-only tools  │
│   • SQLite stores      · work orders, receipts, audit         │
└────────────────────────────┬──────────────────────────────────┘
                             │  HTTP / JSON
┌────────────────────────────▼──────────────────────────────────┐
│ WHATSAPP GATEWAY (Node.js + Baileys)                          │
│   QR pairing from Settings → alerts and driver messages       │
└───────────────────────────────────────────────────────────────┘
```

---

## Quick start

Prerequisites: Python 3.12+, Node.js 20+, npm.

Copy the environment template once: `cp .env.example .env` (PowerShell:
`Copy-Item .env.example .env`). Every setting is optional for a local demo. Set
`OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL`, `OPENAI_MODEL`) for an
OpenAI-compatible model behind Ana and the ticket OCR. Without a key, Ana answers
locally from the same read-only tools and says so, and drivers type the ticket weights.

### One command

```powershell
.\scripts\dev.ps1 -Install      # Windows; add -WhatsApp for the gateway
./scripts/dev.sh --install        # Linux / macOS; add --whatsapp
```

This starts the API on **:8001** and the web app on **http://localhost:5175**, then
opens the browser once the API is healthy. The first start warms the 42 forecast models
(about 20–25 s).

### Each service by hand

```bash
# API (FastAPI). The background AI engine runs only when enabled.
cd apps/api
pip install -r requirements.txt
PYTHIA_AI_ENGINE=on python -m uvicorn app.main:app --port 8001

# Web app (React + Vite)
cd apps/web
npm install
npm run dev -- --port 5175

# WhatsApp gateway (optional). The console can also start it: Settings → WhatsApp.
cd apps/wa-gateway
npm install
npm start          # listens on 127.0.0.1:2785; set HOST to bind elsewhere
```

Keep the gateway on localhost or a private docker network and never publish port 2785.
The console reaches its pairing QR and group list only through the API, which requires a
dispatcher or administrator login. Driver contacts stay administrator-only.

Session files under `apps/wa-gateway/baileys_auth_info/` are created at runtime and
**never committed**. Driver WhatsApp numbers go in `apps/api/driver_contacts.json`
(git-ignored; copy `driver_contacts.example.json`). Without it, alerts go to
`PYTHIA_WA_DEFAULT_CHAT_ID` / `PYTHIA_WA_DEFAULT_GROUP_ID`.

---

## Demo accounts

| Role | Username | [pythia.web.id](https://pythia.web.id) | Local run (default) |
|---|---|---|---|
| Dispatcher (console) | `dispatcher` | `dispatcherpw` | `dispatcher-demo-pass` |
| Supervisor (Supervisor mode: plan approval, work-order and duty overrides) | `supervisor` | `supervisorpw` | `supervisor-demo-pass` |
| Driver (`/driver`) | `driver` | `driverpw` | `driver-demo-pass` |
| Administrator (accounts, contacts, WhatsApp) | `administrator` | on request | `administrator-demo-pass` |

The live administrator password is not published because that account controls the
WhatsApp link. Every role's password can be overridden with `PYTHIA_PW_<ROLE>`, and a
public server must override them all. The shared `driver` account may act for any truck. Personal accounts
from `PYTHIA_USERS_FILE` (template `apps/api/users.example.json`) bind each driver to one
truck, and the API refuses that driver's requests for another truck.

---

## Demo flow

1. **Tomorrow:** sign in as `dispatcher` and open **Tomorrow**. Read the forecast and its
   reasons (weather, events, holidays) and the outlook ahead, then build the plan.
2. **Approve:** sign in as `supervisor`, switch on **Supervisor mode** and approve the
   plan. Draft work orders appear in **Work orders**, one per truck, each with stops and a gate
   slot.
3. **Driver:** open `/driver` on a phone as `driver`, pick the truck and accept
   "Tomorrow's instruction". Then do the pre-trip check.
4. **Morning:** in **Morning readiness**, see which trucks are ready and activate today's
   work orders. **Operations** shows what needs you; send an instruction or a WhatsApp
   message.
5. **Gate:** the driver taps "I'm at the gate" and photographs the weigh
   ticket. **TPA gate** shows the slot and the wait; **Work orders** shows the ticket, its
   checks and the seal.
6. **Close:** **Reports** shows actual against forecast for the day; the next forecast
   learns from it.
7. **Ask:** ask Ana "how many tonnes tomorrow?" or "which trucks are not ready?".

---

## Deploy

One server runs three containers (API, nginx serving the web app, WhatsApp gateway) with
`docker compose`. Server size, HTTPS, model gateway, updates and backups:
[`deploy/README.md`](deploy/README.md). The public demo at
[pythia.web.id](https://pythia.web.id) runs this stack.

---

## Repository layout

```text
pythia/
├── .github/workflows/  # CI: API lint + tests, web lint + build + bundle budget
├── apps/
│   ├── api/            # FastAPI service
│   │   ├── app/        #   routers, forecast, fleet/routing, field (work orders, receipts), assistant
│   │   ├── tests/      #   pytest, one folder per app area
│   │   ├── knowledge/  #   Ana's knowledge base: ARCHITECTURE.md, PRODUCT.md, operator guides
│   │   └── data/       #   models/ (Prophet + XGBoost), assets/ (road cache, YOLO weights)
│   ├── web/            # React + Vite: landing, console (src/app, features, surfaces, shared, styles), driver app, e2e/
│   └── wa-gateway/     # WhatsApp gateway (Express + Baileys)
├── ml/                 # datasets + training scripts (see ml/README.md)
│   ├── data/           # real/ raw/ processed/ sources/, provenance in real/manifest.json
│   └── scripts/        # reproducible training + data acquisition pipelines
├── deploy/             # docker compose: backend, frontend (nginx), wa-gateway
├── scripts/            # dev.ps1 / dev.sh, run everything locally
└── .env.example        # environment template (copy to .env; never commit secrets)
```

Legacy briefing-room code (`/twin`, `/xr`) remains in the repository but is not part of
the product.

---

## Tests and CI

```bash
cd apps/api && python -m pytest tests -q                          # backend
cd apps/api && ruff check . && ruff format --check .              # backend lint
cd apps/web && npm run lint && npm run format:check               # web lint
cd apps/web && npm run build && npm run budget                    # build + bundle budgets
cd apps/web && npx playwright test --workers 1                    # end-to-end
```

The end-to-end suite needs the API on :8001 and the built web app on :5175
(`npm run preview -- --port 5175`). CI runs everything above except end-to-end on every
push and pull request. The suite grows with every fixed issue, so test counts are not
tracked in this file; run the commands or check the CI run attached to each commit. The
hygiene gate `node apps/web/e2e/lib/readme-hygiene.mjs` fails if this README hardcodes a
count.

---

## Security and credentials

The repository is **public**:

- **`.env` files are git-ignored and must never be committed.** Use `.env.example` as the
  template; values live only on the running machine.
- **WhatsApp session store** (`apps/wa-gateway/baileys_auth_info/`) holds real session
  credentials. It is ignored and regenerated on every QR scan.
- **Driver contacts** (`apps/api/driver_contacts.json`) hold real phone numbers. The file
  is ignored; the repo ships only placeholder examples.
- **Runtime logs** (`*.log`) are ignored.
- If a secret was ever pushed to public history, rotate it at the provider immediately.

---

## Third-party assets

- `apps/api/data/assets/yolov8n.pt`: Ultralytics YOLOv8n weights, licensed under
  [AGPL-3.0](https://github.com/ultralytics/ultralytics/blob/main/LICENSE).
- Weather: [Open-Meteo](https://open-meteo.com/) forecast and historical data, CC BY 4.0.
- Maps and routing: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
  (ODbL), tiles from [OpenFreeMap](https://openfreemap.org/), routes from the public
  [OSRM](https://project-osrm.org/) server.
- Satellite imagery in the legacy briefing table: Sentinel-2 cloudless 2016 by
  [EOX IT Services](https://s2maps.eu/), CC BY 4.0.
- Waste, weighbridge and fleet datasets: Satu Data Jakarta and data.go.id open data, as
  listed in `ml/data/real/manifest.json`.

---

## Team

Pythia. Public Jakarta waste data from DLH DKI Jakarta (SILIKA), SIPSN and the
Bantargebang weighbridge records; provenance in `ml/data/real/manifest.json`.
