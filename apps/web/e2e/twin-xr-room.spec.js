// Kota 3D and the XR table read as one decision room in the approved world.
// The twin's title shares the metric strip's band above a flush white rail (Ask Pythia
// first, then the week's scenarios as a flat list, then the controls); the map runs full
// bleed with white instrument pills and a mono provenance footer chip. Every strip number
// keeps its class label. /xr joins its panels into the same flush rail on desktop.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
// --ui-forest-900 maps onto the --f-green-deep (#174F33).
const FOREST_900 = "rgb(23, 79, 51)";

async function signIn(page, lang = "en") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal, lang },
  );
}

async function waitForTwin(page) {
  await page.waitForFunction("window.__pythiaTwin && window.__pythiaTwin.ready", null, { timeout: 45000 });
}

test.describe("wave11 twin decision room", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the rail leads with Ask Pythia, runs flush under the title and fills the screen", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    const briefing = page.getByTestId("twin-briefing");
    await expect(briefing).toHaveAttribute("data-state", "ready", { timeout: 45000 });

    const layout = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      return {
        heading: box(".twin-heading"),
        side: box("[data-testid=twin-side]"),
        ask: box("[data-testid=twin-ask]"),
        brief: box("[data-testid=twin-briefing]"),
        panel: box("[data-testid=twin-panel]"),
        map: box("[data-testid=twin-map]"),
        strip: box("[data-testid=twin-workspace] [data-testid=metric-strip]"),
        kickers: document.querySelectorAll("[data-testid=twin-workspace] .workspace-kicker").length,
        vh: window.innerHeight,
        scroll: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    // Flush to the left edge, the title above the rail at the rail's width.
    expect(layout.side.x).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.heading.width - layout.side.width)).toBeLessThanOrEqual(1);
    expect(layout.heading.bottom).toBeLessThanOrEqual(layout.side.top + 1);
    // Title and strip share one band.
    expect(Math.abs(layout.heading.top - layout.strip.top)).toBeLessThanOrEqual(1);
    // Ask Pythia, then the briefing, then the controls.
    expect(layout.ask.top).toBeLessThan(layout.brief.top);
    expect(layout.brief.top).toBeLessThan(layout.panel.top);
    // The map runs to the right and bottom edges; the room fits the screen.
    expect(Math.round(layout.map.right)).toBe(1440);
    expect(Math.abs(layout.map.bottom - layout.vh)).toBeLessThanOrEqual(2);
    expect(layout.scroll).toBeLessThanOrEqual(2);
    expect(layout.kickers).toBe(0);

    // Every number in the strip carries its class as a bare mono label.
    const cells = page.getByTestId("twin-workspace").getByTestId("metric-cell");
    await expect(cells).toHaveCount(4);
    for (const cell of await cells.all()) {
      const prov = cell.getByTestId("prov");
      await expect(prov).toHaveText("Model output");
      await expect(prov).toHaveCSS("text-transform", "uppercase");
    }
  });

  test("scenarios are a flat list, the decision is one forest pill, instruments float as pills", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    const rain = page.getByTestId("twin-briefing-heavy_rain");
    await expect(rain).toHaveAttribute("aria-pressed", "false");
    await expect(rain.locator(".twin-briefing-icon svg")).toBeVisible();
    await rain.click();
    await expect(rain).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("twin-briefing")).toHaveAttribute("data-state", "ready", {
      timeout: 45000,
    });
    const apply = page.getByTestId("twin-apply-plan");
    await expect(apply).toBeEnabled();
    await expect(apply).toHaveCSS("background-color", FOREST_900);
    // The tour is a quiet pill now, so the rail has one primary decision per section.
    await expect(page.getByTestId("twin-tour")).not.toHaveCSS("background-color", FOREST_900);

    // Instruments: the legend top left, the week bottom left, provenance bottom right.
    const map = await page.getByTestId("twin-map").boundingBox();
    const legend = await page.locator(".twin-legend-bar").boundingBox();
    const week = await page.getByTestId("twin-timeline").boundingBox();
    const prov = await page.getByTestId("twin-provenance-toggle").boundingBox();
    expect(legend.y - map.y).toBeLessThan(40);
    expect(map.y + map.height - (week.y + week.height)).toBeLessThan(40);
    expect(prov.x).toBeGreaterThan(week.x + week.width);
    expect(prov.y + prov.height).toBeGreaterThan(map.y + map.height - 80);
    await expect(page.locator(".twin-provenance-summary b").first()).toHaveCSS("text-transform", "uppercase");

    // The layer list opens above the footer chip and stays on the map.
    await page.getByTestId("twin-provenance-toggle").click();
    const list = await page.getByTestId("twin-provenance").boundingBox();
    expect(list.y + list.height).toBeLessThanOrEqual(prov.y + 1);
    expect(list.y).toBeGreaterThanOrEqual(map.y);

    // Honesty stays on screen: the scenario's rain is labelled as an assumption.
    await expect(page.getByTestId("twin-rain-label")).toContainText("not observed weather");
  });

  test("a closed lane shows Pythia's staggered answer, the steps lead to Planning, the scene stays calm", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/twin");
    await waitForTwin(page);
    const steps = page.getByTestId("twin-briefing-steps").locator("li");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveAttribute("aria-current", "step");

    await page.getByTestId("twin-briefing-weighbridge_lane_down").click();
    const briefing = page.getByTestId("twin-briefing");
    await expect(briefing).toHaveAttribute("data-state", "ready", { timeout: 45000 });
    // Click two of three: the numbers are in, the next click approves to Planning.
    await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");
    const num = async (id) => Number(await page.getByTestId(id).getAttribute("data-value"));
    const queue = await num("twin-briefing-after-queue");
    const staggered = await num("twin-briefing-after-staggered");
    expect(staggered).toBeGreaterThan(0);
    expect(staggered).toBeLessThan(queue);
    expect(await num("twin-briefing-before-staggered")).toBeLessThan(await num("twin-briefing-before-queue"));
    await expect(briefing.locator("tr[data-metric=staggered] th")).toContainText("With staggered departures");
    await expect(briefing.locator("tr[data-metric=staggered] th")).toContainText("Simulated");

    // The landfill card reads the queue before → after at a glance, labelled simulated.
    const card = page.getByTestId("twin-landfill-metric");
    await expect(card).toBeVisible();
    await expect(card).toContainText("TPA queue · min per truck");
    await expect(page.getByTestId("twin-landfill-tag")).toContainText("Queue data: Simulated");

    // Calm scene: the fleet is drawn only in footage mode, three districts are named.
    const layer = (id) => page.evaluate((layerId) => window.__pythiaTwin.inspectLayer(layerId), id);
    expect(await layer("twin-truck-trails")).toBeNull();
    await expect(page.getByTestId("twin-label")).toHaveCount(3);

    // Provenance prose arrives as clean UTF-8 (no cp1252 mojibake).
    const text = await page.getByTestId("twin-workspace").evaluate((el) => {
      const titles = [...el.querySelectorAll("[title]")].map((n) => n.getAttribute("title"));
      return `${el.textContent} ${titles.join(" ")}`;
    });
    expect(text).not.toContain("â€");
  });

  test("/xr joins its panels into one flush rail with mono provenance", async ({ page }) => {
    await page.goto("/xr?city=jakarta&lang=en");
    await page.waitForFunction(() => window.__pythiaXr && window.__pythiaXr.ready === true, null, {
      timeout: 45000,
    });
    const rail = await page.locator(".xr-overlay").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: r.x, width: r.width, height: r.height, bg: cs.backgroundColor };
    });
    expect(rail.x).toBe(0);
    expect(rail.width).toBeLessThan(480);
    expect(rail.height).toBe(900);
    expect(rail.bg).toBe("rgb(255, 255, 255)");
    // Panels inside the rail are flat sections, not floating cards.
    await expect(page.getByTestId("xr-head")).toHaveCSS("box-shadow", "none");
    await expect(page.getByTestId("xr-head")).toHaveCSS("border-top-left-radius", "0px");
    const chip = page.getByTestId("xr-provenance");
    await expect(chip).toHaveCSS("text-transform", "uppercase");
    expect(await chip.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Geist Mono");
    await expect(page.locator(".xr-kicker")).toHaveCount(0);
    // The capability note still says why AR is off.
    await expect(page.getByTestId("xr-orbit-hint")).toBeVisible();
  });
});
