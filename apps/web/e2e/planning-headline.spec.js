// Tomorrow: "Why it moved" lists only the drivers the forecast filled in by itself and
// says honestly what is not modelled: an event without a location is "not modelled", a
// holiday's effect is "—" (not 0%), a dry day is no rain, never a made-up uplift.
import { expect, test } from "@playwright/test";
import { signIn } from "./lib/tomorrow.js";

const COPY = {
  en: { dry: "No rain forecast", none: "not modelled", holiday: "Hari Pahlawan" },
  id: { dry: "Tidak ada prakiraan hujan", none: "tidak dimodelkan", holiday: "Hari Pahlawan" },
};

for (const lang of ["en", "id"]) {
  test(`why it moved names unmodelled drivers honestly (${lang})`, async ({ page }) => {
    const copy = COPY[lang];
    await page.route("**/api/forecast/tomorrow?*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.drivers = [
        {
          kind: "weather",
          detail: { rainfall_mm: 0 },
          effect_tons: 0,
          source: "open-meteo",
          input_classification: "REAL_FORECAST_INPUT",
        },
        {
          kind: "event",
          detail: { name: "Konser Stadion", attendance: 50000, data_class: "official" },
          effect_tons: null,
          effect_reason: "location_unknown",
        },
        { kind: "holiday", detail: { name: "Hari Pahlawan" }, effect_tons: null },
        { kind: "weekday", detail: { weekend: false }, effect_tons: null },
      ];
      await route.fulfill({ response, json: body });
    });
    await signIn(page, { lang, path: "/app/tomorrow" });
    const drivers = page.getByTestId("plan-drivers");
    await expect(drivers).toBeVisible({ timeout: 60000 });
    const rows = page.getByTestId("plan-driver");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute("data-kind", "weather");
    await expect(rows.nth(0)).toContainText(copy.dry);
    await expect(rows.nth(0).locator(".tmr-why-effect")).toHaveText("0%");
    await expect(rows.nth(1)).toContainText("Konser Stadion");
    await expect(rows.nth(1).locator(".tmr-why-effect")).toHaveText(copy.none);
    await expect(rows.nth(2)).toHaveAttribute("data-kind", "holiday");
    await expect(rows.nth(2)).toContainText(copy.holiday);
    await expect(rows.nth(2).locator(".tmr-why-effect")).toHaveText("—");
    await expect(drivers).not.toContainText("+0");
  });
}
