# Product

## Register

product

## Users

Pythia is built for city waste agencies (B2G); its first case is Jakarta, with public data from DLH DKI Jakarta (Pythia is not a DLH product). It has two working surfaces:

- **Dispatcher console** (`/app`): the dispatcher on shift plans tomorrow, checks morning readiness, watches the TPA gate, manages work orders (SPJ, the DKI surat jalan) and closes the day. The supervisor works in the same console: Supervisor mode is a sidebar toggle that turns the Tomorrow page into the review-and-approve view. Administrators manage accounts and WhatsApp in Settings; WhatsApp messages go out in one language chosen there (Indonesian by default).
- **Driver app** (`/driver`): drivers on budget Android phones receive the instruction, follow the stops, tap in at the gate, photograph the weigh ticket and report damage, also offline.

Users need to see what needs a person now, check the evidence, and act without searching across unrelated panels.

## Product Purpose

Pythia turns a forecast into a day that runs: tonnes per district for tomorrow and an outlook up to 30 days ahead, a daily truck plan within the landfill gate caps, one work order and gate slot per truck, and a close-of-day recap from weighbridge tickets that feeds a bounded correction back into the forecast. Ana, the assistant, answers questions from read-only tools and drafts messages, instructions or escalations that the dispatcher sends, edits or dismisses; she never dispatches or approves on her own. Success means a dispatcher can move from a signal to a defensible decision and a field action while seeing which inputs are observed, modelled, simulated or assumed.

The 3D twin, the XR tabletop and the simulated second city are legacy demo code, not product features.

## Brand Personality

Authoritative, precise, and operational. Pythia should feel like mature public-infrastructure software: calm under pressure, evidence-first, and trustworthy rather than futuristic or promotional.

## Anti-references

- Generic AI dashboards with purple gradients, excessive cards, decorative glow, oversized headings, and chatbot-first composition.
- Template admin panels whose navigation and metrics are unrelated to the user's actual workflow.
- Dense command centers that use dark styling, tiny text, or color alone to communicate status.
- Interfaces that present simulated or modeled data as live observations.

## Design Principles

1. Put the operational decision before supporting analytics.
2. Preserve context from signal through evidence, recommendation, and dispatch.
3. Use hierarchy and density to aid scanning, not decoration.
4. Make provenance and freshness visible wherever they affect trust.
5. Prefer familiar controls and predictable workspace behavior.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All controls require visible keyboard focus, semantic labels, and complete disabled/loading/error states. Status must use text or icons in addition to color. Motion must remain subtle and respect reduced-motion preferences. Layout must remain usable on laptop, wide desktop, tablet, and mobile widths.
