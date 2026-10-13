// GSC-2026 WS-A: Pythia Twin — the 3D digital twin renders all 42 Jakarta
// districts from /api/twin/scene, a rainfall scenario raises district risk,
// the Ho Chi Minh City demo city is labelled as simulated, every layer shows
// its provenance, and the workspace stays touch-friendly at 390 px.
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, lang = "en") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", lang);
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, { ...principal, lang });
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function waitForTwin(page, predicate = "true") {
  await page.waitForFunction(
    `window.__pythiaTwin && window.__pythiaTwin.ready && (${predicate})`,
    null,
    { timeout: 45000 },
  );
  return page.evaluate(() => {
    const { startTour, stopTour, setDay, setCity, setRainfall, setEventPreset, ...state } = window.__pythiaTwin;
    return state;
  });
}

async function openTwin(page) {
  await page.getByTestId("workspace-navigation").getByRole("button", { name: "Digital Twin", exact: true }).click();
  await expect(page.getByTestId("twin-workspace")).toBeVisible();
}

test("twin is the first workspace and renders all 42 Jakarta districts with provenance", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await expect(page.getByTestId("workspace-navigation").getByRole("button").first()).toHaveText("Digital Twin");
  await openTwin(page);
  await expect(page.getByRole("heading", { name: "City waste digital twin" })).toBeVisible();

  const state = await waitForTwin(page);
  expect(state.city).toBe("jakarta");
  expect(state.districtCount).toBe(42);
  expect(state.selectedDay).toBe(0);
  expect(state.scenario.rainfall_mm).toBe(0);

  const cells = page.getByTestId("twin-workspace").getByTestId("metric-cell");
  await expect(cells).toHaveCount(4);
  for (const cell of await cells.all()) {
    await expect(cell.locator("strong")).not.toHaveText("—");
  }
  await expect(cells.first().locator("strong")).toHaveText(/^[\d,]+ t$/);

  // Data honesty: every layer carries its class, and nothing is labelled live.
  const provenance = page.getByTestId("twin-provenance");
  await expect(provenance.getByTestId("twin-provenance-districts")).toContainText("Model output");
  await expect(provenance.getByTestId("twin-provenance-tps")).toContainText("Real data");
  await expect(provenance.getByTestId("twin-provenance-trucks")).toContainText("Simulated");
  await expect(provenance.getByTestId("twin-provenance-landfill_queue")).toContainText("Simulated");
  await expect(provenance).not.toContainText(/live/i);
  await expect(page.getByTestId("twin-demo-banner")).toHaveCount(0);
  // The landfill queue label on the map states that the queue is simulated.
  expect(state.landfillLabel).toContain("Queue data: Simulated");

  // Day scrubber: picking a later day moves the selected day.
  await page.getByTestId("twin-day-3").click();
  await expect.poll(() => page.evaluate(() => window.__pythiaTwin.selectedDay)).toBe(3);
  await expect(page.getByTestId("twin-day-3")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("twin-day-0").click();

  expect(errors).toEqual([]);
});

test("rainfall scenario re-forecasts and raises districts at risk", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await openTwin(page);
  const before = await waitForTwin(page);

  const slider = page.getByTestId("twin-rainfall");
  await slider.focus();
  for (let i = 0; i < 16; i += 1) await slider.press("ArrowRight");
  await expect(page.getByTestId("twin-rainfall-value")).toHaveText("80 mm");

  const after = await waitForTwin(page, "window.__pythiaTwin.scenario && window.__pythiaTwin.scenario.rainfall_mm === 80");
  expect(after.districtCount).toBe(42);
  expect(after.districtsAtRisk).toBeGreaterThan(0);
  expect(after.districtsAtRisk).toBeGreaterThanOrEqual(before.districtsAtRisk);
  // Column heights follow tonnes: the rain scenario must grow the city load.
  expect(after.totalTons).toBeGreaterThan(before.totalTons);
  const riskCell = page.getByTestId("twin-workspace").getByTestId("metric-cell").nth(2);
  await expect(riskCell.locator("strong")).toHaveText(String(after.districtsAtRisk));

  // "Open in AR/XR" carries the scenario on screen to the tabletop.
  const xrLink = page.getByTestId("twin-xr-link");
  await expect(xrLink).toHaveAttribute("href", "/xr?city=jakarta&rainfall_mm=80");
  await page.getByTestId("twin-event-50k").click();
  await expect(xrLink).toHaveAttribute(
    "href",
    "/xr?city=jakarta&rainfall_mm=80&event_attendance=50000&event_lat=-6.2183&event_lng=106.8022",
  );
});

test("keyboard users can pin a district from the at-risk list", async ({ page }) => {
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);
  const list = page.getByTestId("twin-risk-list");
  const items = list.getByRole("button");
  await expect(items).toHaveCount(5);
  const first = items.first();
  const name = (await first.locator(".twin-risk-name").textContent()).trim();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("twin-detail")).toContainText(name);
  // The list is ordered by risk, then by change against a normal day.
  const ranks = await items.evaluateAll((buttons) => buttons.map((b) => {
    const tag = b.querySelector(".twin-risk-tag");
    return ["risk-normal", "risk-elevated", "risk-high", "risk-critical"].findIndex((c) => tag.classList.contains(c));
  }));
  expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
});

