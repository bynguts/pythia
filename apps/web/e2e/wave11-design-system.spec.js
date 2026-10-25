// wave11 design system: the approved redesign (docs/design/export) is the real app
// shell and vocabulary: a top nav and no sidebar on desktop, a five-item bottom nav on
// phones, Inter Tight / Inter / Geist Mono loaded and applied, and one provenance-label
// chip style (11 px uppercase Geist Mono, outlined) for every chip.
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
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workspace-navigation")).toBeAttached({ timeout: 20000 });
}

test("desktop shell is one top bar with workspace pills and no sidebar at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await expect(page.locator(".command-sidebar")).toHaveCount(0);
  // Workspaces may hold their own complementary rails; the shell itself has none.
  await expect(
    page.locator(".command-shell > aside, .command-shell > nav:not(.command-mobile-nav)"),
  ).toHaveCount(0);

  const bar = await page.locator(".command-topbar").boundingBox();
  expect(bar.x).toBe(0);
  expect(bar.y).toBe(0);
  expect(bar.width).toBe(1440);
  expect(bar.height).toBeLessThanOrEqual(61);

  const nav = page.getByTestId("workspace-navigation");
  await expect(nav).toBeVisible();
  const navBox = await nav.boundingBox();
  expect(navBox.y + navBox.height).toBeLessThanOrEqual(bar.height);
  await expect(nav.getByRole("button", { name: "Armada" })).toHaveAttribute("aria-current", "page");
  for (const control of [page.getByTestId("shell-status"), page.getByTestId("profile-button")]) {
    const box = await control.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(bar.height);
  }

  // Content starts at the left edge: nothing sits beside the canvas.
  expect((await page.locator(".command-main").boundingBox()).x).toBe(0);
  await expect(page.locator(".command-mobile-nav")).toBeHidden();
});

test("phones keep a five-item bottom nav and hide the top pills", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.getByTestId("workspace-navigation")).toBeHidden();
  const bottom = page.locator(".command-mobile-nav");
  await expect(bottom).toBeVisible();
  await expect(bottom.getByRole("button")).toHaveCount(5);
  const box = await bottom.boundingBox();
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(box.width).toBe(390);
  for (const button of await bottom.getByRole("button").all()) {
    const b = await button.boundingBox();
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Inter Tight, Inter and Geist Mono load and carry headings, text and labels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await document.fonts.ready;
          const loaded = new Set(
            [...document.fonts]
              .filter((f) => f.status === "loaded")
              .map((f) => f.family.replace(/["']/g, "")),
          );
          return ["Inter Tight", "Inter", "Geist Mono"].filter((family) => loaded.has(family));
        }),
      { timeout: 15000 },
    )
    .toEqual(["Inter Tight", "Inter", "Geist Mono"]);

  const family = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(await family(".command-brand strong")).toMatch(/^"?Inter Tight"?/);
  expect(await family(".command-nav-item")).toMatch(/^"?Inter"?,/);
  expect(await family('[data-testid="shell-status"]')).toMatch(/^"?Geist Mono"?/);
});

test("provenance labels and legacy chips share the one outlined mono label style", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const status = page.getByTestId("shell-status");
  await expect(status).toContainText("Simulasi");

  const chips = page.locator(
    ".prov:not(.prov-bare), .pill, .status-pill, .status-badge, .classification-badge, .freshness-badge",
  );
  await expect(chips.first()).toBeVisible({ timeout: 20000 });
  const styles = await chips.evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          text: element.textContent.trim().slice(0, 40),
          family: style.fontFamily,
          size: style.fontSize,
          transform: style.textTransform,
          tracking: parseFloat(style.letterSpacing) || 0,
          border: style.borderTopWidth,
        };
      }),
  );
  expect(styles.length).toBeGreaterThan(0);
  for (const chip of styles) {
    expect(chip.family, chip.text).toMatch(/^"?Geist Mono"?/);
    expect(chip.size, chip.text).toBe("11px");
    expect(chip.transform, chip.text).toBe("uppercase");
    expect(chip.tracking, chip.text).toBeGreaterThan(0);
    expect(chip.border, chip.text).toBe("1px");
  }

  // The top-bar status chip uses the same label type (filled, not outlined).
  const chip = await status.evaluate((element) => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, transform: style.textTransform };
  });
  expect(chip).toEqual({ size: "11px", transform: "uppercase" });
});
