# Pythia

**AI Command Center for Smart Waste Management** — solution built for the **AI Open Innovation Challenge 2026**, with the Jakarta Environmental Agency (DLH DKI Jakarta) as Case Provider.

Pythia is an end-to-end AI command center prototype that addresses **both cases** issued by DLH Jakarta in a single, integrated platform:

- **Case 1 — AI-Based Waste Transportation Monitoring & Supervision System:** fleet tracking (simulated positioning today; live GPS is planned once a reachable runtime path exists), violation detection, and route/schedule optimization.
- **Case 2 — Waste Volume Prediction System Based on Historical Data & Events**: predictive (not reactive) estimation of waste generation and required resources in crowded areas.

---

## Table of Contents

- [The Two Cases](#the-two-cases)
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

## The Two Cases

### Case 1 — AI-Based Waste Transportation Monitoring & Supervision System

**Background.** Waste collection activities in Jakarta face several challenges: unmonitored fleets, sub-optimal routes, and the presence of unlicensed collectors. Oversight today relies heavily on manual reports and reactive field inspections.

**Main challenge.** How can the entire waste collection process be carried out lawfully, transparently, and monitored in real time — while making the on-field work of officers easier?

**Scope & deliverables required by the case provider:**
- Live-tracking visuals overlaid on a base map.
- Transport scheduling optimized by estimated travel time, fleet condition, and landfill (TPA) queue status.
- Alternative-route recommendations that respect traffic regulations and permits.
- **Deliverables:** Model · Dashboard (live routes, fleet status, trip history, TPA queue view) · Simulator (scheduling, ETA, alternative routes) · Executive summary (optimized schedule, fewer landfill queues).

### Case 2 — Waste Volume Prediction System Based on Historical Data & Events

**Background case:** Waste volume spikes are common during the rainy season, major holidays, and special events — yet handling has always been **reactive**, waiting for the problem to appear instead of acting on measurable predictions.

**Expected outcome.** Shift waste management from reactive to **predictive**: estimate volume and location of waste **temporally and spatially**, and recommend fleet & facility readiness based on crowd-permit data.

**Scope & deliverables:**
- Estimation mapped temporally and spatially in each crowded area.
- Recommended facility needs (disposal & transport) per busy area, grounded on crowd-permit data.
- **Deliverables:** Dashboard (location/volume estimates, man–hour requirements) · Simulator (crowd location, waste generation, facility & fleet needs) · Executive summary (optimized facilities, operating hours, and collection schedules).

---

## Solution Overview

Pythia is one integrated command center covering both cases — from live operations through AI forecasting to actionable alerts:

| Layer | Stack | Purpose |
|---|---|---|
| **Command Center** | React + Vite · MapLibre GL · CSS variables | Interactive dashboards on a simulated fleet feed: fleet, routes, landfill queue, forecast per sub-district |
| **AI / Backend** | Python FastAPI · OR-Tools CP-SAT · Prophet · XGBoost · A\* | Route optimization, staggered scheduling, waste forecasting, RAG assistant |
| **Field Alerting** | Node.js Express · WhatsApp (Baileys) | Sends reroute instructions & alerts straight to officers' phones |

Every workflow is an auditable loop — `detect → dispatch → acknowledge → confirmed` — suitable for follow-up by managers or the government.

---

## Key Features

### Fleet Operations (Case 1)
- **Live Fleet Map** (full-width) — simulated fleet positions with on-/off-corridor status (e.g. `T-047` off-corridor, highlighted amber). Positions are refreshed from the backend simulation, not live GPS; the map UI labels them "Data simulasi" / "SIMULATION · not live GPS".
- **A\* Reroute Simulator** — simulates a traffic jam, then computes a new street-following route for `T-047` to TPA Bantargebang dynamically.
- **TPA Queue & Staggered Dispatch** — predicted landfill queue (from the simulated fleet) with staggered dispatch slots.
- **WhatsApp Alerts** — dispatch reroute instructions via the Baileys gateway straight to driver WhatsApp.
- **Field App** (`/field`, no login) — driver view to confirm instructions; confirmations sync to the dashboard in real time.
- **Historical Trips & Reporting** — trip history and route evidence for officer/management follow-up.

### Forecasting & AI (Case 2)
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
│   Fleet Ops                Waste Forecast / AI Ops            │
│   Field App (/field)       Planning · Data & ML Audit         │
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
│   │   └── data/       #   models/ (Prophet + XGBoost), assets/ (road cache, YOLO weights), media/ (demo clip)
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
2. **Fleet Operations (Case 1):** open the live fleet map and notice `T-047` off-corridor; click **A\* Simulate Jam** → watch it recompute a street-following route to TPA Bantargebang; inspect the TPA queue & staggered dispatch slots; click **Send Alert**; open `/field` in another tab (no login) and confirm the instruction — the dashboard syncs instantly.
3. **Waste Forecast & AI Assistant (Case 2):** browse the 42-Kecamatan list, select one, expand the resource-optimization view (tonnage, fuel, emission, crew, fleet mix), then ask the **Operational AI Assistant** a domain question and get a RAG-grounded answer.
4. **Integrated Planning:** review the constraints, then approve the next weekly staggered-dispatch plan.
5. **Data & ML Audit:** review data provenance, validation classes and model suitability; accuracy (WAPE / MAE) is in the offline evaluation report.

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

## Built For

- **Competition:** AI Open Innovation Challenge 2026 — [ai-open.president.ac.id](https://ai-open.president.ac.id)
- **Case Provider:** DLH DKI Jakarta
- **Team:** Pythia