test("Ho Chi Minh City is labelled as a simulated demo city", async ({ page }) => {
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);

  await page.getByTestId("twin-city-hcmc").click();
  const state = await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc'");
  expect(state.districtCount).toBeGreaterThan(0);
  const banner = page.getByTestId("twin-demo-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/simulated demo city/i);
  await expect(page.getByTestId("twin-provenance-districts")).toContainText("Simulated demo city");
  await expect(page.getByTestId("twin-provenance-trucks")).toContainText("Unavailable");
  // The shell header names the city on screen, so it follows the switch.
  await expect(page.locator(".command-eyebrow")).toHaveText(/Ho Chi Minh/);

  await page.getByTestId("twin-city-jakarta").click();
  await waitForTwin(page, "window.__pythiaTwin.city === 'jakarta'");
  await expect(page.locator(".command-eyebrow")).toHaveText(/Jakarta/);
  await expect(banner).toHaveCount(0);
});

test("cinematic tour runs through its stops and can be stopped", async ({ page }) => {
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);
  await page.getByTestId("twin-tour").click();
  const caption = page.getByTestId("twin-tour-caption");
  await expect(caption).toBeVisible();
  await expect(caption).toContainText("1 / 4");
  await expect(caption).toContainText("Highest-risk district", { timeout: 15000 });
  await page.keyboard.press("Escape");
  await expect(caption).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("twin-xr-link")).toHaveAttribute("href", "/xr?city=jakarta");

  // A tour is scripted for one city: switching city ends it.
  await page.evaluate(() => window.__pythiaTwin.startTour());
  await expect(caption).toBeVisible();
  await page.getByTestId("twin-city-hcmc").click();
  await expect(caption).toBeHidden({ timeout: 5000 });
  await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc' && !window.__pythiaTwin.tourActive");
});

test("under reduced motion the tour uses jump cuts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await openTwin(page);
  await waitForTwin(page);
  await page.evaluate(() => window.__pythiaTwin.startTour());
  const caption = page.getByTestId("twin-tour-caption");
  await expect(caption).toContainText("1 / 4");
  await expect(caption).toContainText("2 / 4", { timeout: 6000 });
  await page.getByTestId("twin-tour-caption").getByRole("button").click();
  await expect(caption).toBeHidden();
});

test("twin stays touch-friendly with no horizontal overflow at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "id");
  const nav = page.locator(".command-mobile-nav");
  await nav.getByRole("button", { name: "Kembaran" }).click();
  await expect(page.getByTestId("twin-workspace")).toBeVisible();
  await waitForTwin(page);

  // Controls live in a bottom sheet; the map stays visible above it.
  const toggle = page.getByTestId("twin-sheet-toggle");
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("twin-city-hcmc")).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId("twin-city-hcmc")).toBeVisible();
  await expect(page.getByTestId("twin-map")).toBeVisible();

  const failures = await page.evaluate((min) => {
    const out = [];
    const selectors = [
      ".twin-workspace button",
      ".twin-workspace a",
      ".twin-workspace input[type=range]",
      ".command-mobile-nav button",
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.display === "none" || style.visibility === "hidden") return;
        if (el.closest(".maplibregl-ctrl-attrib-inner")) return; // attribution text links
        if (r.width < min || r.height < min) out.push(`${selector} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
    }
    return out;
  }, 44);
  expect(failures, failures.join(", ")).toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const width of [360, 320]) test(`day buttons keep 44 px targets at ${width} px without page overflow`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await signIn(page, "id");
  await page.locator(".command-mobile-nav").getByRole("button", { name: "Kembaran" }).click();
  await waitForTwin(page);
  const days = page.locator(".twin-day");
  await expect(days).toHaveCount(7);
  for (const day of await days.all()) {
    const box = await day.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // The last day is reachable (scrolls inside the timeline if it must).
  await page.getByTestId("twin-day-0").focus();
  await page.keyboard.press("End");
  await expect.poll(() => page.evaluate(() => window.__pythiaTwin.selectedDay)).toBe(6);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("presentation HUD states that the landfill queue is simulated", async ({ page }) => {
  await signIn(page);
  await page.goto("/?present=1");
  // ?present=1 opens the twin full-screen over the shell (the nav sits under
  // the map, so it is not clicked); wait on the HUD itself.
  const hud = page.locator(".twin-present-hud");
  await expect(hud).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("twin-present-queue")).toHaveText("Queue data: Simulated");
});

test("twin controls meet text contrast requirements", async ({ page }) => {
  await signIn(page, "id");
  await page.getByTestId("workspace-navigation").getByRole("button", { name: "Kembaran Digital", exact: true }).click();
  await waitForTwin(page);
  await page.getByTestId("twin-city-hcmc").click();
  await waitForTwin(page, "window.__pythiaTwin.city === 'hcmc'");
  const results = await new AxeBuilder({ page }).include("[data-testid=twin-workspace]").withRules(["color-contrast"]).analyze();
  expect(results.violations.map(({ nodes }) => nodes.map(({ target }) => target))).toEqual([]);

  // No layout-property transitions anywhere in the twin (#43 rule).
  const layoutTransitions = await page.evaluate(() => {
    const layout = /^(width|height|min-|max-|padding|margin|top|left|right|bottom)/;
    const bad = [];
    document.querySelectorAll("[data-testid=twin-workspace] *").forEach((el) => {
      const cs = getComputedStyle(el);
      const durations = cs.transitionDuration.split(", ");
      cs.transitionProperty.split(", ").forEach((prop, i) => {
        if ((prop === "all" || layout.test(prop)) && durations[i] && durations[i] !== "0s") bad.push(`${el.className} ${prop}`);
      });
    });
    return bad;
  });
  expect(layoutTransitions).toEqual([]);
});
