// wave11 fleet: /fleet is the approved desk (docs/design/export/app-fleet.png): an
// edge-to-edge metric strip whose numbers carry mono provenance labels, a left work rail
// of one-line rows under a single tab header (repeat driver reports grouped), a full-bleed
// map with a legend pill and a mono provenance chip, and the staggered-dispatch figures at
// the rail's foot, which the strip's queue tile headlines.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
}

test("the strip runs edge to edge, the rail sits left and the map runs to the right edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const strip = page.getByTestId("metric-strip");
  await expect(strip.locator("[data-metric=queue]")).toBeVisible({ timeout: 30000 });

  const geometry = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const labels = [...document.querySelectorAll("[data-testid=metric-cell] .prov")].map((el) => {
      const style = getComputedStyle(el);
      return { mono: /Geist Mono|monospace/i.test(style.fontFamily), upper: style.textTransform };
    });
    return {
      width: innerWidth,
      strip: box("[data-testid=metric-strip]").toJSON(),
      rail: box("[data-testid=fleet-rail]").toJSON(),
      stage: box("[data-testid=fleet-map-stage]").toJSON(),
      labels,
    };
  });
  expect(geometry.strip.left).toBeLessThanOrEqual(1);
  expect(geometry.strip.right).toBeGreaterThanOrEqual(geometry.width - 1);
  // Every number keeps its provenance, drawn as an 11 px uppercase mono label.
  expect(geometry.labels.length).toBeGreaterThanOrEqual(3);
  for (const label of geometry.labels) expect(label).toEqual({ mono: true, upper: "uppercase" });
  expect(geometry.rail.left).toBeLessThanOrEqual(1);
  expect(geometry.stage.left).toBeGreaterThanOrEqual(geometry.rail.right - 1);
  expect(geometry.stage.right).toBeGreaterThanOrEqual(geometry.width - 1);
  // The desk fills the viewport under the strip: the map's bottom edge is not below the fold.
  expect(geometry.stage.bottom).toBeLessThanOrEqual(900 + 1);

  // The map's provenance is one mono chip at the bottom of the map, the legend a pill on top.
  const chip = page.getByTestId("map-provenance");
  await expect(chip).toContainText("Data simulasi");
  const [chipBox, stageBox] = await Promise.all([
    chip.boundingBox(),
    page.getByTestId("fleet-map-stage").boundingBox(),
  ]);
  expect(chipBox.y).toBeGreaterThan(stageBox.y + stageBox.height / 2);
  await expect(page.getByTestId("map-legend").locator(".map-key-peek")).toBeVisible();
});

test("one rail header, rows in one line, and the queue tile names the rail foot's statistic", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const rail = page.getByTestId("fleet-rail-action");
  await expect(rail.getByTestId("action-row").first()).toBeVisible({ timeout: 30000 });

  // One header: a single tab control, no second row of filter pills.
  await expect(page.getByTestId("fleet-rail").getByRole("tablist")).toHaveCount(1);
  await expect(page.locator("[data-testid^=attention-filter]")).toHaveCount(0);

  // One line of title and one of meta per row on desktop.
  const tall = await rail.evaluate((root) =>
    [...root.querySelectorAll(".ui-row .ui-row-title, .ui-row .ui-row-meta")]
      .filter((el) => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 1.5)
      .map((el) => el.textContent),
  );
  expect(tall).toEqual([]);

  // The modelled TPA peak is one row of work, labelled simulated, that opens the queue tab.
  const queueRow = rail.getByTestId("attention-queue-row");
  await expect(queueRow).toContainText("Puncak antrean TPA", { timeout: 30000 });
  await expect(queueRow).toContainText("SIMULASI");
  await queueRow.getByRole("button", { name: "Atur keberangkatan bertahap" }).click();
  await expect(page.getByTestId("fleet-queue-surface")).toBeVisible();

  // The stagger foot hides on the queue tab (the full panel is there) and returns elsewhere.
  await expect(page.getByTestId("fleet-stagger-summary")).toHaveCount(0);
  await page.getByRole("tab", { name: /Perlu tindakan/ }).click();
  const foot = page.getByTestId("fleet-stagger-summary");
  await expect(foot.locator("strong")).toHaveCount(2, { timeout: 30000 });
  await expect(page.getByTestId("fleet-stagger-provenance")).toContainText("Simulasi");

  // The strip headlines the staggered day mean and quotes the unstaggered one, the same pair
  // (and the same basis) as the rail foot.
  const [before, after] = await foot.locator("strong").allTextContents();
  const tile = page.locator('[data-metric="queue"]');
  await expect(tile.locator("strong")).toHaveText(`${after} mnt/truk`);
  await expect(tile.locator(".metric-meta")).toContainText(`Rata-rata sehari, tanpa penjadwalan ${before}`);
  await expect(tile.locator(".prov")).toHaveText("Simulasi · antre timbang, hari normal · bertahap");
});

test("repeat driver reports are one row with a count; Tandai ditangani sits beside Hubungi sopir", async ({
  page,
}) => {
  const at = (min) => new Date(Date.now() - min * 60000).toISOString();
  await page.route("**/api/driver/exceptions*", (route) =>
    route.fulfill({
      json: {
        exceptions: [
          {
            exception_id: "EXC-W11-A",
            truck_code: "T-901",
            kind: "road_closed",
            note: "jalan ditutup",
            reported_at: at(30),
          },
          {
            exception_id: "EXC-W11-B",
            truck_code: "T-901",
            kind: "road_closed",
            note: "masih ditutup",
            reported_at: at(5),
          },
          {
            exception_id: "EXC-W11-C",
            truck_code: "T-901",
            kind: "road_closed",
            note: "ditutup",
            reported_at: at(15),
          },
          {
            exception_id: "EXC-W11-D",
            truck_code: "T-902",
            kind: "accident",
            note: "tabrakan ringan",
            reported_at: at(10),
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const rows = page.getByTestId("driver-exception-row");
  await expect(rows).toHaveCount(2, { timeout: 30000 });

  // The accident leads; the three closures are one row showing the latest report.
  await expect(rows.first()).toHaveAttribute("data-kind", "accident");
  const closed = page.locator('[data-exception-id="EXC-W11-B"]');
  await expect(closed).toHaveAttribute("data-exception-ids", "EXC-W11-B EXC-W11-C EXC-W11-A");
  await expect(closed.locator(".attn-repeat")).toHaveText("×3");
  await expect(closed).toContainText("masih ditutup");
  await expect(closed).not.toContainText("EXC-W11");

  // Both actions share one action line (it may wrap in the narrow rail); the quiet one is
  // an outlined pill inside a 44 px target, never bare text.
  const actions = closed.locator(".attn-actions");
  await expect(actions.getByRole("button", { name: "Hubungi sopir" })).toBeVisible();
  const handled = actions.getByRole("button", { name: "Tandai ditangani" });
  expect((await handled.boundingBox()).height).toBeGreaterThanOrEqual(44);
  const pill = await handled.evaluate((el) => getComputedStyle(el, "::before").borderTopWidth);
  expect(pill).toBe("1px");
});
