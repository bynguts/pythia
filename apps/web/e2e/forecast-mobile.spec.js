import { expect, test } from "@playwright/test";
import { API, freeDay, signIn } from "./lib/tomorrow.js";

// #71: the Tomorrow page never forces page-level horizontal overflow from 320 px to
// the 1024 px console minimum, with a built plan on screen; the allocation table scrolls
// inside its own wrap.
test("tomorrow never overflows the page at mobile and tablet widths", async ({ page }) => {
  test.setTimeout(180000);
  const day = await freeDay(page.request, [4, 5]);
  const token = await signIn(page, { lang: "id" });
  const built = await page.request.post(
    `${API}/operations/plan?plan_date=${day}&auto_inputs=true&top_n=42&draft=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(built.ok()).toBeTruthy();
  for (const width of [320, 375, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/app/tomorrow?date=${day}`);
    await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId("tmr-truck-table")).toBeVisible({ timeout: 30000 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `page overflows at ${width}px: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
    ).toBeLessThanOrEqual(overflow.clientWidth);
  }
});
