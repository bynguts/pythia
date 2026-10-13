# Pythia — business model & financial plan

Market facts come from `RESEARCH.md` (sourced). Every number marked
**[A]** is a planning assumption the team chose, not a market fact — the deck
must label it the same way. FX assumption: US$1 ≈ KRW 1,370 ≈ IDR 16,300 **[A]**.

## 1. One line

**Pythia forecasts tomorrow's city waste district by district and turns it into
a plan the whole operation can see — a 3D twin for planners, live supervision
for dispatchers, AR guidance for crews — before landfill queues turn into
disasters.**

## 2. Customer and users

| Who pays | Who uses it | Job to be done |
|---|---|---|
| City environment agency (DLH DKI Jakarta; Vietnam DONRE / city URENCO) — B2G | Planners | Know where and when waste will spike (rain, holidays, crowd events); pre-position trucks, crews, bins |
| | Dispatchers / supervisors | See every truck, deviation and landfill queue; stagger arrivals; approve plans |
| | Field crews / drivers | Turn-by-turn AR guidance, evidence capture, offline-safe work orders (SPJ) |
| | Leaders | Explain the plan in an immersive twin; audit what is real vs modelled |
| Secondary (B2B) | Collection operators (e.g. Waste4Change), landfill/RDF operators | Same supervision stack for their fleets |

## 3. Value proposition (by criterion the judges score)

- **Problem**: Bantargebang (110 ha, 80+ Mt, 7.5–7.8k t/day from 1,200+
  trucks) partially collapsed on 8 Mar 2026 *while trucks queued to unload*.
  HCMC's Da Phuoc moved to night-only intake (Dec 2025) and backlogs followed.
  Operations are reactive: volume is known only after it piles up.
- **Solution**: forecast (Prophet + XGBoost per district, weather/event aware) →
  plan (OR-Tools CP-SAT assignment, staggered landfill arrivals) → execute (SPJ
  work orders, AR crew guidance, WhatsApp alerts) → audit (provenance on every
  number).
- **Why now**: Indonesia targets 100% managed waste by 2029 (RPJMN); Vietnam
  made source sorting mandatory from 2025; Korea funds smart-city pilots
  abroad (K-City Network) and the World Bank funds Indonesian local waste
  services ($350M LSDI, Dec 2025).
- **Why us**: built on the real Jakarta data a city actually has (SILIKA
  1,081 TPS, 42 kecamatan baseline, DKI truck census), already semifinalist in
  the AI Open Innovation Challenge 2026 on DLH Jakarta's own case, and honest
  about what is modelled vs simulated — the property procurement auditors ask for.

## 4. Revenue model **[A]**

| Line | Price **[A]** | Rationale |
|---|---|---|
| Fleet supervision | **US$40 per active truck / month** | Below the US/EU benchmark of $50–150/truck/month (RESEARCH.md) to fit SEA municipal budgets |
| City intelligence platform (forecast + twin) | **US$60k per city / year** (US$40k for cities < 1M people) | Priced per city, not per user, so every agency department can use it |
| Immersive module (AR crews + XR twin) | +US$15k per city / year | Uses phones the crews already carry; no headset required |
| Pilot / implementation | US$60k one-off (often grant-funded) | Data onboarding, integration with existing GPS/weighbridges, training |

Procurement path: **grant-funded pilot → city MoU → line item in the city
budget (APBD) or in a World Bank / ADB loan component** (inferred path, see
RESEARCH.md).

## 5. Unit economics **[A]**

- Cloud + maps per mid-size city: ~US$1.5k/month (one API node, model
  retraining weekly, map tiles via OpenFreeMap/self-hosted) → ~US$18k/yr.
- Jakarta at full rollout (1,700 trucks): 1,700 × $40 × 12 = **$816k** + $60k
  platform + $15k immersive = **$891k ARR** against ~$18–30k infra →
  **>90% gross margin before implementation staff**.
- Customer support: 1 customer-success engineer per ~3 cities.

## 6. Go-to-market

1. **Jakarta pilot (2027 H1)** — 200 trucks, 2 kecamatan clusters, measured
   against DLH's own baseline (queue minutes, trips, fuel). Pythia was built on
   DLH Jakarta's competition case, so the relationship and data already exist.
2. **Indonesian metros (2027–2028)** — Surabaya, Bandung, Semarang, Medan,
   Makassar via the World Bank LSDI programme (30 local governments).
3. **Vietnam (2028)** — Ho Chi Minh City and Can Tho (both 2026 K-City Network
   winners) through a Korean consortium partner applying for a KRW 300–400M
   demonstration grant; Hanoi next.
4. **Partners** — Korean smart-city integrators and telcos (K-City Network
   consortium requirement), local collection operators, universities (CAU,
   PTIT, President University) for field research and talent.

## 7. Three-year plan **[A]**

| | 2027 | 2028 | 2029 |
|---|---:|---:|---:|
| Cities live | 1 (pilot) | 4 | 8 |
| Trucks on platform | 200 | 2,600 | 4,300 |
| Fleet revenue ($480/truck/yr) | $48k (6 mo) | $1.25M | $2.06M |
| Platform + immersive + pilot fees | $60k | $225k | $455k |
| **Revenue** | **$108k** | **$1.47M** | **$2.52M** |
| Team (FTE) | 6 | 14 | 24 |
| Non-dilutive funding | K-City / innovation grants | WB/ADB project budgets | — |

How the rows are built (all **[A]**):
- 2027: Jakarta pilot, 200 trucks billed for 6 months (200 × $40 × 6) + $60k
  pilot fee.
- 2028: Jakarta 1,700 trucks + three Indonesian cities × 300 trucks, full year.
  Platform: Jakarta $60k + $15k immersive; three cities × $40k; immersive in two
  of them (2 × $15k).
- 2029: the 2028 cities + one more Indonesian city (300 trucks), HCMC (1,000),
  Can Tho (200) and a Hanoi pilot (200), full year. Platform: Jakarta $75k;
  four Indonesian cities × $40k + immersive in three ($45k); HCMC $60k + $15k;
  Can Tho $40k; Hanoi pilot fee $60k.

This is a planning scenario, not a forecast of signed revenue.

## 8. Impact model (what a city gets)

| Lever | Expected range | Basis |
|---|---|---|
| Fuel & route time | −5 to −15% | Peer-reviewed route optimisation: −10.8% fuel (Ghana), −14.3% (Al Ain) |
| Peak landfill queue | 47 → 19 trucks in simulation | Pythia staggered-dispatch discrete-event simulation — **simulation, not field result** |
| Flood / event readiness | Trucks and crews staged a day ahead | District forecast + resource plan; to be validated in the pilot |
| Safety | Fewer trucks idling on unstable slopes | Staggered arrivals reduce queue length at the tipping face |

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Long public procurement cycles | Grant-funded pilots; partner with integrators already on city vendor lists |
| Data access (GPS, weighbridges) | Phone-based driver app + offline outbox works without new hardware; adapters for existing GPS |
| Forecast accuracy at daily district level | Report suitability honestly (already in the audit workspace); improve with pilot data |
| Sovereignty / privacy | Deployable on city cloud; no personal data beyond driver accounts |

## 10. The ask (for the competition)

- Mentoring and introductions to Korean smart-city integrators for a K-City
  Network application (HCMC / Can Tho).
- A pilot partner city (Jakarta first) and access to its GPS/weighbridge feeds.
- Pre-seed: **US$300k [A]** for 18 months — pilot delivery, 2 engineers, 1
  field/customer engineer, cloud.

## Team (to fill in by the team — do not invent)

- Names, roles, universities, relevant experience.
