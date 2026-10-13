# Pythia — presentation video (English, target 4:30)

Judged on Problem Recognition · Solution · Growth Strategy · Presentation.
Rules: every on-screen number comes from `RESEARCH.md` / `BUSINESS_MODEL.md`;
modelled or simulated data stays labelled exactly as the product labels it;
no news photos without a licence — use our own data visuals and product
footage. Shot IDs map to the recording scripts (`pythia/frontend/e2e/recording/`).

| Time | Criterion | Visual (shot) | Narration |
|---|---|---|---|
| 0:00–0:20 | Problem | **S1** Black → slow push into the 3D twin over Bantargebang; landfill beacon shows the queue. Title card: "8 March 2026" | "On the eighth of March 2026, part of Indonesia's largest landfill, Bantargebang, collapsed after days of heavy rain — while garbage trucks were queuing to unload. At least five people were killed." |
| 0:20–0:50 | Problem | **S2** Animated stat cards over the twin: 7,400–8,700 t/day · ~1,700 trucks · 1,200+ trucks a day into one landfill · HCMC Da Phuoc night-only intake | "Jakarta produces up to eight thousand seven hundred tonnes of waste a day, carried by about seventeen hundred trucks into a single landfill. Ho Chi Minh City and Hanoi face the same squeeze. Cities still react after the waste piles up — and the queue at the landfill is where reactive becomes dangerous." |
| 0:50–1:10 | Solution | **S3** Pythia logo; three-layer diagram: Forecast → Plan → Act, with Twin / Command / AR icons | "We built Pythia — the oracle for city waste. It forecasts tomorrow's waste district by district, turns it into a plan, and lets everyone from the city leader to the truck crew see and act on it." |
| 1:10–1:50 | Solution | **S4** Twin tour: 42 district columns rise; scrub the 7-day horizon; set rain 80 mm + 50,000-person concert at GBK → columns grow, districts turn amber/red, metric strip updates trucks required | "This is Jakarta's digital twin. Each column is a district's forecast from our Prophet and XGBoost models, trained on the city's own data. Add eighty millimetres of rain and a fifty-thousand-person concert, and Pythia shows exactly which districts spike, by how much, and how many trucks and crews to stage — a day before it happens." |
| 1:50–2:20 | Solution | **S5** Command center: landfill queue + staggered dispatch slots; T-047 deviation → A* reroute → WhatsApp alert | "Dispatchers see every truck. Pythia staggers landfill arrivals so trucks stop stacking up on the slope, flags route deviations, reroutes around jams, and sends instructions straight to drivers on WhatsApp." |
| 2:20–2:50 | Solution | **S6** Phone (real device): driver opens SPJ stop → AR arrow guides to the collection point → "Arrived" → evidence photo captured from the AR view | "In the field, crews get augmented-reality guidance to every collection point and capture proof of service right from the camera — even offline." |
| 2:50–3:10 | Solution | **S7** XR tabletop: the city twin placed on a meeting table (phone AR) / orbit view; day scrubber | "And leaders can put the whole city on the table — the same forecast, in mixed reality, to agree the plan in minutes." |
| 3:10–3:20 | Solution | **S8** Audit workspace + provenance chips (MODEL OUTPUT / SIMULATED / REAL) | "Every number in Pythia says where it came from — real, modelled, or simulated. That honesty is what lets a government trust it." |
| 3:20–3:55 | Growth | **S9** Map animation: Jakarta → Indonesian metros (World Bank LSDI) → HCMC & Can Tho (K-City Network) ; pricing card | "Our customers are city environment agencies. We charge per truck and per city — about nine hundred thousand dollars a year for Jakarta at full scale. We start with a Jakarta pilot, expand to Indonesian cities through World Bank waste programmes, and enter Vietnam with Korea's K-City Network — Ho Chi Minh City and Can Tho are already 2026 winners. Here is Ho Chi Minh City running as our demo city today." |
| 3:55–4:15 | Growth | **S10** Competitor matrix + traction: semifinalist AI Open Innovation Challenge 2026 (DLH case); 1,081 real TPS; 42 district models; tests | "Fleet trackers and smart bins exist — but no one combines weather- and event-driven forecasting, live supervision and landfill-queue control for developing-city governments. We built Pythia on Jakarta's real data and reached the semifinal of the national AI Open Innovation Challenge on this very case." |
| 4:15–4:30 | Presentation | **S11** Team photo/names (team to provide) → closing twin shot; tagline | "We're asking for mentoring and introductions to Korean smart-city partners for our first pilot. Pythia: see tomorrow's waste today." |

## Recording notes
- Product footage: 1920×1080, 60 fps if possible, browser at 100% zoom, English UI
  (`?lang=en`), twin presentation mode (`?present=1`).
- S6 must be filmed on a real phone outdoors near a TPS (or any point with a
  coordinate) — screen-record + a hand-held shot of the phone.
- S7 on an ARCore Android phone (Chrome) for WebXR AR; fall back to the orbit
  viewer screen capture if no device is available — say "3D view" then, not AR.
- Voice: one narrator, calm and confident; music low.
- Update traction line if the AI Open Innovation Challenge final result is out.
