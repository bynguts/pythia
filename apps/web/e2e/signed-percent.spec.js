// #v3-9 (teardown v3 §9), Tomorrow: percentages carry their own sign. A change that
// rounds to zero prints "0%", a fall prints "−2%", never "+0%" or "+-2%", in the forecast's
// change against today and in "Why it moved".
import { expect, test } from "@playwright/test";
import { signIn } from "./lib/tomorrow.js";

async function stub(page, { today, tomorrow, rainEffect }) {
  await page.route("**/api/forecast/tomorrow?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const totals = [...body.horizon.daily_total_tons];
    totals[body.day - 1] = today;
    totals[body.day] = tomorrow;
    body.horizon.daily_total_tons = totals;
    body.normal_day_tonnage_t = 1000;
    body.drivers = [
      {
        kind: "weather",
        detail: { rainfall_mm: 4 },
        effect_tons: rainEffect,
        input_classification: "REAL_FORECAST_INPUT",
      },
      { kind: "weekday", detail: { weekend: false }, effect_tons: null },
    ];
    await route.fulfill({ response, json: body });
  });
}

test("a change that rounds to zero prints 0%, never +0%", async ({ page }) => {
  await stub(page, { today: 8000, tomorrow: 8000.01, rainEffect: 0.0001 });
  await signIn(page, { path: "/app/tomorrow" });
  await expect(page.getByTestId("tmr-forecast-delta")).toHaveText(/^0% vs today · \d+ districts$/, {
    timeout: 60000,
  });
  await expect(page.locator("[data-kind=weather] .tmr-why-effect")).toHaveText("0%");
  await expect(page.getByTestId("tmr-forecast")).not.toContainText("+0");
});

test("falls and rises print their own sign once", async ({ page }) => {
  await stub(page, { today: 8000, tomorrow: 7840, rainEffect: 85 });
  await signIn(page, { path: "/app/tomorrow" });
  await expect(page.getByTestId("tmr-forecast-delta")).toHaveText(/^−2% vs today/, { timeout: 60000 });
  await expect(page.locator("[data-kind=weather] .tmr-why-effect")).toHaveText("+8.5%");
  await expect(page.getByTestId("tmr-forecast")).not.toContainText("+-");
  await expect(page.getByTestId("tmr-forecast")).not.toContainText("+−");
});
