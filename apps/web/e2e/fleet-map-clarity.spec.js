// wave9 map clarity: an SPJ route numbers only its planned stops, the waste-levy
// registry is off until asked for, a localized legend explains the layers, and
// the map chrome never overlaps on a phone.
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
      id: "ALT-CLARITY",
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
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pythiaSpjMap?.routes === 2, null, { timeout: 30000 });
  const spj = await page.evaluate(() => window.__pythiaSpjMap);
  const labels = spj.stopLabels.map(Number);
  // 5 stops + 30 stops capped at 12, never one label per road vertex.
  expect(labels.length).toBe(5 + 12);
  expect(Math.max(...labels)).toBe(12);
  expect(labels.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  expect(spj.destinations).toBe(2);
});

test("the waste-levy registry layer is hidden until switched on", async ({ page }) => {
  await signIn(page);
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__pythiaMap?.getLayer?.("wr-clusters")), null, {
    timeout: 30000,
  });
  const visibility = () =>
    page.evaluate(() =>
      ["wr-clusters", "wr-cluster-count", "wr-unclustered-point"].map((id) =>
        window.__pythiaMap.getLayoutProperty(id, "visibility"),
      ),
    );
  expect(await visibility()).toEqual(["none", "none", "none"]);
  const legend = page.getByTestId("map-legend");
  await expect(legend.locator('[data-layer="wr"]')).toHaveCount(0);

  await page.getByTestId("deck-tools-toggle").click();
  await page.getByTestId("deck-tools-panel").getByLabel("Usaha wajib retribusi sampah").check();
  await expect.poll(visibility).toEqual(["visible", "visible", "visible"]);
  await expect(legend.locator('[data-layer="wr"]')).toHaveCount(1);
});

test("the legend explains the default layers in both languages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubRoutes(page);
  await signIn(page, "id");
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
  // The decision route (and its legend row) comes with the live snapshot, not the offline sample.
  await expect(page.getByTestId("map-route-card")).toBeVisible({ timeout: 30000 });
  const summary = page.getByTestId("map-legend").locator("summary");
  await expect(summary).toHaveAttribute("aria-label", "Legenda peta");
  // Folded on a phone, one tap away.
  await expect(page.getByTestId("map-legend")).not.toHaveAttribute("open", "");
  await summary.click();
  const body = page.getByTestId("map-legend").locator(".map-key-body");
  await expect(body).toBeVisible();
  for (const text of ["Truk sesuai rute", "Truk keluar koridor", "Rute SPJ aktif", "Titik angkut SPJ"]) {
    await expect(body).toContainText(text);
  }
  await expect(body).toContainText("Rute usulan (keputusan terpilih)");
  // One fleet denominator everywhere (shown of total, then active / total units).
  await expect(page.getByTestId("map-fleet-denominator")).toHaveText(
    /^\d+ dari (\d+) ditampilkan · \d+ aktif \/ \1 unit$/,
  );
  const card = page.getByTestId("map-route-card");
  await expect(card).toContainText("Rute B · pemulihan via Daan Mogot");
  await expect(card).toContainText("mnt");
  await expect(card).not.toContainText("Recovery");

  await page.evaluate(() => localStorage.setItem("pythia_lang", "en"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("map-legend").locator("summary")).toHaveAttribute("aria-label", "Map legend");
  await page.getByTestId("map-legend").locator("summary").click();
  await expect(page.getByTestId("map-legend")).toContainText("Active SPJ route");
  await expect(page.getByTestId("map-route-card")).toContainText("Route B · recovery via Daan Mogot", {
    timeout: 30000,
  });
});

for (const width of [390, 320]) {
  test(`map chrome does not overlap at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await stubRoutes(page);
    await signIn(page);
    await page.goto("/fleet", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("map-route-card")).toBeVisible({ timeout: 30000 });
    await expect(page.locator(".map-data-notice")).toContainText("Data simulasi");
    await expect(page.locator(".maplibregl-ctrl-top-right .map-reset-btn")).toBeVisible();

    const boxes = await page.evaluate(() => {
      const selectors = {
        notice: ".map-data-notice",
        search: ".map-search",
        legend: "[data-testid=map-legend] > summary",
        routeCard: "[data-testid=map-route-card]",
        layers: "[data-testid=deck-tools-toggle]",
        controls: ".maplibregl-ctrl-top-right",
      };
      const out = {};
      for (const [name, selector] of Object.entries(selectors)) {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        if (box) out[name] = { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
      }
      const stage = document.querySelector("[data-testid=fleet-map-stage]").getBoundingClientRect();
      return { out, stage: { x: stage.x, right: stage.right } };
    });
    expect(Object.keys(boxes.out).sort()).toEqual(
      ["controls", "layers", "legend", "notice", "routeCard", "search"].sort(),
    );
    const names = Object.keys(boxes.out);
    for (let i = 0; i < names.length; i += 1) {
      const a = boxes.out[names[i]];
      expect(a.x, `${names[i]} starts inside the map`).toBeGreaterThanOrEqual(boxes.stage.x - 1);
      expect(a.right, `${names[i]} ends inside the map`).toBeLessThanOrEqual(boxes.stage.right + 1);
      for (let j = i + 1; j < names.length; j += 1) {
        const b = boxes.out[names[j]];
        const overlap = a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;
        expect(overlap, `${names[i]} ${JSON.stringify(a)} overlaps ${names[j]} ${JSON.stringify(b)}`).toBe(
          false,
        );
      }
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
