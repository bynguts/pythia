import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
}

async function expectMinimumTouchTarget(locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

test.beforeEach(async ({ page }) => signIn(page));

// The console sidebar groups seven pages under Today and Plan; Settings sits below a
// separator. A click marks the item current and the page renders its one h1 inside <main>.
const PAGES = [
  ["operations", "Operasi"],
  ["readiness", "Kesiapan pagi"],
  ["gate", "Gerbang TPA"],
  ["work-orders", "Surat jalan"],
  ["tomorrow", "Besok"],
  ["fleet", "Armada & sopir"],
  ["reports", "Laporan"],
  ["settings", "Pengaturan"],
];

test("the sidebar exposes every console page and preserves active state", async ({ page }) => {
  await page.goto("/app/operations");
  const nav = page.getByTestId("workspace-navigation");
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(PAGES.length);
  await expect(nav.getByTestId("nav-separator")).toHaveCount(1);
  for (const [id, label] of PAGES) await expect(nav.getByTestId(`nav-${id}`)).toContainText(label);

  for (const id of ["tomorrow", "work-orders", "operations"]) {
    const link = nav.getByTestId(`nav-${id}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/app/${id}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("desktop and mobile layouts never create document-level horizontal overflow", async ({ page }) => {
  await page.goto("/app/work-orders");
  await expect(page.getByTestId("work-orders-page")).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 375, height: 812 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  }
});

test("on a phone the sidebar opens from the menu button and switches pages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/operations");
  const toggle = page.getByRole("button", { name: "Buka menu" });
  await expectMinimumTouchTarget(toggle);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const nav = page.getByTestId("workspace-navigation");
  for (const link of await nav.getByRole("link").all()) await expectMinimumTouchTarget(link);

  const tomorrow = nav.getByTestId("nav-tomorrow");
  await tomorrow.click();
  await expect(page).toHaveURL(/\/app\/tomorrow$/);
  await expect(tomorrow).toHaveAttribute("aria-current", "page");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("Ana opens as a modal drawer and closes without leaving the page", async ({ page }) => {
  await page.goto("/app/operations");
  await page.getByTestId("ask-ana").click();
  const dialog = page.getByRole("dialog", { name: "Ana" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await dialog.getByRole("button", { name: "Tutup" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/app\/operations$/);
  await expect(page.getByTestId("ask-ana")).toBeFocused();
});

test("document language follows the stored locale across routes and reloads", async ({ page }) => {
  await page.goto("/app/operations");
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await page.getByTestId("profile-button").click();
  await page.getByTestId("profile-lang-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  for (const route of ["/driver", "/app/tomorrow"]) {
    await page.goto(route);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  }
  await page.evaluate(() => localStorage.removeItem("pythia_auth"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("every console page has one main landmark", async ({ page }) => {
  for (const [id] of PAGES) {
    await page.goto(`/app/${id}`);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
  }
});

test("core pages meet text contrast requirements", async ({ page }) => {
  test.setTimeout(120000);
  const scan = async (surface) => {
    const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
    expect(
      results.violations,
      `${surface}: ${JSON.stringify(results.violations.map(({ nodes }) => nodes.map(({ target }) => target)))}`,
    ).toEqual([]);
  };

  await page.evaluate(() => localStorage.removeItem("pythia_auth"));
  await page.goto("/app/operations");
  await expect(page.getByRole("heading", { name: "Masuk ke Pythia" })).toBeVisible();
  await scan("login");
  await signIn(page);
  for (const id of ["operations", "tomorrow", "work-orders", "settings"]) {
    await page.goto(`/app/${id}`);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await scan(id);
  }
});

test("console navigation emits no runtime errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/app/operations");
  for (const id of ["tomorrow", "fleet", "reports", "settings", "operations"]) {
    await page.getByTestId(`nav-${id}`).click();
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("login requires explicit credentials and exposes password visibility control", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.removeItem("pythia_auth");
    localStorage.removeItem("pythia_token");
  });
  await page.goto("/app/operations");
  await expect(page.getByRole("heading", { name: "Masuk ke Pythia" })).toBeVisible();
  await expect(page.getByPlaceholder("contoh: dispatcher")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Tampilkan kata sandi" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Masuk" })).toBeVisible();
});
