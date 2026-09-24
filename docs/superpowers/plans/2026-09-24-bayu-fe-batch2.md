# Bayu Frontend Issues Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Impeccable constraint: this is REFINEMENT of the existing JWIS design world — preserve tokens, layout, visual identity, and behavior. No new visual world. All copy changes ride the existing i18n catalog in `src/i18n.jsx`.

## Worktree
`/tmp/jwis-bayu-fe2` branch `fix/bayu-fe-batch2` from `origin/main` (2275f42).

## Test infrastructure
- Backend: `/tmp/jwis-bayu-fe2/jwis/backend/.venv-pr91/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8002` (fresh DB at `/tmp/jwis-fe2-e2e/jwis.db`, JWIS_SPJ_SEED=off)
- Frontend: `vite build && vite preview --port 5176` (production build — SW registration requires prod)
- Playwright: `node_modules/.bin/playwright test` (copy node_modules from bayu-nonfe worktree or npm install)

## Task 1 — #15 Localize the application shell (P1)
Files: `src/layout/AppShell.jsx`, `src/i18n.jsx`
- [ ] Add keys: shell_sidebar_label, shell_brand_sub, shell_workspaces, shell_connected_title, shell_connected_sub, shell_offline_title, shell_offline_sub, shell_logout, shell_context_eyebrow, desc_fleet, desc_forecast, desc_planning, desc_drivers, desc_audit, shell_lang_label, shell_assistant, shell_profile_label, shell_profile_name, shell_profile_role, shell_mobile_nav_label (both en+id)
- [ ] Replace hardcoded strings in AppShell.jsx (incl. items[].description → t(desc_*) lookup, aria-labels)
- [ ] Test `e2e/shell-locale.spec.js`: login, switch EN → assert "Workspaces", "System connected", "Logout", "Operations in Jakarta" etc.; switch ID → assert Indonesian equivalents; assert no mixed copy both modes on desktop nav + mobile nav viewport 390px.

## Task 2 — #79 Localize the login surface (P1)
Files: `src/pages/LoginPage.jsx`, `src/i18n.jsx`
- [ ] Keys: login_story_kicker, login_story_headline, login_story_copy, login_proof1_title/sub, proof2, proof3, login_story_footer, login_eyebrow, login_username_label, login_password_label, login_submitting, login_card_title already exists
- [ ] Replace hardcoded ID strings; story panel + labels + placeholders + reveal buttons + submit state
- [ ] Test `e2e/login-locale.spec.js`: EN mode shows English story/labels/placeholder/reveal/submit; ID default; invalid creds error localized both modes; locale persists after login.

## Task 3 — #68 Localize the Forecast workspace (P1)
Files: `src/workspaces/WasteForecast.jsx`, `src/i18n.jsx`
- [ ] Keys: fc_kicker, fc_horizon_label, fc_priority_kicker, fc_priority_title, fc_priority_sub, fc_context_label, fc_context_kicker, fc_context_title, fc_evidence_kicker, fc_evidence_title, fc_evidence_sub
- [ ] Replace hardcoded ID section copy (kickers/headings/subtitles/context rail label)
- [ ] Test extend `e2e/shell-locale.spec.js` or new `forecast-locale.spec.js`: EN mode shows "Demand intelligence", "Analysis range", "Regional priority", "Service demand map", "Decision context", "Model evidence"; ID shows Indonesian.

## Task 4 — #82 Localize Driver Analytics (P1)
Files: `src/workspaces/DriverAnalytics.jsx`
- [ ] Localize all metric labels, table headers, statuses, recommendation rail, `Nihil`, plurals, accessible labels (component already uses `id` flag pattern — extend it; keep raw API enums stable)
- [ ] Test: EN mode asserts "Average score", "Active drivers", "Needs coaching", "All drivers", "Compliance score"; ID asserts equivalents.

## Task 5 — #83 Localize the damage-report panel (P1)
Files: `src/workspaces/DamageReportsPanel.jsx`
- [ ] Wire useLanguage; localize heading, count pill, empty state, column headers, severity/source/status values (map `berat`→Severe/berat, `selesai`→Resolved/selesai, NON-OPERASIONAL badge), resolve action button, table region label; dates use locale toLocaleString
- [ ] Test: both modes assert heading/columns/status translation; resolve button label.

## Task 6 — #76 Localize the assistant (P1)
Files: `src/ui/AssistantPanel.jsx` (or wherever; grep greeting "Halo")
- [ ] Localize greeting, quick prompts, upload controls, input placeholder, buttons, labels, loading/error/fallback copy, humanized risk phrases, avatar names; answer language requested explicitly in the prompt payload (lang field); fix mixed-language error `Ana tidak dapat menjawab ... AI gateway error`
- [ ] Test: EN + ID greeting/prompts/placeholder visible; API error path localized (mock gateway 500); network fallback localized.

