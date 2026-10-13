# Pythia × 2026 Global Startup Competition — master plan

Goal: **Grand Prize**. Submission = slide deck (PPT/PDF) + presentation video,
judged online on Problem Recognition, Solution, Growth Strategy, Presentation
(2025 criteria). Deadline **2026-10-28 23:59 KST**. Evidence: `RESEARCH.md`.

## Winning thesis

> **Pythia is the oracle for city waste: it forecasts tomorrow's waste by
> district, then lets planners *see* it in an immersive 3D twin and guides
> field crews with AR — before the landfill queue becomes a disaster.**

1. **Problem Recognition** — Bantargebang collapse (Mar 2026) happened while
   trucks queued; Jakarta 7.4–8.7k t/day; same pattern in HCMC (Da Phuoc
   night-only intake) and Hanoi. Reactive operations kill people and money.
2. **Solution** — the only stack combining (a) event/weather-driven district
   forecasts, (b) live route supervision + landfill-queue staggering, (c) an
   **immersive layer**: 3D digital twin for planners, AR for crews, XR
   tabletop for leaders. Built on real Jakarta government data, honest about
   what is modelled vs simulated.
3. **Growth Strategy** — Jakarta pilot → Indonesian cities via World Bank
   $350M LSDI programme → Vietnam (HCMC/Hanoi) via Korea's K-City Network
   demonstration grants → per-truck SaaS. Korea is both judge and channel.
4. **Presentation** — cinematic video built on real product footage; deck that
   reads like an early-stage startup (market, model, traction, team, ask).

## Workstreams

Status: ☐ todo · ◐ in progress · ☑ done (with evidence)

### WS-A · Pythia Twin (3D digital twin) — highest priority
- ☐ Backend `GET /api/twin/scene?city=&days=&rain_mm=&attendance=`: districts
  with centroid + daily forecast series (tonnes, p10/p90, risk), facilities
  (TPA, TPS), trucks snapshot, `provenance` per layer.
- ☐ New workspace **Twin** (nav first for demo): MapLibre pitched 3D buildings
  (OpenFreeMap liberty) + deck.gl overlay — extruded district columns (height =
  forecast t/day, colour = risk), animated truck trips, TPS→TPA flow arcs,
  landfill queue beacon.
- ☐ Time scrubber (next 7 days) + scenario controls (rain, crowd event) that
  re-forecast and animate columns.
- ☐ "Cinematic tour" (scripted camera path) for the video; deterministic
  automation mode for e2e.
- ☐ Provenance chips on every layer (MODEL OUTPUT / SIMULATED / REAL).
- Done when: e2e asserts the scene renders all 42 districts + scenario changes
  heights; bundle budget updated and passing; tour runs end-to-end.

### WS-B · Pythia AR (field crews) + XR tabletop
- ☐ Driver app **AR navigation**: camera view (getUserMedia) + GPS + compass
  arrow and distance to the next SPJ stop; arrival triggers evidence capture
  from the AR frame (feeds the existing stop-evidence flow).
- ☐ Works on Android + iOS (DeviceOrientation permission), graceful fallback
  to 2D compass when camera/sensors are unavailable; Indonesian/English copy.
- ☐ **XR tabletop twin**: WebXR `immersive-ar` hit-test places the city twin
  (district columns) on a table; three.js orbit view where WebXR is missing.
- Done when: e2e with fake camera + mocked geolocation/orientation passes;
  manual phone test checklist recorded.

### WS-C · Backend reliability (demo must not break)
- ☐ Fix SPJ normal completion 500 (`override["actor"]` on None).
- ☐ Fix dispatch confirm KeyError → 404 with `operation_id`.
- ☐ Field outbox sends `operation_id` (exactly-once replays).
- ☐ `python-dotenv` in requirements.
- Done when: regression tests added and full pytest green.

### WS-D · Second city (SEA expansion proof)
- ☐ City registry: Jakarta (real data) + **Ho Chi Minh City demo**
  (districts with public population; volumes modelled from per-capita rate,
  labelled SIMULATED DEMO CITY). Twin city switcher.
- Done when: switching city re-renders twin with honest provenance.

### WS-E · Stack & quality
- ☐ GitHub Actions CI: backend pytest, frontend build + budget + hygiene.
- ☐ Safe dependency refresh (Vite 7 / plugin-react, FastAPI minor) only if
  e2e stays green; new libs: deck.gl 9, three.js.
- ☐ English-first demo mode (`?lang=en`) for international judges.

### WS-F · Pitch package
- ☐ Business model & financials (`BUSINESS_MODEL.md`): canvas, pricing
  assumptions, unit economics, 3-year plan, funding path — every number cited
  or labelled as an assumption.
- ☐ Slide deck (12–14 slides) mapped to the four criteria.
- ☐ Video: English narration script + storyboard (≤ 5 min unless the
  organiser sets a limit) and Playwright scripts that record product footage.
- ☐ Landing page refresh (`pythia/landing-page.html`) as the public face.

### WS-G · Live demo (needs team decision)
- ☐ Public demo URL for judges (server/domain from the team).

## Timeline (2026)

| Dates | Focus |
|---|---|
| Oct 14–15 | Plan, WS-C fixes, twin scene API, CI |
| Oct 16–20 | WS-A twin, WS-B AR (parallel) |
| Oct 21–22 | WS-D second city, XR tabletop, English demo mode, polish |
| Oct 23–25 | WS-F business model, deck, script, recording scripts |
| Oct 26–27 | Team records video, final QA, buffer |
| Oct 28 | Submit before 23:59 KST |

## Guardrails
- Data honesty stays non-negotiable: simulated/modelled data is labelled in UI,
  deck and video. Claims in the pitch come from `RESEARCH.md` or are marked as
  assumptions.
- Every feature ships with tests; no regression in pytest or Playwright.
- Rebrand compatibility rules in `CLAUDE.md` still apply.
