# Pythia

**See tomorrow's city waste today.** Pythia is an AI + immersive-media command
center for city waste agencies: it forecasts waste district by district, turns
the forecast into a fleet plan, and lets everyone *see* that plan — a 3D digital
twin for planners, fleet supervision for dispatchers, AR guidance for drivers and
an XR tabletop for leaders.

Startup entry for the **2026 Global Startup Competition** (Chung-Ang University —
College of Virtual Convergence & Center for eXtended Reality, COSS Immersive Media).
Built and tested on Jakarta's public waste data (no live deployment or pilot yet);
designed to scale across Southeast Asia.

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
  waste, slid after heavy rain *while trucks were queuing to unload*; seven people
  were killed ([Katadata, Jun 2026](https://katadata.co.id/ekonomi-hijau/investasi-hijau/6a21b5bd1d019/bantargebang-dan-ujian-pengelolaan-sampah-jakarta)),
  one victim reportedly a truck driver queueing to unload ([NU Online](https://nu.or.id/nasional/diduga-sopir-truk-1-korban-longsor-sampah-bantargebang-kembali-ditemukan-qU5V9);
  identity unconfirmed at the time; see also [Asia News Network](https://asianews.network/deadly-landfill-collapse-exposes-jakartas-decades-long-waste-mismanagement/)).
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
| **Forecast** | Prophet + XGBoost model per district (42 Jakarta kecamatan) with weather and event drivers (planning assumptions the model reproduces, not effects learned from observed data), plus a monthly Bantargebang intake forecast backtested on real data | Planners |
| **Plan** | OR-Tools CP-SAT builds a daily plan of truck trips per shift for the top forecast districts on the simulated fleet; a seeded landfill-queue simulation (SIMULATED) shows how staggered arrivals shorten the queue | Planners, supervisors |
| **See** | **3D digital twin** of the city: district forecasts as extruded district outlines, risk colours, trucks and landfill queue, scenario controls, an Ask Pythia rail and a cinematic present mode | Planners, leaders |
| **Execute** | Fleet supervision on a simulated fleet feed, route-deviation detection, A\* reroute, SPJ work orders, a driver-safety guard (duty hours, gate wait), WhatsApp alerts through a prototype gateway | Dispatchers, supervisors |
| **Guide** | **AR navigation** in the driver app; offline-safe work orders and evidence capture | Drivers, field crews |
| **Explain** | **XR tabletop** of the city (`/xr`; AR on Android Chrome with ARCore, an orbit view and a lite mode on low-end phones) | Leaders, stakeholders |
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
> labels each of these. Only the monthly landfill-intake forecast is validated on real
> data (rolling-origin backtest against the strongest simple baseline, shown in the
> audit model card), and only 1–3 months ahead: its data run through April 2026, so
> horizons beyond 3 months are not backtested and the Forecast workspace badges each
> month inside or outside that horizon. Daily and per-district forecasts are
> calibrated-synthetic and carry no accuracy claim. Details:
> `ml/data/processed/hybrid_forecaster_evaluation.md`.

---

## Solution Overview

Pythia is one integrated product — from AI forecasting through immersive
planning to field execution:

| Layer | Stack | Purpose |
|---|---|---|
| **Immersive** | deck.gl · three.js · WebXR · device camera, GPS & compass | 3D digital twin, driver AR navigation, XR tabletop |
| **Command Center** | React + Vite · MapLibre GL · CSS variables | Interactive dashboards on a simulated fleet feed: fleet, routes, landfill queue, forecast per district |
| **AI / Backend** | Python FastAPI · OR-Tools CP-SAT · Prophet · XGBoost · A\* | Waste forecasting, route optimisation, staggered scheduling, RAG assistant |
| **Field Alerting** | Node.js Express · WhatsApp (Baileys) | Prototype gateway for reroute instructions and safety alerts; Baileys is an unofficial WhatsApp Web client, so a pilot would move to the WhatsApp Business Platform |

Every workflow is an auditable loop — `detect → dispatch → acknowledge → confirmed` — suitable for follow-up by managers or the government.

---

## Key Features

### Immersive Layer
- **Pythia Twin** (`/twin`) — a 3D city model: each district is its real kecamatan
  outline (pararawendy/border-indonesia-geojson, 2020, dissolved from 267 kelurahan)
  extruded by forecast tonnes per day, coloured by spike against a normal day; TPS, landfill
  queue and fleet layers, a 7-day timeline you can play, rain and crowd-event
  scenarios that re-run the forecast, Jakarta or the simulated Ho Chi Minh City
  demo city, a cinematic tour and a full-screen present mode (`/?present=1`).
  Each layer shows its provenance (real, model output, simulated).
- **Ask Pythia** — a tool-using agent on the twin and on the XR table. A what-if
  question ("what if 80 mm of rain hits during the JIS concert tomorrow?") becomes
  scenario arguments (an LLM tool call when an OpenAI-compatible key is configured,
  otherwise a deterministic local parser), runs the read-only `run_scenario` tool (the
  same forecast as the twin) and answers with the trace of every step it ran and its
  source class. It recommends; it never dispatches or approves anything. On `/xr` it
  needs no login and always uses the local parser; repeated questions are answered
  from a short cache.
- **Twin → table handoff** — **Put on the table** shows a QR code, a link and a
  session code that open `/xr` already joined to the twin's shared table session
  (scenario, pointed-at district, who is present). Built, not yet device-tested.
- **Driver AR navigation** (`/driver`) — built for the budget Android phones crews
  carry: on Android Chrome with ARCore (WebXR `immersive-ar`), a world-fixed street
  path of ground chevrons toward the next stop (phone GPS + compass, never
  lane-level, with an "align to street" nudge); elsewhere a camera view with a
  direction arrow. Arrival detection and in-AR evidence photos; falls back to a
  compass view without a camera and states its ±10–30 m accuracy. Not yet tested
  on a physical device.
- **XR tabletop** (`/xr`, no login) — the city as a tabletop model for leaders and
  stakeholders. On Android Chrome with ARCore the model is placed on a real table;
  everywhere else an orbit view. A lite mode (switched on automatically for
  low-memory or low-core phones and data saver, or by hand) trims outlines,
  particles and resolution for low-end devices.

### Fleet Supervision
- **Fleet Map** (full-width) — simulated fleet positions with on-/off-corridor status (e.g. `T-047` off-corridor, highlighted amber). Positions are refreshed from the backend simulation, not live GPS; the map UI labels them "Data simulasi" / "SIMULATION · not live GPS".
- **A\* Reroute Simulator** — simulates a traffic jam, then computes a new street-following route for `T-047` to TPA Bantargebang dynamically.
- **TPA Queue & Staggered Dispatch** — seeded landfill-queue simulation (real median daily truck count from Bantargebang weighbridge data, stated weighbridge and departure-spread assumptions; labelled SIMULATED) with 15-minute staggered dispatch slots and a baseline band across departure spreads. On the normal day (1,228 trucks/day, the median of the latest 12 months of weighbridge records) the simulated wait falls from 57.1 to 5.6 minutes per truck; the current-practice baseline spans 35.2–65.9 minutes across 10–60-minute departure spreads. These are simulation outputs, not field measurements.
- **Driver-safety guard** — per truck, the duty time since the first pre-trip check or SPJ activation of the local (WIB) day: a warning at 600 min (10 h), and from 720 min (12 h) a new SPJ cannot be created or activated until a supervisor records an override with a reason. Every override, and every SPJ start it allows, is written to the audit history with the signed-in username. The gate wait runs from the driver's gate-arrival tap to the weighbridge receipt; at 180 min (DLH's 3-hour gate-wait promise) one alert per wait is stored and, when a supervisor WhatsApp group is configured, sent to that group. A background timer checks every 60 s, so the alert does not depend on an open panel. The numbers are classified `OBSERVED_APP_EVENTS` (pre-trip, SPJ, gate-arrival and receipt events recorded on this server); a server with no such events today shows a seeded scenario labelled SIMULATED, which never blocks an SPJ or sends an alert. Thresholds live in `app/core/units.py`. Shown in Fleet, `/pengawas` and the driver PWA.
- **WhatsApp Alerts** — reroute instructions through the prototype Baileys gateway (an unofficial WhatsApp Web client) to the numbers in the git-ignored `driver_contacts.json`, or to the default chat; a pilot would use the WhatsApp Business Platform.
- **Field App** (`/field`, driver sign-in) — driver view to confirm instructions; confirmations reach the dashboard within seconds (it polls every 8 s).
- **Trip history & audit** — trip history reconstructed from the simulated corridor model (not archived GPS telemetry), and the per-SPJ audit trail of who did what.

### Forecasting & Planning
- **42-Subdistrict Forecast** — map/list of 42 Kecamatan; select one to expand a 3-column resource dashboard (predicted tonnage, fuel, carbon emissions, crew, fleet mix).
- **Bantargebang intake strip** — the monthly landfill-intake forecast (the one model backtested on real data) for the current month onward, each month badged inside or outside the backtested 1–3-month horizon. In the rolling-origin backtest (66 forecasts from 23 origins, 2024-06 to 2026-04, 1–3 months ahead) its error (MAE) is 13.4% lower than the strongest simple baseline, a 12-month moving average (90% CI 4.3–22.9%, cluster bootstrap over target months). The gain comes from the Ramadan/Lebaran months; in other months the two are about equal (0.3%). Source: `apps/api/data/models/forecast_evaluation.json`.
- **Operational AI Assistant (RAG)** — ask domain questions; answers retrieved from the custom knowledge base via an OpenAI-compatible gateway, or labelled local answers from read-only tools when no key is configured.
- **Daily plan (Rencana harian)** — OR-Tools CP-SAT assigns 18 t truck trips per shift and disposal facility for the top 5 forecast districts (adjustable) on the simulated fleet. Kecamatan rit quotas, the Bantargebang gate caps, the RDF Rorotan intake and acceptance rules and per-truck trip limits are hard constraints, read from a dated example rules file (`ml/data/config/operations_rules.json`, classified `EXAMPLE_CONFIG`: news reports and stated assumptions, each with its source, to be confirmed with DLH; only one kecamatan has an example quota). Demand those limits cannot serve is shown as unassigned tonnes, not hidden. A supervisor approves the plan, which creates the per-truck dispatch instructions.

### Data & ML Audit
- **Data provenance & model suitability** — every series is labelled observed, proxy or modelled in the dashboard. A model card shows the monthly landfill-intake forecast's error against the strongest simple baseline on real Bantargebang data (rolling-origin backtest, numbers read from the training pipeline's `forecast_evaluation.json`); daily and per-district resolutions are labelled calibrated-synthetic with no accuracy claim.

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

The gateway itself has **no authentication** and is meant to stay on localhost (or a
private docker network): never publish port 2785. Operators reach its pairing QR and
group list only through the API (`/api/whatsapp/qr`, `/api/whatsapp/groups`), which
require an administrator login.

Session files under `apps/wa-gateway/baileys_auth_info/` are created at runtime
and **never committed** (see Security below). Driver WhatsApp numbers go in
`apps/api/driver_contacts.json` (git-ignored; copy `driver_contacts.example.json`);
without it alerts go to `PYTHIA_WA_DEFAULT_CHAT_ID` / `PYTHIA_WA_DEFAULT_GROUP_ID`.
Its `drivers` keys must be the simulated fleet's driver names (`Pengemudi Sim 01`,
`Pengemudi Sim 02`, …); an alert for a name with no entry goes to the default chat and
the API logs the unmatched name once.

---

## Demo Accounts

| Role | Username | Password |
|---|---|---|
| Dispatcher (command center) | `dispatcher` | `dispatcher-demo-pass` |
| Supervisor (`/pengawas`, plan approval, SPJ and duty overrides) | `supervisor` | `supervisor-demo-pass` |
| Driver (`/field`, `/driver`) | `driver` | `driver-demo-pass` |

The field app (`/field`) and the driver PWA (`/driver`) show the driver sign-in in place
before any write; `/xr` opens without a login. Every role's password can be overridden
with `PYTHIA_PW_<ROLE>`. The shared `driver` account is a demo account that may act for
any truck; personal accounts from `PYTHIA_USERS_FILE` (template
`apps/api/users.example.json`) bind each driver to one truck, and the API refuses that
driver's requests for another truck.

---

## End-to-End Demo Flow

1. **Sign in** with `dispatcher` on the dashboard.
2. **See the week ahead (Twin):** open `/twin`, play the 7-day forecast, raise rainfall or add a crowd event and watch the at-risk districts rise; ask **Ask Pythia** a what-if and open its trace; switch to the Ho Chi Minh City demo city; start the cinematic tour.
3. **Plan it:** in **Forecast**, open a district's resource view (tonnage, fuel, emissions, crew, fleet mix); in **Planning**, review the rules in force and build the daily plan (truck trips per shift); a `supervisor` approves it. Ask the **AI assistant** a domain question for a RAG-grounded answer.
4. **Run the day (Fleet):** notice `T-047` off-corridor; click **A\* Simulate Jam** → watch it recompute a street-following route to TPA Bantargebang; inspect the landfill queue and staggered slots; click **Send Alert**; confirm the instruction in `/field` (sign in as `driver`) — the dashboard picks it up within seconds.
5. **Guide the driver (AR):** open `/driver` on a phone, pick a stop and tap **AR guide** for camera navigation and an in-AR arrival photo.
6. **Explain it (XR):** from the twin, use **Put on the table** to open `/xr` on a phone in the same session (or open `/xr` directly) for the tabletop city model.
7. **Audit it:** in **Data & ML Audit**, review provenance, validation classes, model suitability and the model card (monthly forecast vs the strongest simple baseline on real data).

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
- **Data:** public Jakarta waste data (DLH DKI Jakarta SILIKA, SIPSN, Bantargebang
  weighbridge records) — provenance in `ml/data/real/manifest.json`.
- **Team:** Pythia