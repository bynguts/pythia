# Pythia

**Waste operations, decided before dawn.** Pythia is the operations console for city
waste fleets. It forecasts tomorrow's waste for every district, plans the trucks and
crews to carry it, gives each truck a landfill gate slot, and follows the day through
to the weighbridge receipt. The dispatcher works in one console; drivers work in a
phone app built for budget Android handsets.

Startup entry for the **2026 Global Startup Competition** (Chung-Ang University,
College of Virtual Convergence & Center for eXtended Reality, COSS Immersive Media).
Built and tested on Jakarta's public waste data. There is no live deployment or pilot yet.

---

## Table of Contents

- [The Problem](#the-problem)
- [What Pythia Does](#what-pythia-does)
- [Who It's For](#who-its-for)
- [The Product](#the-product)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Demo Accounts](#demo-accounts)
- [End-to-End Demo Flow](#end-to-end-demo-flow)
- [Testing](#testing)
- [Security & Credentials](#security--credentials)

---

## The Problem

City waste operations are **reactive**. A city learns how much waste there is only
after it has piled up, and the trucks, the crews and the landfill all find out at
the same moment, at the gate.

- On 8 March 2026 part of **TPST Bantargebang**, the landfill that takes Jakarta's
  waste, slid after heavy rain *while trucks were queuing to unload*. Seven people
  were killed ([Katadata, Jun 2026](https://katadata.co.id/ekonomi-hijau/investasi-hijau/6a21b5bd1d019/bantargebang-dan-ujian-pengelolaan-sampah-jakarta)).
  One victim was reportedly a truck driver queueing to unload ([NU Online](https://nu.or.id/nasional/diduga-sopir-truk-1-korban-longsor-sampah-bantargebang-kembali-ditemukan-qU5V9);
  identity unconfirmed at the time; see also [Asia News Network](https://asianews.network/deadly-landfill-collapse-exposes-jakartas-decades-long-waste-mismanagement/)).
- Jakarta produces roughly **7,400–8,700 tonnes of waste a day**, almost all of it
  trucked to that one site (SIPSN data via [RRI](https://rri.co.id/en/archipelago/2248964/jakarta-targets-rorotan-rdf-to-process-1000-tons-daily)).
  On a median day about 1,228 trucks pass its weighbridge (Bantargebang weighing
  records, latest 12 months).
- The same pattern repeats across Southeast Asia. In December 2025 Ho Chi Minh City's
  Da Phuoc landfill moved to night-only intake, and backlogs followed
  ([Tuổi Trẻ](https://news.tuoitre.vn/ho-chi-minh-city-faces-waste-backlogs-as-landfill-restricts-daytime-operations-103251118145703962.htm)).

Rain, holidays and crowd events drive the spikes, so they can be predicted. What is
missing is a plan made from that prediction: which trucks leave when, which gate slot
each one takes, and who acts when something goes wrong.

## What Pythia Does

| Step | What happens | Where |
|---|---|---|
| **Forecast** | Tomorrow's tonnes per district (42 Jakarta kecamatan) and a 7-day city outlook. The drivers fill themselves in: Open-Meteo weather, the official event calendar, holidays and the weekday. No sliders. | Tomorrow |
| **Plan** | OR-Tools CP-SAT turns the forecast into truck trips per shift within the gate caps and trip limits. A supervisor approves it in the same console. | Tomorrow |
| **Instruct** | Approval creates a draft work order (SPJ) per truck, with real SILIKA TPS stops and a 15-minute Bantargebang gate slot (at most 30 trucks per slot). Each driver gets the plan on the phone. | Work orders, driver app |
| **Run the day** | Morning readiness per truck (pre-trip check, duty hours, instruction acknowledged, SPJ, damage), a map-first operations view, route-deviation checks, the gate queue and WhatsApp alerts. | Operations, Readiness, Gate |
| **Close the day** | A recap of actual against forecast from weighbridge receipts and trips, gate waits and incidents. Unknown figures stay empty. | Reports |
| **Learn** | After 3 or more weighed days, the next forecast is corrected by the observed actual-to-forecast ratio, an exponentially weighted average capped at ±25%. | Tomorrow |
| **Ask** | Ana, an assistant with read-only tools, answers "how many tonnes tomorrow?" or "which trucks are not ready?". It recommends; it never dispatches or approves. | Every console page |

Every number carries its source: observed, model output or simulated.

## Who It's For

- **Customer:** city environment agencies (B2G). Jakarta first, then other Indonesian
  metros, then the rest of Southeast Asia. Collection and landfill operators can run
  the same stack.
- **Users:** dispatchers (the console), supervisors (approval inside the same console),
  drivers (the phone app). Administrators manage accounts and WhatsApp.
- **Model:** a software subscription per agency, sized by fleet.

> **Prototype honesty.** Fleet positions are simulated, not live GPS, and the console
> says so ("Live GPS · Coming soon"). Forecasts are model outputs and are tagged
> as such. Gate waits come from a seeded queue simulation, because the weighing
> records hold no waiting times. Only the monthly landfill-intake forecast is validated
> on real data, and only 1–3 months ahead: its data run through April 2026. Daily and
> per-district forecasts are calibrated-synthetic and carry no accuracy claim.
> Details: `ml/data/processed/hybrid_forecaster_evaluation.md`.

---

## The Product

### Dispatcher console (`/app`)

| Page | What the dispatcher does there |
|---|---|
| **Operations** (`/app/operations`) | Map-first view of the day. "Needs you" lists what waits on a person: an instruction not acknowledged, a truck off its corridor, a duty-hour warning or a long gate wait. Send a **New instruction** to one truck (it lands in that driver's app) or **Message drivers** (free text to the WhatsApp alert group). The bell shows the same open items from any page. |
| **Readiness** (`/app/readiness`) | Per truck before departure: pre-trip check, duty state, instruction acknowledged, SPJ status, open damage reports. Activate today's work orders from here. |
| **Gate** (`/app/gate`) | Bantargebang gate slots: 15-minute slots of at most 30 trucks, the queue ahead and the gate-wait alert at 180 min (DLH's 3-hour promise). |
| **Work orders** (`/app/work-orders`) | SPJ list and detail: stops, route, gate slot, driver-entered weights against the receipt photo, and the audit trail. An SPJ dated tomorrow can't be activated before its day. |
| **Tomorrow** (`/app/tomorrow`) | Tomorrow's forecast and why (weather, events, holidays), the 7-day outlook, the monthly intake backtest, the plan and its approval. |
| **Fleet** (`/app/fleet`) | Trucks, drivers and service history. |
| **Reports** (`/app/reports`) | The close-of-day recap: actual against forecast, gate waits and incidents. |
| **Settings** (`/app/settings`) | Team accounts, data sources and labels, the model card, and WhatsApp pairing. A dispatcher can scan the gateway's QR here; no terminal is needed. |

### Driver app (`/driver`)

A phone app for budget Android handsets, usable offline.

- **Instructions:** the approved plan as trips in the UI language ("Tomorrow's instruction" for a plan dated tomorrow); accept with one tap.
- **Route:** stops in order, then **Go to TPA** with the gate slot and the arrival time counted from the departure.
- **Gate:** "I am at the disposal gate" starts the gate-wait clock.
- **Weigh ticket:** a photo of the receipt, read on the phone (OCR) and confirmed by the driver.
- **Pre-trip check and damage reports** with photos.
- **Offline:** every write waits in an outbox and is sent once with an operation id when the signal returns.

### Driver-safety guard

Duty time per truck runs from the first pre-trip check or SPJ activation of the local
(WIB) day:

- At 600 min (10 h) the console shows a warning.
- From 720 min (12 h) no new SPJ can be created or activated until a supervisor
  records an override with a reason. Every override is written to the audit history.
- The gate wait runs from the driver's gate-arrival tap to the weighbridge receipt. At
  180 min (DLH's 3-hour gate-wait promise) one alert per wait is stored and sent to the
  supervisor WhatsApp group when one is configured.

The numbers are classified `OBSERVED_APP_EVENTS` (pre-trip, SPJ, gate-arrival and receipt
events recorded on this server). A server with no such events today shows a seeded
scenario labelled SIMULATED, which never blocks an SPJ or sends an alert. The thresholds
live in `app/core/units.py`.

### Paperless SPJ and sealed weigh tickets

- **Ticket OCR:** the driver photographs the weighbridge ticket and a vision model reads
  gross, tare, net, ticket number, plate, weighing times and site, or says the photo is
  not a ticket. The reading is labelled MODEL OUTPUT and prefills the form; it becomes a
  recorded weight only when the driver or a reviewer confirms it.
- **Seal:** every SPJ audit entry carries the SHA-256 of the previous one (canonical JSON),
  and the receipt stores the photo's digest. `GET /api/spj/{id}/integrity` re-verifies the
  chain, and the console shows "Sealed" or "Seal broken".
- **Cross-checks** (rules, not AI): gross − tare = net on the ticket, net within the 18 t
  truck capacity, OCR against the recorded gross, duplicate ticket numbers or photos, the
  ticket plate against the SPJ truck. A failed check becomes a Needs-you item with a next
  step and the rule it cites.

### Briefing room (`/twin`, `/xr`)

A 3D twin of the district forecast and an XR tabletop (`/xr`, AR on Android Chrome with
ARCore, an orbit view elsewhere) for briefing leaders. They are not part of the daily
workflow and are not linked from the console.

### Data and models

- **Daily forecast:** Prophet plus an XGBoost residual (11 features) per district,
  with an event overlay. If a model fails to load, the forecast falls back to a heuristic
  and labels it as one.
- **Monthly Bantargebang intake:** rolling-origin backtest, 66 forecasts from 23 origins,
  2024-06 to 2026-04, 1–3 months ahead. Its error (MAE) is 13.4% lower than the strongest
  simple baseline, a 12-month moving average (90% CI 4.3–22.9%). Almost all of the gain
  comes from the Ramadan and Lebaran months; in other months the two are about equal (0.3%).
  Source: `apps/api/data/models/forecast_evaluation.json`.
- **Gate queue:** a seeded simulation using the real median daily truck count and stated
  weighbridge and departure-spread assumptions. With staggered departures the simulated
  wait on a normal day falls from 57.1 to 5.6 minutes per truck. Current practice spans
  35.2–65.9 minutes across 10–60-minute departure spreads. These are simulation outputs,
  not field measurements. `ml/scripts/calibrate_queue.py` reproduces the arrival input.
- **ETA:** an OSRM routing duration, or a labelled fallback estimate. It is not an AI
  prediction.
- **Value per 1,000 gate trips** (Reports): truck-hours, driver duty hours and idle diesel
  without and with staggered slots, in low, base and high cases. The waits come from the
  queue simulation (SIMULATED); every other input is a labelled assumption with its range.
- **Rules:** the daily plan (Rencana harian) is built with OR-Tools CP-SAT. Gate caps,
  RDF Rorotan intake and per-truck trip limits come from a dated
  example rules file (`ml/data/config/operations_rules.json`, classified `EXAMPLE_CONFIG`,
  each rule with its source, to be confirmed with DLH).

### WhatsApp

Alerts go through a prototype Baileys gateway. Baileys is an unofficial WhatsApp Web
client; a government pilot would use the WhatsApp Business Platform.

---

## Architecture

Detailed notes: [`apps/api/knowledge/ARCHITECTURE.md`](apps/api/knowledge/ARCHITECTURE.md)
(data contracts, storage, receipts) and [`apps/api/knowledge/PRODUCT.md`](apps/api/knowledge/PRODUCT.md)
(users, product principles). Ana answers from the same documents.

```text
┌───────────────────────────────────────────────────────────────┐
│ FRONTEND (React + Vite + MapLibre GL)            (5175)       │
│   Landing (/)       Dispatcher console (/app/:page)           │
│   Driver app (/driver, offline outbox)                        │
│   Briefing room: twin (/twin, deck.gl) · XR table (/xr)       │
└────────────────────────────┬──────────────────────────────────┘
                             │  HTTP / JSON
┌────────────────────────────▼──────────────────────────────────┐
│ BACKEND (Python FastAPI)                          (8001)      │
│   • Prophet + XGBoost  · 42-district forecast, 7-day outlook  │
│   • learning loop      · actual vs forecast correction        │
│   • OR-Tools CP-SAT    · daily plan within gate caps          │
│   • plan → SPJ         · per-truck work orders + gate slots   │
│   • OSRM / A* routing  · routes, ETA, deviation checks        │
│   • Ana                · assistant with read-only tools       │
└────────────────────────────┬──────────────────────────────────┘
                             │  HTTP / JSON
┌────────────────────────────▼──────────────────────────────────┐
│ WHATSAPP GATEWAY (Node.js + Baileys)            (2785)        │
│   QR pairing from Settings → alerts & driver messages         │
└───────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```text
pythia/
├── .github/workflows/  # CI: API lint + tests, web lint + build + bundle budget
├── apps/
│   ├── api/            # FastAPI service
│   │   ├── app/        #   routers, forecasting, fleet/routing, field (SPJ), assistant, AI engine
│   │   ├── tests/      #   pytest, one folder per app area
│   │   ├── knowledge/  #   assistant knowledge base: ARCHITECTURE.md, PRODUCT.md, operator guides
│   │   └── data/       #   models/ (Prophet + XGBoost), assets/ (road cache, YOLO weights)
│   ├── web/            # React + Vite: landing, console, driver app, twin, XR (src/, e2e/)
│   └── wa-gateway/     # WhatsApp gateway (Express + Baileys)
├── ml/                 # datasets + training scripts (see ml/README.md)
│   ├── data/           # real/ raw/ processed/ sources/, provenance in real/manifest.json
│   └── scripts/        # reproducible training + data acquisition pipelines
├── deploy/             # docker compose: backend, frontend (nginx), wa-gateway
├── scripts/            # dev.ps1 / dev.sh, run everything locally
└── .env.example        # environment template (copy to .env; never commit secrets)
```

---

## Getting Started

> Prerequisites: Python 3.12+, Node.js 20+, npm.

Copy the environment template once: `cp .env.example .env` (PowerShell:
`Copy-Item .env.example .env`). Every setting is optional for a local demo. Set
`OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL`, `OPENAI_MODEL`) for an
OpenAI-compatible model behind Ana. Without a key, Ana answers locally from the same
read-only tools and says so.

### One command

```powershell
.\scripts\dev.ps1 -Install      # Windows; add -WhatsApp for the gateway
./scripts/dev.sh --install        # Linux / macOS; add --whatsapp
```

This starts the API on **:8001** and the web app on **http://localhost:5175**, then
opens the browser once the API is healthy. The first start warms the 42 forecast
models (~20–25 s).

### Each service by hand

```bash
# API (FastAPI). The AI engine runs only when enabled.
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

The gateway itself has **no authentication** and is meant to stay on localhost (or a
private docker network): never publish port 2785. The console reaches its pairing QR and
group list only through the API, which requires a dispatcher or administrator login. Driver contacts stay administrator-only.

Session files under `apps/wa-gateway/baileys_auth_info/` are created at runtime
and **never committed** (see Security below). Driver WhatsApp numbers go in
`apps/api/driver_contacts.json` (git-ignored; copy `driver_contacts.example.json`).
Without it, alerts go to `PYTHIA_WA_DEFAULT_CHAT_ID` / `PYTHIA_WA_DEFAULT_GROUP_ID`.

---

## Demo Accounts

| Role | Username | Password |
|---|---|---|
| Dispatcher (console) | `dispatcher` | `dispatcher-demo-pass` |
| Supervisor (plan approval, SPJ and duty overrides) | `supervisor` | `supervisor-demo-pass` |
| Driver (`/driver`) | `driver` | `driver-demo-pass` |
| Administrator (accounts, contacts, WhatsApp) | `administrator` | `administrator-demo-pass` |

Every role's password can be overridden with `PYTHIA_PW_<ROLE>`. The shared `driver`
account may act for any truck. Personal accounts from `PYTHIA_USERS_FILE` (template
`apps/api/users.example.json`) bind each driver to one truck, and the API refuses that
driver's requests for another truck. `/xr` opens without a login.

---

## End-to-End Demo Flow

1. **Tomorrow:** sign in as `dispatcher` and open **Tomorrow**. Read the forecast and its
   reasons (weather, events, holidays) and the 7-day outlook, then build the plan.
2. **Approve:** sign in as `supervisor` and approve the plan. Draft SPJs appear in
   **Work orders**, one per truck, each with TPS stops and a gate slot.
3. **Driver:** open `/driver` on a phone as `driver`, pick the truck and accept
   "Tomorrow's instruction". Then do the pre-trip check.
4. **Morning:** in **Readiness**, see which trucks are ready and activate today's work
   orders. Then go to **Operations**, which shows what needs you, and send an
   instruction or a WhatsApp message.
5. **Gate:** the driver taps "I am at the disposal gate" and photographs the weigh
   ticket. **Gate** shows the slot and the wait; **Work orders** shows the receipt to
   check.
6. **Close:** **Reports** shows actual against forecast for the day, and the next
   forecast learns from it.
7. **Ask:** ask Ana "how many tonnes tomorrow?" or "which trucks are not ready?".

---

## Testing

```bash
cd apps/api && python -m pytest tests -q              # backend
cd apps/web && npm run build && npx playwright test --workers 1   # end-to-end
```

The end-to-end suite needs the API on :8001 and the built web app on :5175
(`npm run preview -- --port 5175`). The suite grows with every fixed issue, so test
counts are not tracked in this file. Run the commands above, or check the CI run
attached to each commit or PR. Hygiene gate: `node apps/web/e2e/lib/readme-hygiene.mjs`
fails if this README hardcodes a stale count.

---

## Security & Credentials

The repository is **public**, so handle sensitive material with care:

- **`.env` files are `gitignore`d and must never be committed.** Use `.env.example` as the template; values live only on the running machine.
- **WhatsApp session store** (`apps/wa-gateway/baileys_auth_info/`) contains real session credentials. It is ignored and untracked, and it is regenerated on every QR scan.
- **Driver contacts** (`apps/api/driver_contacts.json`) hold real phone numbers. The file is ignored and untracked; the repo ships only placeholder examples.
- **Runtime logs** (`*.log`) are ignored and untracked.
- ⚠️ **If a secret was ever pushed to public history, rotate it at the provider immediately.** History rewrites require a force push and should be avoided in forked repos.

---

## Third-party assets

- `apps/api/data/assets/yolov8n.pt`: Ultralytics YOLOv8n weights, licensed under
  [AGPL-3.0](https://github.com/ultralytics/ultralytics/blob/main/LICENSE).

---

## Competition

- **2026 Global Startup Competition**, Chung-Ang University, College of Virtual
  Convergence & Center for eXtended Reality (COSS Immersive Media).
- **Data:** public Jakarta waste data (DLH DKI Jakarta SILIKA, SIPSN, Bantargebang
  weighbridge records). Provenance is in `ml/data/real/manifest.json`.
- **Team:** Pythia
