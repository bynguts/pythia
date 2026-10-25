// wave9 fleet composition: the shell nav reads in daily-use order with Settings pinned
// apart, a phone can sign out from the profile menu, and /fleet is one strip of four
// metrics, a large map and a rail (Perlu tindakan · Truk · Antrean TPA) whose numbers
// agree: one denominator, the TPA peak in minutes, one ETA per route.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

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
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
}

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });

// Two of today's work orders, one closed: the trips tile reads "1 dari 2".
async function stubTrips(page) {
  await page.route(/\/api\/spj\?limit=500$/, (route) =>
    route.fulfill({
      json: {
        spj: [
          { spj_id: "e2e-1", spj_number: "SPJ/E2E/1", date: today(), status: "selesai", stops: [] },
          { spj_id: "e2e-2", spj_number: "SPJ/E2E/2", date: today(), status: "aktif", stops: [] },
        ],
        count: 2,
      },
    }),
  );
}

// One deviation decision with a computed route, first in the queue.
const DECISION = {
  id: "ALT-E2E",
  type: "route_deviation",
  severity: "critical",
  truck_code: "T-047",
  title: "T-047 deviated from assigned corridor",
  description: "Truck is 2924 meters from the assigned corridor.",
  distance_meters: 2924,
  sustained: false,
  status: "active",
  recommended_routes: [
    {
      code: "B",
      name: "Route B - Daan Mogot Recovery",
      eta_minutes: 95,
      distance_km: 34.7,
      source: "fallback",
      path: [
        { lat: -6.221, lng: 106.785 },
        { lat: -6.21, lng: 106.81 },
        { lat: -6.195, lng: 106.802 },
      ],
    },
  ],
};

async function stubDecision(page) {
  await page.route(/\/api\/command-center(\?|$)/, async (route) => {
    try {
      const response = await route.fetch();
      const snapshot = await response.json();
      const alerts = snapshot.alerts.filter((alert) => alert.truck_code !== "T-047");
      await route.fulfill({ response, json: { ...snapshot, alerts: [DECISION, ...alerts] } });
    } catch {
      // The sign-in reload can abandon an in-flight snapshot request; the next poll is stubbed.
    }
  });
}

test("the rail lists the workspaces in daily order with Settings pinned below a separator", async ({
  page,
}) => {
  await signIn(page);
  const nav = page.getByTestId("workspace-navigation");
  await expect(nav.getByRole("button")).toHaveText([
    "Armada",
    "Rencana",
    "Prediksi",
    "Sopir",
    "Kota 3D",
    "Pengaturan",
  ]);
  await expect(nav.getByRole("button", { name: "Armada" })).toHaveAttribute("aria-current", "page");
  const separator = nav.getByRole("separator");
  await expect(separator).toHaveCount(1);
  const [twin, line, settings] = await Promise.all([
    nav.getByRole("button", { name: "Kota 3D" }).boundingBox(),
    separator.boundingBox(),
    nav.getByRole("button", { name: "Pengaturan" }).boundingBox(),
  ]);
  expect(line.y).toBeGreaterThanOrEqual(twin.y + twin.height);
  expect(settings.y).toBeGreaterThanOrEqual(line.y);
  // Settings is set apart, not just the next item: at least 16 px between the groups.
  expect(settings.y - (twin.y + twin.height)).toBeGreaterThanOrEqual(16);

  // The twin moved to fifth, but its deep links still land on it.
  await page.goto("/?workspace=twin", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/twin$/);
  await page.goto("/?present=1", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/twin\?present=1$/);
});

