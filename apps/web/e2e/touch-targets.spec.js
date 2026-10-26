import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #31: primary app controls provide at least a 44x44 hit area on
// mobile (390px) and tablet (768px) without horizontal overflow.
async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
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
  await page.reload({ waitUntil: "domcontentloaded" });
}

const MIN = 44;

// Wave 13: the console shell and each page's buttons keep a 44x44 hit box (the drawn
// control may be smaller inside it) at phone and tablet widths, without page overflow.
test("primary controls meet the 44x44 touch target at 390 and 768px", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const id of ["operations", "readiness", "gate", "work-orders", "tomorrow", "fleet"]) {
      await page.goto(`/app/${id}`);
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20000 });

      const failures = await page.evaluate((min) => {
        const out = [];
        const selectors = [".cx-topbar button", "main .ui-btn", "main .ui-segmented-item"];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const r = el.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0;
            const style = getComputedStyle(el);
            const displayed = style.display !== "none" && style.visibility !== "hidden";
            if (visible && displayed && (r.height < min || r.width < min)) {
              out.push(
                `${sel} "${el.textContent.trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
              );
            }
          });
        }
        return out;
      }, MIN);

      expect(failures, `${id}: controls below ${MIN}px at ${width}: ${failures.join(", ")}`).toEqual([]);

      // Larger hit areas must not reintroduce page overflow.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth, `${id} at ${width}`).toBeLessThanOrEqual(overflow.clientWidth);
    }
  }
});

// Wave 13: the phone's off-canvas sidebar (search, nav, supervisor switch, profile) and the
// Operations map's own zoom and locate buttons keep the same 44x44 hit box.
test("sidebar and map controls meet the 44x44 touch target at 390 and 768px", async ({ page }) => {
  await signIn(page);
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/app/operations");
    await expect(page.getByTestId("fleet-map-stage")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".ops-map-zoom button").first()).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Buka menu" }).click();
    await expect(page.getByTestId("workspace-navigation")).toBeVisible();

    const failures = await page.evaluate((min) => {
      const out = [];
      const selectors = [
        ".cx-nav-item",
        ".cx-search",
        ".cx-supervisor",
        ".cx-user-button",
        ".ops-map-zoom button",
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const displayed = style.display !== "none" && style.visibility !== "hidden";
          if (r.width > 0 && r.height > 0 && displayed && (r.height < min || r.width < min)) {
            out.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        });
      }
      return out;
    }, MIN);
    expect(failures, `controls below ${MIN}px at viewport ${width}: ${failures.join(", ")}`).toEqual([]);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
