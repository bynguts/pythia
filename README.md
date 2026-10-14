# Pythia

**See tomorrow's city waste today.** Pythia is an AI + immersive-media command
center for city waste agencies: it forecasts waste district by district, turns
the forecast into a fleet plan, and lets everyone *see* that plan — a 3D digital
twin for planners, live supervision for dispatchers, AR guidance for drivers and
an XR tabletop for leaders.

Startup entry for the **2026 Global Startup Competition** (Chung-Ang University —
College of Virtual Convergence & Center for eXtended Reality, COSS Immersive Media).
Piloted on Jakarta's public waste data; built to scale across Southeast Asia.

---

## Table of Contents

- [The Problem](#the-problem)
- [What Pythia Does](#what-pythia-does)
- [Who It's For](#who-its-for)
- [Solution Overview](#solution-overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Demo Accounts](#demo-accounts)
- [End-to-End Demo Flow](#end-to-end-demo-flow)
- [Testing](#testing)
- [Security & Credentials](#security--credentials)

---

## The Problem

City waste operations are **reactive**: a city learns how much waste there is
only after it has piled up, and the trucks, crews and landfill find out together.

- On 8 March 2026 part of **TPST Bantargebang**, the landfill that takes Jakarta's
  waste, slid after heavy rain *while trucks were queuing to unload*; at least
  five people were killed ([Asia News Network](https://asianews.network/deadly-landfill-collapse-exposes-jakartas-decades-long-waste-mismanagement/)).
- Jakarta produces roughly **7,400–8,700 tonnes of waste a day**, almost all of it
  trucked to that one site (SIPSN data via [RRI](https://rri.co.id/en/archipelago/2248964/jakarta-targets-rorotan-rdf-to-process-1000-tons-daily)).
- The same pattern repeats across Southeast Asia: Ho Chi Minh City's Da Phuoc
  landfill moved to night-only intake in December 2025 and backlogs followed
  ([Tuổi Trẻ](https://news.tuoitre.vn/ho-chi-minh-city-faces-waste-backlogs-as-landfill-restricts-daytime-operations-103251118145703962.htm)).

Rain, holidays and crowd events drive the spikes, so they can be predicted — but
nobody turns that prediction into an operational plan the whole team can see.

## What Pythia Does

| Step | What happens | Who sees it |
|---|---|---|
| **Forecast** | Prophet + XGBoost model per district (42 Jakarta kecamatan), weather- and event-aware | Planners |
| **Plan** | OR-Tools CP-SAT assigns trucks and crews; landfill arrivals are staggered to shorten queues | Planners, supervisors |
| **See** | **3D digital twin** of the city: district forecasts as columns, risk colours, trucks and landfill queue, scenario controls and a cinematic present mode | Planners, leaders |
| **Execute** | Live fleet supervision, route-deviation detection, A\* reroute, SPJ work orders, WhatsApp alerts | Dispatchers |
| **Guide** | **AR navigation** in the driver app; offline-safe work orders and evidence capture | Drivers, field crews |
| **Explain** | **XR tabletop** of the city (`/xr`, WebXR with an orbit fallback) | Leaders, stakeholders |
| **Audit** | Every number carries its provenance: real, modelled or simulated | Everyone |

AI decides *what* will happen; immersive media makes the plan *visible* to the
people who have to act on it.

## Who It's For

- **Customer:** city environment agencies (B2G) — starting with Jakarta, then other
  Indonesian metros, then Vietnam (a simulated Ho Chi Minh City demo city is
  already in the twin and the XR tabletop).
- **Users:** planners, dispatchers and supervisors, drivers and field crews, and
  city leaders.
- **Model:** software subscription for the agency, sized by fleet and districts;
  collection and landfill operators can run the same supervision stack.

> **Prototype honesty.** Fleet positions are simulated (not live GPS), the Ho Chi
> Minh City data is a labelled demo city, and forecasts are model outputs; the UI
> labels each of these. Accuracy figures live in the offline evaluation report
> (`ml/data/processed/hybrid_forecaster_evaluation.md`).

---

## Solution Overview

Pythia is one integrated product — from AI forecasting through immersive
planning to field execution:

| Layer | Stack | Purpose |
|---|---|---|
| **Immersive** | deck.gl · three.js · WebXR · device camera, GPS & compass | 3D digital twin, driver AR navigation, XR tabletop |
| **Command Center** | React + Vite · MapLibre GL · CSS variables | Interactive dashboards on a simulated fleet feed: fleet, routes, landfill queue, forecast per district |
| **AI / Backend** | Python FastAPI · OR-Tools CP-SAT · Prophet · XGBoost · A\* | Waste forecasting, route optimisation, staggered scheduling, RAG assistant |
| **Field Alerting** | Node.js Express · WhatsApp (Baileys) | Sends reroute instructions & alerts straight to drivers' phones |

Every workflow is an auditable loop — `detect → dispatch → acknowledge → confirmed` — suitable for follow-up by managers or the government.

---

## Key Features

### Immersive Layer
- **Pythia Twin** (`/twin`) — a 3D city model: one column per district (height =
  forecast tonnes per day, colour = spike against a normal day), TPS, landfill
  queue and fleet layers, a 7-day timeline you can play, rain and crowd-event
  scenarios that re-run the forecast, Jakarta or the simulated Ho Chi Minh City
  demo city, a cinematic tour and a full-screen present mode (`/?present=1`).
  Each layer shows its provenance (real, model output, simulated).
- **Driver AR navigation** (`/driver`) — camera view with a direction arrow to the
  next stop from phone GPS and compass, arrival detection and in-AR evidence
  photos; falls back to a compass view without a camera and states its ±10–30 m
  accuracy.
- **XR tabletop** (`/xr`, no login) — the city as a tabletop model for leaders and
  stakeholders; WebXR on capable devices, an orbit view everywhere else.

### Fleet Supervision
- **Live Fleet Map** (full-width) — simulated fleet positions with on-/off-corridor status (e.g. `T-047` off-corridor, highlighted amber). Positions are refreshed from the backend simulation, not live GPS; the map UI labels them "Data simulasi" / "SIMULATION · not live GPS".
- **A\* Reroute Simulator** — simulates a traffic jam, then computes a new street-following route for `T-047` to TPA Bantargebang dynamically.
- **TPA Queue & Staggered Dispatch** — predicted landfill queue (from the simulated fleet) with staggered dispatch slots.
- **WhatsApp Alerts** — dispatch reroute instructions via the Baileys gateway straight to driver WhatsApp.
- **Field App** (`/field`, no login) — driver view to confirm instructions; confirmations sync to the dashboard in real time.
- **Historical Trips & Reporting** — trip history and route evidence for officer/management follow-up.

### Forecasting & Planning
- **42-Subdistrict Forecast** — map/list of 42 Kecamatan; select one to expand a 3-column resource dashboard (predicted tonnage, fuel, carbon emissions, crew, fleet mix).
- **Operational AI Assistant (RAG)** — ask domain questions; answers retrieved from the custom knowledge base via an OpenAI-compatible gateway.
- **Integrated Planning** — constraint-aware weekly plan (OR-Tools CP-SAT) with an approve/deny flow.

### Data & ML Audit
- **Data provenance & model suitability** — every series is labelled observed, proxy or modelled in the dashboard; WAPE / MAE come from the offline evaluation report (`ml/data/processed/hybrid_forecaster_evaluation.md`).

---

## Architecture

Detailed notes: [`apps/api/knowledge/ARCHITECTURE.md`](apps/api/knowledge/ARCHITECTURE.md)
(data contracts, storage, receipts) and [`apps/api/knowledge/PRODUCT.md`](apps/api/knowledge/PRODUCT.md)
(users, product principles). The assistant answers from the same documents.

```text
┌───────────────────────────────────────────────────────────────┐
│ FRONTEND — React + Vite + MapLibre GL            (5175)       │
│                                                               │
│   Twin (deck.gl 3D)        Fleet · Forecast · Planning        │
│   Driver AR (/driver)      XR tabletop (/xr, three.js)        │
│   Field App (/field)       AI assistant · Data & ML Audit     │
└────────────────────────────┬──────────────────────────────────┘
                             │  HTTP / JSON
┌────────────────────────────▼──────────────────────────────────┐
│ BACKEND — Python FastAPI                          (8001)      │
│   • OR-Tools CP-SAT    · staggered dispatch & planning        │
│   • Prophet + XGBoost  · 42-Kecamatan waste forecast          │
│   • A* routing         · road-following reroute on jams       │
│   • RAG assistant      · domain Q&A via OpenAI gateway        │
└────────────────────────────┬──────────────────────────────────┘
                             │  HTTP / JSON
┌────────────────────────────▼──────────────────────────────────┐
│ WHATSAPP GATEWAY — Node.js + Baileys            (2785)        │
│   QR pairing → dispatch alerts & reroute instructions         │
└───────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```text
pythia/
├── .github/workflows/  # CI: API lint + tests, web lint + build + bundle budget
├── apps/
│   ├── api/            # FastAPI service
│   │   ├── app/        #   routers, forecasting, fleet/routing, field (SPJ), assistant (RAG)
│   │   ├── tests/      #   pytest, one folder per app area
│   │   ├── knowledge/  #   assistant knowledge base: ARCHITECTURE.md, PRODUCT.md, operator guides
│   │   └── data/       #   models/ (Prophet + XGBoost), assets/ (road cache, YOLO weights), media/ (optional local demo clip, not in the repo)
│   ├── web/            # React + Vite command center, field & driver PWAs, 3D twin, XR (src/, e2e/)
│   └── wa-gateway/     # WhatsApp gateway (Express + Baileys)
├── ml/                 # datasets + training scripts (see ml/README.md)
│   ├── data/           # real/ raw/ processed/ sources/ — provenance in real/manifest.json
│   └── scripts/        # reproducible training + data acquisition pipelines
├── deploy/             # docker compose: backend, frontend (nginx), wa-gateway; optional scentinel profile
├── scripts/            # dev.ps1 / dev.sh — run everything locally
└── .env.example        # environment template (copy to .env; never commit secrets)
```

---

## Getting Started

> Prerequisites: Python 3.12+, Node.js 20+, npm.

Copy the environment template once: `cp .env.example .env` (PowerShell:
`Copy-Item .env.example .env`). Every setting is optional for a local demo.

### One command

```powershell
.\scripts\dev.ps1 -Install      # Windows; add -WhatsApp for the gateway
./scripts/dev.sh --install        # Linux / macOS; add --whatsapp
```

It starts the API on **:8001**, the web app on **http://localhost:5175** and
opens the browser once the API is healthy (the first start warms the 42
forecast models, ~20–25 s).

### Each service by hand

```bash
# API (FastAPI) — the AI engine runs only when enabled
cd apps/api
pip install -r requirements.txt
PYTHIA_AI_ENGINE=on python -m uvicorn app.main:app --port 8001

# Web app (React + Vite)
cd apps/web
npm install
npm run dev -- --port 5175

# WhatsApp gateway (optional) — scan the QR code it prints
cd apps/wa-gateway
npm install
npm start          # listens on 127.0.0.1:2785; set HOST to bind elsewhere
```

Session files under `apps/wa-gateway/baileys_auth_info/` are created at runtime
and **never committed** (see Security below). Driver WhatsApp numbers go in
`apps/api/driver_contacts.json` (git-ignored; copy `driver_contacts.example.json`);
without it alerts go to `PYTHIA_WA_DEFAULT_CHAT_ID` / `PYTHIA_WA_DEFAULT_GROUP_ID`.

---

## Demo Accounts

| Role | Username | Password |
|---|---|---|
| Dispatcher (command center) | `dispatcher` | `dispatcher-demo-pass` |
| Supervisor (`/pengawas`, SPJ override) | `supervisor` | `supervisor-demo-pass` |

The field app (`/field`) and the driver PWA (`/driver`) open without a login.
Every role's password can be overridden with `PYTHIA_PW_<ROLE>`.

---

## End-to-End Demo Flow

1. **Sign in** with `dispatcher` on the dashboard.
2. **See the week ahead (Twin):** open `/twin`, play the 7-day forecast, raise rainfall or add a crowd event and watch the at-risk districts rise; switch to the Ho Chi Minh City demo city; start the cinematic tour.
3. **Plan it:** in **Forecast**, open a district's resource view (tonnage, fuel, emissions, crew, fleet mix); in **Planning**, review the constraints and approve the weekly staggered-dispatch plan. Ask the **AI assistant** a domain question for a RAG-grounded answer.
4. **Run the day (Fleet):** notice `T-047` off-corridor; click **A\* Simulate Jam** → watch it recompute a street-following route to TPA Bantargebang; inspect the landfill queue and staggered slots; click **Send Alert**; confirm the instruction in `/field` (no login) — the dashboard syncs instantly.
5. **Guide the driver (AR):** open `/driver` on a phone, pick a stop and tap **AR guide** for camera navigation and an in-AR arrival photo.
6. **Explain it (XR):** open `/xr` for the tabletop city model.
7. **Audit it:** in **Data & ML Audit**, review provenance, validation classes and model suitability; accuracy (WAPE / MAE) is in the offline evaluation report.

---

## Testing

```bash
cd apps/api && python -m pytest tests -q              # backend
cd apps/web && npm run build && npx playwright test --workers 1   # end-to-end
```

The end-to-end suite needs the API on :8001 and the built web app on :5175
(`npm run preview -- --port 5175`). The suite grows with every fixed issue, so
test counts are not tracked in this file — run the commands above, or check the
CI run attached to each commit/PR. Hygiene gate:
`node apps/web/e2e/lib/readme-hygiene.mjs` (fails if this README hardcodes a
stale count).

---

## Security & Credentials

The repository is **public** — handle sensitive material with care:

- **`.env` files are `gitignore`d and must never be committed.** Use `.env.example` as the template; values live only on the running machine.
- **WhatsApp session store** (`apps/wa-gateway/baileys_auth_info/`) contains real session credentials — it is ignored/untracked and regenerated on every QR scan.
- **Driver contacts** (`apps/api/driver_contacts.json`) hold real phone numbers — ignored/untracked; the repo ships only placeholder examples.
- **Runtime logs** (`*.log`) are ignored & untracked.
- ⚠️ **If a secret was ever pushed to public history, rotate it at the provider immediately.** History rewrites require force push and should be avoided in forked repos.

---

## Third-party assets

- `apps/api/data/assets/yolov8n.pt` — Ultralytics YOLOv8n weights, licensed under
  [AGPL-3.0](https://github.com/ultralytics/ultralytics/blob/main/LICENSE); used by
  the simulated gate-camera demo.

---

## Competition

- **2026 Global Startup Competition** — Chung-Ang University, College of Virtual
  Convergence & Center for eXtended Reality (COSS Immersive Media).
- **Pilot data:** public Jakarta waste data (DLH DKI Jakarta SILIKA, SIPSN, Bantargebang
  weighbridge records) — provenance in `ml/data/real/manifest.json`.
- **Team:** Pythia