## Task 7 — #21 Derive planning review from the active scenario (P1)
Files: `src/workspaces/ExecutiveSummary.jsx`, `src/main.jsx`
- [ ] ExecutiveSummary currently computes from `snapshot` (pre-simulation fallback). Change PlanningDecisionFlow to pass active `data` (scenario forecast response) when present: `<ExecutiveSummary snapshot={data || snapshot} queue={queue} />`
- [ ] Keep snapshot as fallback only when no scenario data (per AC "Snapshot data is only a pre-simulation fallback")
- [ ] Remove the dead `summary={snapshot.executive_summary}` prop on PlanningDecisionFlow in main.jsx (unused — component composes its own summary)
- [ ] Test `e2e/planning-consistency.spec.js`: open Planning, change attendance slider/input to a large event, run scenario, assert review headline/points numbers match the scenario response (poll DOM numbers vs API response numbers), then change input and re-run, assert numbers updated.

## Task 8 — #42 Forecast bars accessible semantics (P1)
Files: `src/workspaces/KecamatanMapPanel.jsx`
- [ ] Bar `<div aria-label>` → keep div decorative (aria-hidden) + ensure adjacent text carries "district, amount, unit once". The `<b>{tons} t</b>` + row heading already exist — just remove aria-label from div (prohibited on plain div) and add role="img" + aria-label is still prohibited; simplest compliant: make the bar container aria-hidden and rely on visible text. Verify with axe.
- [ ] Test: run axe on Forecast in both modes via playwright axe integration (if @axe-core/playwright available) or assert no aria-label on .bar divs.

## Task 9 — #71 Forecast mobile viewport overflow (P1)
Files: `src/workspaces/WasteForecast.jsx` + CSS in `src/styles.css`
- [ ] At 320/375/390/768: ensure `documentElement.scrollWidth <= viewport`. Contain the wide prediction table in a scrollable region (overflow-x: auto on its container with role="region" aria-label + tabIndex=0 — pattern already used in DamageReportsPanel table-wrap)
- [ ] Test `e2e/forecast-mobile.spec.js`: for each width assert scrollWidth === clientWidth (no page overflow) and the prediction table region is scrollable internally.

## Task 10 — #37 Planning heading order (P2)
Files: `src/workspaces/PlanningDecisionFlow.jsx`
- [ ] `h4` "AI 7-day outlook" without h3 ancestor → change to h3 (or restructure to keep contiguous h1→h2→h3). Styling decoupled from level: add class to preserve visual size.
- [ ] Test: axe heading-order rule on Planning workspace (or assert tag hierarchy in DOM).

## Task 11 — #31 Touch targets 44x44 (P2)
Files: `src/styles.css` (+ map control CSS)
- [ ] Ensure min 44x44 hit area (via min-height/min-width or padded pseudo-element ::before expanding hit area without layout shift) for: MapLibre controls (.maplibregl-ctrl buttons 29x29→44), map reset button (30x30), language switch (35x28), map search (34px), and other sampled controls; use padding/box-sizing so no overlap or horizontal overflow
- [ ] Test `e2e/touch-targets.spec.js` at 390x844 and 768: boundingBox() of representative controls ≥44 in both dims, and no element overlap (compare rects), page still no horizontal overflow.

## Task 12 — #78 SPJ panel responsive interaction (P2)
Files: `src/workspaces/SpjPanel.jsx` + styles
- [ ] Row click → named button with aria-expanded + keyboard support (Enter/Space). Keep visual design. Narrow layout: wrap the table in `.table-wrap` scroll region pattern (already exists in DamageReportsPanel)
- [ ] Test: axe/click simulation at 390px — expansion button focusable and togglable via keyboard; table contained (no page overflow). Extend existing spj-workflow.spec.js run (already covers create/expand/activate/cancel via UI).

## Task 13 — #43 Stop animating layout properties (P3)
Files: `src/driver/driver.css:158`, `src/styles/legacy.css:34`
- [ ] `transition: width ...` → replace with transform-based (scaleX) or remove if nonessential; preserve reduced-motion behavior and visual state feedback
- [ ] Test: grep CSS for `transition:.*width|min-` patterns = none; visual smoke via existing E2E suites (driver-workflow, field suites already green = no visual regression in those flows).

## Task 14 — #41 Bundle budgets (P2)
Files: `vite.config.js`, `package.json`, CI
- [ ] Add manualChunks: split LiveFleetMap (maplibre) and html2pdf into lazy chunks (dynamic import already? check ReportActions/pdf usage) so startup path excludes them
- [ ] Add `scripts/check-bundle-budget.mjs`: parses dist/asset size manifest; budgets: initial JS ≤ 300KB gzip, lazy chunk ≤ 350KB gzip each, CSS ≤ 120KB gzip; fails on regression. Wire into package.json "test:bundle" and CI if present (.github/workflows)
- [ ] Test: run build + budget script; record sizes before/after in PR.

## Final validation
- [ ] Full backend pytest (should be untouched: 484)
- [ ] Full E2E: all new specs + existing suites (sw-cache, field-dedup, install-metadata, spj-cleanup-guard, spj-workflow, driver-workflow, field-workflow) green — field-workflow:171 known pre-existing failure on main, document only
- [ ] vite build clean, bundle budget script green
- [ ] Push branch, PR, review, merge, close issues with evidence comments
