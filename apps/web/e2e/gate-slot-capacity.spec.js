// #gate-capacity (judge review): the gate-slot view never contradicts staggered arrivals. No slot
// holds more plan trucks than the weighbridges clear in it, each slot shows its modelled wait
// (Model tag; "—" only with a reason), the plan says plainly when the gate is saturated, the
// city-wide 57.1 → 5.6 simulation says it is city-wide, and each gate-queue number names its basis.
import { expect, test } from "@playwright/test";
import { buildAndSubmit, freeDay, signIn } from "./lib/tomorrow.js";

test("tomorrow's gate slots stay within capacity and each shows its modelled wait", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const day = await freeDay(page.request, [3, 6]);
  await signIn(page, { lang: "en", path: `/app/tomorrow?date=${day}` });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
  const plan = await buildAndSubmit(page, day);
  await expect(page.getByTestId("tmr-truck-table")).toBeVisible({ timeout: 60000 });

  // The queue KPI is the city-wide gate model, not this plan's result.
  await expect(page.getByTestId("tmr-kpi-queue").locator("..")).toContainText(
    "with every trip slotted · city-wide gate model",
  );

  await page.getByTestId("tmr-view-gate").click();
  const table = page.getByTestId("tmr-gate-table");
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("data-provenance", "model");
  await expect(table.locator("thead .ui-tag-model")).toHaveCount(0);

  const capacity = plan.gate_capacity;
  const rows = table.getByTestId("tmr-gate-row");
  const more = page.locator(".tmr-more");
  if (await more.count()) await more.click();
  for (const row of await rows.all()) {
    const trucks = (await row.locator("td").nth(1).innerText()).split(", ");
    expect(trucks.length).toBeLessThanOrEqual(capacity.capacity_per_slot);
    const wait = row.getByTestId("tmr-gate-wait");
    const text = (await wait.innerText()).trim();
    if (text === "—") await expect(wait.locator("span")).toHaveAttribute("title", /No modelled wait/);
    else expect(text).toMatch(/^\d+(\.\d)? min$/);
  }
  // Bantargebang slots are modelled: at least one row carries a number.
  await expect(
    table
      .getByTestId("tmr-gate-wait")
      .filter({ hasText: /\d min/ })
      .first(),
  ).toBeVisible();

  const line = page.getByTestId("tmr-gate-capacity");
  if (capacity.overflow_trucks.length || capacity.saturated) {
    await expect(line).toBeVisible();
    await expect(line).toContainText(
      capacity.overflow_trucks.length ? "have no gate slot" : "daily gate arrivals",
    );
  } else {
    await expect(line).toHaveCount(0);
  }
});

// A board whose every slot of the day holds a modelled queue: the slot "now" is always found.
function boardNow() {
  const slots = Array.from({ length: 96 }, (_, index) => {
    const clock = (minutes) =>
      `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    return {
      index,
      date: "2026-10-27",
      start: clock(index * 15),
      end: clock(index * 15 + 15),
      background_load: 40,
      queue_carried_in: 228,
      planned_trucks: ["T-001"],
      expected_wait_min: 89,
    };
  });
  return {
    date: "2026-10-27",
    slot_minutes: 15,
    capacity_per_slot: 30,
    slots,
    recommendations: [],
    impact: null,
    modelled_wait: { mean_per_truck_min: 57.7, classification: "SIMULATED" },
    saturated: false,
    reason: null,
    classification: "SIMULATED",
  };
}

for (const [lang, copy] of [
  [
    "en",
    {
      ops: "per truck, modelled for the slot now",
      queue: "per truck · 228 trucks in the modelled queue now",
      mean: "day mean per truck",
    },
  ],
  [
    "id",
    {
      ops: "per truk, model untuk slot saat ini",
      queue: "per truk · 228 truk dalam antrean model kini",
      mean: "rata-rata sehari per truk",
    },
  ],
]) {
  test(`each gate-queue number names what it is (${lang})`, async ({ page }) => {
    await page.route(/\/api\/gate\/slots(\?|$)/, (route) => route.fulfill({ json: boardNow() }));
    await signIn(page, { lang, path: "/app/operations" });
    const tile = page.getByTestId("kpi-gate");
    await expect(tile.locator(".ui-kpi-sub")).toHaveText(copy.ops, { timeout: 30000 });

    await page.goto("/app/gate", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("gate-kpi-queue")).toContainText(copy.queue, { timeout: 30000 });
  });
}

test("the gate's tomorrow mean says it is the day mean", async ({ page }) => {
  await page.route(/\/api\/gate\/slots(\?|$)/, (route) => route.fulfill({ json: boardNow() }));
  await signIn(page, { lang: "en", path: "/app/gate" });
  await page.getByTestId("gate-day-tomorrow").click();
  await expect(page.getByTestId("gate-kpi-mean")).toContainText("day mean per truck", { timeout: 30000 });
});

// Without a slot board the gate KPI falls back to the queue model's peak hour: its truck count
// is the most queued at that hour, never "now".
test("the gate queue fallback names the modelled peak hour, not now", async ({ page }) => {
  await page.route(/\/api\/gate\/slots(\?|$)/, (route) =>
    route.fulfill({ json: { slots: [], recommendations: [], reason: "no_approved_plan" } }),
  );
  await page.route(/\/api\/tpa\/queue-status/, (route) =>
    route.fulfill({
      json: { avg_wait_minutes: 89, trucks_in_queue: 228, modelled_hour: 9, classification: "SIMULATED" },
    }),
  );
  await signIn(page, { lang: "en", path: "/app/gate" });
  const kpi = page.getByTestId("gate-kpi-queue");
  await expect(kpi).toContainText("up to 228 trucks queued at the modelled peak hour", { timeout: 30000 });
  await expect(kpi).not.toContainText("modelled queue now");
});
