# Bayu Non-Frontend Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all open PIC-Bayu issues that are NOT pure Frontend localization work: #44 (PWA dedup), #50 (PWA cache writes), #49 (role-specific install), #85 (localized install metadata), #89 (E2E cleanup timeout), #87 (README audit claim), and verify #67 (E2E selector — already fixed upstream).

**Architecture:** Small surgical fixes to the service worker, offline outbox, web manifest, Playwright specs, and README. Backend gets one additive, backward-compatible field (`operation_id`) for idempotent dispatch confirmation. Each issue is one independently testable commit.

**Tech Stack:** FastAPI (Python 3.11), React 19 + Vite 6, Playwright 1.61, vanilla JS service worker, Web App Manifest.

**Spec:** GitHub issues #44 #49 #50 #67 #85 #87 #89 in bynguts/jwis-system.

## Global Constraints

- Work in isolated worktree `/tmp/jwis-bayu-nonfe`, branch `fix/bayu-non-frontend`, base `main` @ `8cf0537`.
- Backend suite must stay green: `pytest tests/ -q` (480 passing baseline).
- All commits mention the issue number (`Refs #NN` or `Fixes #NN`).
- No frontend localization strings work (that's the other 16 issues, out of scope).
- Playwright config: timeout 60000ms, baseURL http://127.0.0.1:5175, serial execution.
- Existing test helper: `e2e/global-setup.js`; API base `http://127.0.0.1:8001/api`.

## Review Focus

- #44: dedup key must be (dispatchId, status) — repeated taps of the SAME choice collapse; a READY then an ISSUE on the same dispatch are both preserved.
- #50: `event.waitUntil` must wrap cache writes; failed cache write must NOT fail the live response.
- #49/#85: two manifests (`manifest.webmanifest` EN default, `manifest.id.webmanifest`), shortcuts for Field/Driver, link swap by `jwis_lang`.
- #89: cleanup must run in its own bounded context even when the test body times out.
- #87: README must only name metrics reachable in the current UI/API (suitability labels + provenance, not WAPE/MAE).
- #67: verify only — the button selector fix already landed in `73b8df8`; if E2E runs green locally, close with evidence.

## Task 1 — Issue #50: service-worker cache writes attached to fetch lifetime

Files: `jwis/frontend/public/sw.js`

- [ ] 1.1 Write failing E2E check first: extend `e2e/field-workflow.spec.js` (or new `e2e/sw-cache.spec.js`) — register SW, fetch a shell/API resource, then verify `caches.match` for that resource after waiting for the put to settle. With the current buggy `cachePut` (returns nothing), a stress approach: call `cachePut` shape indirectly — the reliable programmatic check is that the fetch handler returns a promise chain that includes the put. For E2E-level verification: assert the resource IS in `caches` after a navigation + short settle, and that the response to the page was NOT an error even if cache write fails (stub `cache.put` rejection via page.evaluate is not possible in SW scope; keep to settle-and-match assertion).
- [ ] 1.2 Run the new spec; observe current behavior (baseline pass/fail information).
- [ ] 1.3 Fix `sw.js`: `cachePut` returns the promise from `caches.open().then(put)` chain; each `event.respondWith` wraps with `event.waitUntil(...)`.
- [ ] 1.4 Re-run the spec green.
- [ ] 1.5 Commit: `fix(pwa): keep service-worker cache writes alive until completion (Fixes #50)`.

## Task 2 — Issue #44: dedupe queued field confirmations

Files: `jwis/frontend/src/field/OfflineOutbox.js`, `jwis/frontend/src/field/FieldApp.jsx` (maybe), `jwis/frontend/e2e/field-workflow.spec.js`

- [ ] 2.1 Failing test first: E2E scenario — double-tap "Siap" while offline (route abort `/api/dispatch/*/confirm`), then verify `localStorage.jwis_field_outbox` contains exactly ONE pending entry for that dispatch (not two).
- [ ] 2.2 Fix `enqueue`: dedupe by `(dispatchId, status)` — if an entry with the same dispatchId AND status is already queued, replace it (update note, keep earliest queued_at) instead of appending.
- [ ] 2.3 Also make flush exactly-once observable: after flush, a second flush attempt sends nothing new (items are removed on success — already true; verify no re-enqueue path duplicates).
- [ ] 2.4 Backend hardening (additive, optional per issue but cheap): `DispatchConfirmRequest` gains `operation_id: str | None`; when present and already used for that dispatch, the endpoint returns the stored result instead of re-recording. Follow the same pattern as the SPJ receipt `operation_id` idempotency (see `test_receipt_retry_with_operation_id_is_not_a_conflict`).
- [ ] 2.5 Backend test: replayed `operation_id` confirm does not create a second history event; different `operation_id` does.
- [ ] 2.6 Run backend suite + new E2E green.
- [ ] 2.7 Commit: `fix(pwa): deduplicate queued field confirmations (Fixes #44)`.

## Task 3 — Issues #49 + #85: role-specific install entries + localized manifests

Files: `jwis/frontend/public/manifest.webmanifest` (EN default), new `jwis/frontend/public/manifest.id.webmanifest`, `jwis/frontend/index.html`

- [ ] 3.1 Create the ID manifest (localized name/description/short_name, same icons/scope/start_url logic) and extend BOTH manifests with `shortcuts`: Field (`/field`, short_label) and Driver (`/driver`).
- [ ] 3.2 `index.html`: swap the manifest link based on `localStorage.jwis_lang` at boot (inline script before the app loads, default ID if unset — matches app default).
- [ ] 3.3 E2E/check: assert both manifests are served (HTTP 200, valid JSON) and each contains the two shortcuts with correct `url` fields; assert link swap works in ID and EN modes.
- [ ] 3.4 Verify icons exist for declared sizes; start_url and scope unchanged for the default install.
- [ ] 3.5 Commit: `feat(pwa): role-specific install entry points and localized manifests (Fixes #49, Fixes #85)`.

## Task 4 — Issue #89: independent cleanup timeout for SPJ E2E

Files: `jwis/frontend/e2e/spj-workflow.spec.js`

- [ ] 4.1 Add a helper `cleanupSpj(page, spjId, headers)` that uses a fresh, bounded `page.request.newContext({ timeout: 10000 })` (APIRequestContext) — not the shared scenario budget.
- [ ] 4.2 Use it in `test.afterEach`/`finally` for every created SPJ; report cleanup failure separately (console + soft annotation) from the scenario failure.
- [ ] 4.3 Write the deliberate-failure proof: a temp test that throws inside the body right after SPJ creation, assert cleanup still ran and no active `T-210` remains (query `/api/spj` for leftovers).
- [ ] 4.4 Run the full spj-workflow spec green; remove the temporary proof test (or keep it as a permanent regression guard if it's cheap — prefer keeping).
- [ ] 4.5 Commit: `test(e2e): give SPJ workflow cleanup an independent timeout (Fixes #89)`.

## Task 5 — Issue #87: correct README audit-metrics claim

Files: `jwis/README.md`

- [ ] 5.1 Replace the WAPE/MAE claim (line ~98 "Audit the Prophet/XGBoost models' accuracy metrics (WAPE, MAE), training limits, and data provenance.") with what the UI/API actually exposes: per-resolution suitability labels (`reliable` / `synthetic-validated` / `not supported`) with validation-target classes and data provenance, via the Data & Model Audit workspace and `/api/ml/suitability`.
- [ ] 5.2 Mention the navigation path that reaches those metrics.
- [ ] 5.3 Commit: `docs(readme): document reachable audit metrics, not WAPE/MAE (Fixes #87)`.

## Task 6 — Issue #67 verification (already fixed by 73b8df8)

- [ ] 6.1 Run the full driver-workflow E2E spec locally (backend on :8001, vite preview on :5175).
- [ ] 6.2 If green — close #67 with evidence comment citing `73b8df8` + test output.

## Final Validation (all issues)

- [ ] F.1 Backend: `pytest tests/ -q` — all green (480 + new).
- [ ] F.2 Frontend build: `npm run build` clean.
- [ ] F.3 E2E: affected specs green (`sw-cache`, `field-workflow`, `driver-workflow`, `spj-workflow`).
- [ ] F.4 Push branch, open ONE PR with per-issue commits; post review evidence; merge after validation.
- [ ] F.5 Close #44 #49 #50 #67 #85 #87 #89 with evidence comments.