test("a phone signs out from the profile menu; Settings lives there, not in the tab bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const tabs = page.locator(".command-mobile-nav");
  await expect(tabs.getByRole("button")).toHaveText(["Armada", "Rencana", "Prediksi", "Sopir", "Kota 3D"]);

  const profile = page.getByTestId("profile-button");
  await expect(profile).toBeVisible();
  const box = await profile.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await profile.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toContainText("Pengatur armada");
  await expect(menu.getByRole("menuitemradio", { name: "Bahasa Indonesia" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await menu.getByRole("menuitem", { name: "Pengaturan" }).click();
  await expect(page).toHaveURL(/\/settings/);
  // The phone's way back to Settings marks itself as the current page.
  await profile.click();
  await expect(page.getByTestId("profile-menu-settings")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);

  await profile.click();
  await page.getByTestId("profile-logout").click();
  await expect(page.locator(".command-shell")).toHaveCount(0);
  const stored = await page.evaluate(() =>
    ["pythia_auth", "pythia_token", "pythia_role"].map((key) => localStorage.getItem(key)),
  );
  expect(stored).toEqual([null, null, null]);
});

test("one strip of four metrics, no duplicate strip, and each number matches its list", async ({ page }) => {
  await stubTrips(page);
  await signIn(page);
  const strip = page.getByTestId("metric-strip");
  const cells = strip.getByTestId("metric-cell");
  await expect(cells).toHaveCount(4, { timeout: 30000 });
  await expect(cells.locator("span")).toHaveText([
    "Truk aktif",
    "Antrean TPA",
    "Deviasi terbuka",
    "Ritase selesai",
  ]);
  await expect(page.locator(".fleet-problem-strip, [data-testid^=problem-chip]")).toHaveCount(0);
  await expect(page.getByTestId("metric-strip")).toHaveCount(1);

  // One denominator: "52 aktif / 59 unit", the same total as the truck list.
  const active = strip.locator('[data-metric="active"] strong');
  await expect(active).toHaveText(/^\d+ aktif \/ \d+ unit$/);
  const [, activeCount, total] = /^(\d+) aktif \/ (\d+) unit$/.exec(await active.innerText());

  // The TPA tile is the modelled peak in minutes, never "89m".
  const queue = strip.locator('[data-metric="queue"]');
  await expect(queue.locator("strong")).toHaveText(/^Puncak \d{2}[.:]\d{2}: ±\d+ mnt$/);
  await expect(queue).not.toContainText(/\d+m\b/);
  await expect(strip.locator('[data-metric="trips"] strong')).toHaveText("1 dari 2");

  await strip.locator('[data-metric="active"]').click();
  await expect(page.getByRole("tab", { name: "Truk" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("truck-filter-all").locator("b")).toHaveText(total);
  await expect(page.getByTestId("truck-filter-active").locator("b")).toHaveText(activeCount);
  await expect(page.getByTestId("truck-filter-active")).toHaveAttribute("aria-pressed", "true");

  // F3: "Di bengkel N" lists exactly N trucks.
  const workshop = page.getByTestId("truck-filter-workshop");
  const shown = Number(await workshop.locator("b").innerText());
  await workshop.click();
  if (shown > 12) await page.getByRole("button", { name: `Tampilkan semua (${shown})` }).click();
  await expect(page.getByTestId("truck-row")).toHaveCount(shown);

  // The deviation tile opens the work queue and agrees with the off-route filter.
  const deviations = await strip.locator('[data-metric="deviation"] strong').innerText();
  await expect(page.getByTestId("truck-filter-deviation").locator("b")).toHaveText(deviations);
  await strip.locator('[data-metric="deviation"]').click();
  await expect(page.getByRole("tab", { name: /Perlu tindakan/ })).toHaveAttribute("aria-selected", "true");
});

test("the work queue lives in Perlu tindakan, the layers panel holds layers only", async ({ page }) => {
  await stubDecision(page);
  await signIn(page);
  const actionTab = page.getByRole("tab", { name: /Perlu tindakan/ });
  await expect(actionTab).toHaveAttribute("aria-selected", "true");
  const rail = page.getByTestId("fleet-rail-action");
  await expect(rail.getByTestId("action-queue")).toBeVisible();
  const first = rail.getByTestId("action-row").first();
  await expect(first).toContainText("T-047 keluar dari koridor tugas");
  await expect(first.getByTestId("action-card-button")).toHaveText("Kirim rute ke sopir");
  // One primary action per view.
  await expect(page.getByTestId("fleet-rail").locator(".action-card-button:visible")).toHaveCount(1);
  await expect(rail.getByTestId("astar-panel")).toBeVisible();

  await page.getByTestId("deck-tools-toggle").click();
  const layers = page.getByTestId("deck-tools-panel");
  await expect(layers.getByRole("checkbox")).toHaveCount(3);
  await expect(layers.locator("[data-testid=action-queue], [data-testid=astar-panel], select")).toHaveCount(
    0,
  );
});

test("a truck row opens its drawer in place, with Sekarang and Riwayat", async ({ page }) => {
  await signIn(page);
  await page.getByRole("tab", { name: "Truk" }).click();
  const row = page.getByTestId("truck-row").first();
  await expect(row).toBeVisible({ timeout: 30000 });
  const code = await row.getAttribute("data-truck");
  await row.click();
  const drawer = page.getByTestId("truck-drawer");
  await expect(drawer.locator("#truck-drawer-title")).toContainText(code);
  await expect(page.getByTestId("truck-drawer-now")).toHaveAttribute("aria-pressed", "true");
  for (const section of ["drawer-route", "drawer-spj", "drawer-damage", "drawer-safety"]) {
    await expect(drawer.getByTestId(section)).toBeVisible();
  }
  await page.getByTestId("truck-drawer-history").click();
  await expect(drawer.getByTestId("history-record-note")).toContainText("REKONSTRUKSI MODEL");
  await page.getByTestId("truck-drawer-close").click();
  await expect(page.getByTestId("truck-list")).toBeVisible();

  await page.getByRole("tab", { name: "Antrean TPA" }).click();
  await expect(page.getByTestId("fleet-queue-surface").getByTestId("tpa-queue-panel")).toBeVisible();
});

test("a decision has one route: one name, one ETA, drawn only while it is selected", async ({ page }) => {
  await stubDecision(page);
  await signIn(page);
  const rail = page.getByTestId("fleet-rail-action");
  await expect(rail.getByTestId("decision-route-name").first()).toHaveText(
    "Rute B · pemulihan via Daan Mogot",
  );
  await expect(rail.getByTestId("decision-route-eta").first()).toHaveText("ETA 95 mnt · 34,7 km");
  const card = page.getByTestId("map-route-card");
  await expect(card).toContainText("Rute B · pemulihan via Daan Mogot");
  await expect(card.getByTestId("map-route-eta")).toHaveText("ETA 95 mnt · 34,7 km");
  await expect(card).toContainText("rute cadangan (offline)");
  const text = await page.getByTestId("fleet-workspace").innerText();
  expect(text.match(/\bETA \d+ mnt/g)).toEqual(["ETA 95 mnt", "ETA 95 mnt"]);

  // Collapsing the decision removes its line and card from the map.
  await rail.getByTestId("action-row").first().locator(".action-row-head").click();
  await expect(card).toHaveCount(0);
});

test("the Indonesian /fleet shows no English backend prose or engineering jargon", async ({ page }) => {
  await stubDecision(page);
  await signIn(page);
  await expect(page.getByTestId("action-queue")).toBeVisible({ timeout: 30000 });
  // Scan the live (stubbed) snapshot, not the offline sample shown while it loads.
  await expect(page.getByTestId("decision-route-eta").first()).toHaveText("ETA 95 mnt · 34,7 km", {
    timeout: 30000,
  });
  const leaks =
    /deviated|Hauling|Maintenance hold|Recovery|Route [ABC]\b|Confidence|Auto-detected|OSRM|A\*|auto_reroute|\bseed\b|real-time/;
  const scan = async () => {
    const text = await page.locator(".command-main").innerText();
    expect(text).not.toMatch(leaks);
  };
  await scan();
  await page.getByRole("tab", { name: "Truk" }).click();
  await scan();
  await page.getByTestId("truck-row").first().click();
  await scan();
  await page.getByTestId("deck-tools-toggle").click();
  await scan();
});

for (const width of [320, 390]) {
  test(`at ${width} px the page never scrolls sideways and the rail sits under the map`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await stubDecision(page);
    await signIn(page);
    await expect(page.getByTestId("map-route-card")).toBeVisible({ timeout: 30000 });
    const geometry = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const stage = box("[data-testid=fleet-map-stage]");
      const rail = box("[data-testid=fleet-rail]");
      // Nothing covers the route card or the legend toggle.
      const covered = ["[data-testid=map-route-card]", "[data-testid=map-legend] > summary"].filter(
        (selector) => {
          const el = document.querySelector(selector);
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !el.contains(hit);
        },
      );
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        railBelowMap: rail.top >= stage.bottom - 1,
        covered,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.railBelowMap).toBe(true);
    expect(geometry.covered).toEqual([]);
    for (const tab of await page.getByRole("tab").all()) {
      const tabBox = await tab.boundingBox();
      if (!tabBox) continue;
      expect(tabBox.height).toBeGreaterThanOrEqual(44);
    }
  });
}

// Lead visual review: at desktop widths every rail tab fits the rail, the legend starts
// folded, and the first view frames the fleet instead of a few trucks in a corner.
for (const width of [1280, 1440]) {
  test(`at ${width} px the rail tabs fit, the legend is folded and the fleet is framed`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await expect(page.locator("[data-metric=queue]")).toBeVisible({ timeout: 60000 });

    const legend = page.getByTestId("map-legend");
    await expect(legend).not.toHaveAttribute("open", "");
    await legend.locator("summary").click();
    const legendFits = await page.evaluate(() => {
      const body = document.querySelector("[data-testid=map-legend] .map-key-body").getBoundingClientRect();
      const stage = document.querySelector("[data-testid=fleet-map-stage]").getBoundingClientRect();
      return body.bottom <= stage.bottom;
    });
    expect(legendFits).toBe(true);
    await legend.locator("summary").click();

    for (const tab of ["Perlu tindakan", "Truk", "Antrean TPA"]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(tab === "Antrean TPA" ? 2500 : 500);
      const overflow = await page.evaluate(() => {
        const panel = document.querySelector(".fleet-rail .rail-panel");
        const edge = panel.getBoundingClientRect().right;
        const wide = [...panel.querySelectorAll("*")].filter((el) => {
          if (el.closest(".table-wrap")) return false; // tables scroll inside their own frame
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > edge + 1;
        });
        return { scroll: panel.scrollWidth - panel.clientWidth, wide: wide.length };
      });
      expect(overflow, `${tab} overflows the rail`).toEqual({ scroll: 0, wide: 0 });
    }

    // The first view holds the visible trucks: most markers sit inside the map, not a corner.
    const framing = await page.evaluate(() => {
      const stage = document.querySelector("[data-testid=fleet-map-stage]").getBoundingClientRect();
      const markers = [...document.querySelectorAll(".truck-marker")].map((m) => m.getBoundingClientRect());
      const inside = markers.filter(
        (r) =>
          r.left >= stage.left && r.right <= stage.right && r.top >= stage.top && r.bottom <= stage.bottom,
      );
      const xs = inside.map((r) => r.left);
      return {
        total: markers.length,
        inside: inside.length,
        spread: xs.length ? (Math.max(...xs) - Math.min(...xs)) / stage.width : 0,
      };
    });
    expect(framing.total).toBeGreaterThan(5);
    expect(framing.inside / framing.total).toBeGreaterThan(0.8);
    expect(framing.spread).toBeGreaterThan(0.3);
  });
}
