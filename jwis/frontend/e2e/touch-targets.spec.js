import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #31: primary app and map controls provide at least a 44x44 hit area on
// mobile (390px) and tablet (768px) without horizontal overflow.
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

const MIN = 44;

test("primary controls meet the 44x44 touch target at 390 and 768px", async ({ page }) => {
  await signIn(page);
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Prediksi", exact: true }).click();
    await expect(page.getByTestId("forecast-workspace")).toBeVisible();
    await expect(page.locator(".kec-row").first()).toBeVisible({ timeout: 20000 });

    const failures = await page.evaluate((min) => {
      const out = [];
      // Representative interactive controls in the shell + forecast surfaces.
      const selectors = [
        ".command-mobile-nav button",
        ".lang-switch button",
        ".kec-row",
        ".scenario-controls .primary-button",
        ".kec-map .maplibregl-ctrl-group button",
        ".kec-map .maplibregl-ctrl button",
        ".search-input",
        ".city-select",
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const r = el.getBoundingClientRect();
          const visible = r.width > 0 && r.height > 0;
          const style = getComputedStyle(el);
          const displayed = style.display !== "none" && style.visibility !== "hidden";
          if (visible && displayed && (r.height < min || r.width < min)) {
            out.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        });
      }
      return out;
    }, MIN);

    expect(failures, `controls below ${MIN}px at viewport ${width}: ${failures.join(", ")}`).toEqual([]);

    // Larger hit areas must not reintroduce page overflow.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  }
});
