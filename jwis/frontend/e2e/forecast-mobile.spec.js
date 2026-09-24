import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #71: the Forecast workspace must not force page-level horizontal overflow
// from 320px through tablet widths; wide prediction data stays inside a
// contained scroller.
async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", lang);
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, { ...principal, lang });
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function openForecast(page) {
  // Works across sidebar (desktop) and bottom-bar (mobile) navigation.
  const forecastButton = page.getByRole("button", { name: "Prediksi", exact: true });
  await forecastButton.click();
  await expect(page.getByTestId("forecast-workspace")).toBeVisible();
  await expect(page.locator(".kec-row").first()).toBeVisible({ timeout: 20000 });
}

test("forecast never overflows the page at mobile and tablet widths", async ({ page }) => {
  await signIn(page);
  for (const width of [320, 375, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await openForecast(page);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `page overflows at ${width}px: ${overflow.scrollWidth} > ${overflow.clientWidth}`)
      .toBeLessThanOrEqual(overflow.clientWidth);
  }
});
