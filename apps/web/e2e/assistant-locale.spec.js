import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// #76: the assistant interface follows ID/EN — greeting, prompts, input, upload
// controls, error and offline fallbacks — and requests the answer language
// explicitly on the wire. wave13: the assistant lives in the Ask Ana drawer.
async function openAssistant(page, lang) {
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
  await page.goto("/app/reports?ana=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("ana-drawer")).toBeVisible();
}

const messages = (page) => page.locator('[data-testid="assistant-message"][data-role="assistant"]');

test("assistant interface follows the locale in both modes", async ({ page }) => {
  await openAssistant(page, "en");
  await expect(page.locator(".ui-drawer-subtitle")).toContainText("Reads the same data you see");
  await expect(messages(page).first()).toContainText("Hi, I am Ana");
  await expect(page.getByTestId("assistant-prompt").first()).toContainText(
    "How many trucks are currently damaged?",
  );
  await expect(page.locator("#assistant-question")).toHaveAttribute("placeholder", "Ask Ana anything...");
  await expect(page.locator(".assistant-upload-button")).toHaveAccessibleName("Attach photo or PDF");

  // A prompt's payload carries the explicit language request.
  const queryPromise = page.waitForRequest((req) => req.url().includes("/assistant/query"));
  await page.getByTestId("assistant-prompt").first().click();
  const query = await queryPromise;
  expect(query.postDataJSON().language).toBe("en");

  await openAssistant(page, "id");
  await expect(page.locator(".ui-drawer-subtitle")).toContainText("Membaca data yang sama");
  await expect(messages(page).first()).toContainText("Halo, saya Ana");
  await expect(page.getByTestId("assistant-prompt").first()).toContainText(
    "Berapa truk yang bermasalah saat ini?",
  );
  await expect(page.locator("#assistant-question")).toHaveAttribute(
    "placeholder",
    "Tanya apa saja ke Ana...",
  );
  await expect(page.locator(".assistant-upload-button")).toHaveAccessibleName("Lampirkan foto atau PDF");
});

test("assistant gateway error message follows the locale", async ({ page }) => {
  await page.route("**/api/assistant/query", (route) =>
    route.fulfill({ status: 502, json: { detail: "AI gateway error: boom" } }),
  );
  await openAssistant(page, "en");
  await page.locator("#assistant-question").fill("hello");
  await page.getByTestId("assistant-send").click();
  await expect(messages(page).last()).toContainText("Ana could not answer");
  await expect(messages(page).last()).toContainText("Try again shortly.");

  // ID mode: wrapper localized, technical detail preserved.
  await openAssistant(page, "id");
  await page.locator("#assistant-question").fill("halo");
  await page.getByTestId("assistant-send").click();
  await expect(messages(page).last()).toContainText("Ana belum dapat menjawab");
  await expect(messages(page).last()).toContainText("Coba lagi nanti.");
});

test("assistant offline fallback follows the locale", async ({ page }) => {
  await page.route("**/api/assistant/query", (route) => route.abort());
  await openAssistant(page, "en");
  await page.locator("#assistant-question").fill("hello");
  await page.getByTestId("assistant-send").click();
  await expect(messages(page).last()).toContainText("Ana cannot reach the server");

  await openAssistant(page, "id");
  await page.locator("#assistant-question").fill("halo");
  await page.getByTestId("assistant-send").click();
  await expect(messages(page).last()).toContainText("Ana tidak dapat terhubung ke server");
});
