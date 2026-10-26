// wave9 map clarity, wave 13 Operations: an SPJ route numbers only its planned stops, the
// reference layers stay off on the Operations map, the one-line legend explains what is
// drawn in both languages, and the floating map chrome never overlaps.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

function stop(i) {
  return { name: `TPS Uji ${i + 1}`, lat: -6.2 + i * 0.004, lng: 106.8 + i * 0.004, status: "pending" };
}

function activeSpj(number, truck, stopCount) {
  return {
    spj_id: `spj-${truck}`,
    spj_number: number,
    truck_code: truck,
    driver_name: "Pengemudi Uji",
    destination: "TPST Bantargebang",
    status: "aktif",
    route_point_count: 1500,
    stops: Array.from({ length: stopCount }, (_, i) => stop(i)),
  };
}

// Road geometry with 1,500 vertices: the shape that used to be drawn as 1,499 numbered stops.
function roadPath() {
  return Array.from({ length: 1500 }, (_, i) => ({ lat: -6.2 - i * 0.00008, lng: 106.8 + i * 0.00012 }));
}

async function signIn(page, lang = "id") {
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

async function stubRoutes(page) {
  await page.route(/\/api\/spj\?status=aktif/, (route) =>
    route.fulfill({
      json: {
        spj: [activeSpj("SPJ/UJI/1", "T-901", 5), activeSpj("SPJ/UJI/2", "T-902", 30)],
        count: 2,
      },
    }),
  );
  await page.route(/\/api\/spj\/active-path\//, (route) =>
    route.fulfill({ json: { has_active_spj: true, has_reference_path: true, path: roadPath() } }),
  );
  // wave9 fleet composition: the map no longer fetches /routes/osrm on its own; it draws
  // the route of the selected decision, so the stub injects one decision (first in queue).
  await page.route(/\/api\/command-center(\?|$)/, async (route) => {
    let response;
    let snapshot;
    try {
      response = await route.fetch();
      snapshot = await response.json();
    } catch {
      return; // the sign-in reload abandoned this request; the next poll is stubbed
    }
    const decision = {
      id: "ALT-T-047",
      type: "route_deviation",
      severity: "critical",
      truck_code: "T-047",
      title: "T-047 deviated from assigned corridor",
      description: "Truck is 2924 meters from the assigned corridor.",
      distance_meters: 2924,
      status: "active",
      recommended_routes: [
        {
          code: "B",
          name: "Route B - Daan Mogot Recovery",
          source: "osrm",
          eta_minutes: 6,
          distance_km: 5.1,
          path: [
            { lat: -6.221, lng: 106.785 },
            { lat: -6.195, lng: 106.802 },
          ],
        },
      ],
    };
    const alerts = snapshot.alerts.filter((alert) => alert.truck_code !== "T-047");
    await route.fulfill({ response, json: { ...snapshot, alerts: [decision, ...alerts] } });
  });
}

test("an SPJ route numbers only its planned stops, capped per SPJ", async ({ page }) => {
  await stubRoutes(page);
  await signIn(page);
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pythiaSpjMap?.routes === 2, null, { timeout: 30000 });
  const spj = await page.evaluate(() => window.__pythiaSpjMap);
  const labels = spj.stopLabels.map(Number);
  // 5 stops + 30 stops capped at 12, never one label per road vertex.
  expect(labels.length).toBe(5 + 12);
  expect(Math.max(...labels)).toBe(12);
  expect(labels.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  expect(spj.destinations).toBe(2);
});

// wave 13: the Operations map shows the fleet and its decisions; the registry, TPS and
// heat layers stay off and the legend never explains a hidden layer.
test("the reference layers stay off on the Operations map", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
  const visibility = () =>
    page.evaluate(() =>
      ["wr-clusters", "wr-unclustered-point", "tps-layer", "kelurahan-heatmap-fill"].map((id) =>
        window.__pythiaMap?.getLayer(id) ? window.__pythiaMap.getLayoutProperty(id, "visibility") : "missing",
      ),
    );
  await expect.poll(visibility, { timeout: 30000 }).toEqual(["none", "none", "none", "none"]);
  const legend = page.getByTestId("map-legend");
  await expect(legend.locator('[data-layer="wr"], [data-layer="tps"]')).toHaveCount(0);
  await expect(page.getByTestId("deck-tools-toggle")).toHaveCount(0);
});

test("the legend explains the drawn layers in both languages", async ({ page }) => {
  await stubRoutes(page);
  await signIn(page);
  await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
  const legend = page.getByTestId("map-legend");
  await expect(legend.locator('[data-layer="osrm"]')).toHaveText("Rute usulan", { timeout: 30000 });
  await expect(legend.locator('[data-layer="corridor"]')).toHaveText("Koridor rencana");
  await expect(legend).toHaveAttribute("aria-label", "Legenda peta");
  await expect(page.getByTestId("map-fleet-denominator")).toHaveText(/^\d+ dari \d+ ditampilkan$/);
  await expect(page.getByTestId("decision-route-name")).toContainText("Rute B · pemulihan via Daan Mogot");
  await expect(page.getByTestId("decision-route-name")).not.toContainText("Recovery");

  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-lang-en").click();
  await expect(legend.locator('[data-layer="osrm"]')).toHaveText("Suggested route");
  await expect(legend).toHaveAttribute("aria-label", "Map legend");
  await expect(page.getByTestId("decision-route-name")).toContainText("Route B · recovery via Daan Mogot");
  await expect(page.getByTestId("map-gps-soon")).toHaveText(/Coming soon\s*Live GPS tracking/);
});

const CHROME = {
  soon: "[data-testid=map-gps-soon]",
  zoom: ".ops-map-zoom",
  legend: "[data-testid=map-legend]",
  needs: "[data-testid=needs-you]",
  gate: ".ops-corner",
};

for (const [width, height, inside] of [
  [1440, 960, ["soon", "zoom", "legend", "needs", "gate"]],
  [390, 844, ["soon", "zoom", "legend"]],
  [320, 700, ["soon", "zoom", "legend"]],
]) {
  test(`map chrome does not overlap at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await stubRoutes(page);
    await signIn(page);
    await page.goto("/app/operations", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid=map-legend] [data-layer="osrm"]')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator(".truck-marker[data-provenance=simulated]").first()).toBeVisible();

    const boxes = await page.evaluate((selectors) => {
      const out = {};
      for (const [name, selector] of Object.entries(selectors)) {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        if (box) out[name] = { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
      }
      const stage = document.querySelector("[data-testid=fleet-map-stage]").getBoundingClientRect();
      return { out, stage: { x: stage.x, y: stage.y, right: stage.right, bottom: stage.bottom } };
    }, CHROME);
    expect(Object.keys(boxes.out).sort()).toEqual(Object.keys(CHROME).sort());
    for (let i = 0; i < inside.length; i += 1) {
      const a = boxes.out[inside[i]];
      expect(a.x, `${inside[i]} starts inside the map`).toBeGreaterThanOrEqual(boxes.stage.x - 1);
      expect(a.right, `${inside[i]} ends inside the map`).toBeLessThanOrEqual(boxes.stage.right + 1);
      expect(a.bottom, `${inside[i]} ends above the map's foot`).toBeLessThanOrEqual(boxes.stage.bottom + 1);
      for (let j = i + 1; j < inside.length; j += 1) {
        const b = boxes.out[inside[j]];
        const overlap = a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;
        expect(overlap, `${inside[i]} ${JSON.stringify(a)} overlaps ${inside[j]} ${JSON.stringify(b)}`).toBe(
          false,
        );
      }
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
