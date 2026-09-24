import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

// #76: the assistant interface follows ID/EN — greeting, quick prompts,
// input, upload controls, error and offline fallbacks — and requests the
// answer language explicitly on the wire.
async function signIn(page, lang) {
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

async function openAssistant(page) {
  await page.locator(".command-assistant").click();
  await expect(page.locator(".assistant-modal")).toBeVisible();
}

test("assistant interface follows the locale in both modes", async ({ page }) => {
  await signIn(page, "en");
  await openAssistant(page);

  await expect(page.locator(".assistant-chat-header h2")).toHaveText("Ana");
  await expect(page.locator(".assistant-chat-header p")).toContainText("Ask about operational status");
  await expect(page.locator(".assistant-message.assistant").first()).toContainText("Hi, I am Ana");
  await expect(page.locator(".assistant-quick-prompts button").first()).toContainText("Fleet status");
  await expect(page.locator(".assistant-quick-prompts button").nth(1)).toContainText("How dispatch works");
  await expect(page.locator("#assistant-question")).toHaveAttribute("placeholder", "Ask Ana anything...");
  await expect(page.locator(".assistant-upload-button")).toHaveAccessibleName("Attach photo or PDF");

  // Quick prompt payload carries the explicit language request.
  const queryPromise = page.waitForRequest((req) => req.url().includes("/assistant/query"));
  await page.locator(".assistant-quick-prompts button").first().click();
  const query = await queryPromise;
  const body = query.postDataJSON();
  expect(body.language).toBe("en");
  await page.waitForTimeout(300);
  await page.locator(".assistant-close").click();
  await page.getByTestId("lang-switch-id").click();
  await openAssistant(page);
  await expect(page.locator(".assistant-chat-header p")).toContainText("Tanya status operasional");
  await expect(page.locator(".assistant-message.assistant").first()).toContainText("Halo, saya Ana");
  await expect(page.locator(".assistant-quick-prompts button").first()).toContainText("Status armada");
  await expect(page.locator("#assistant-question")).toHaveAttribute("placeholder", "Tanya apa saja ke Ana...");
  await expect(page.locator(".assistant-upload-button")).toHaveAccessibleName("Lampirkan foto atau PDF");
});

test("assistant gateway error message follows the locale", async ({ page }) => {
  await signIn(page, "en");
  await openAssistant(page);

  await page.route("**/api/assistant/query", (route) => route.fulfill({ status: 502, json: { detail: "AI gateway error: boom" } }));
  await page.locator("#assistant-question").fill("hello");
  await page.locator(".assistant-chat-input .primary-button").click();
  await expect(page.locator(".assistant-message.assistant").last()).toContainText("Ana could not answer");
  await expect(page.locator(".assistant-message.assistant").last()).toContainText("Try again shortly.");

  // ID mode: wrapper localized, technical detail preserved.
  await page.locator(".assistant-close").click();
  await page.getByTestId("lang-switch-id").click();
  await openAssistant(page);
  await page.locator("#assistant-question").fill("halo");
  await page.locator(".assistant-chat-input .primary-button").click();
  await expect(page.locator(".assistant-message.assistant").last()).toContainText("Ana belum dapat menjawab");
  await expect(page.locator(".assistant-message.assistant").last()).toContainText("Coba lagi nanti.");
});

test("assistant offline fallback follows the locale", async ({ page }) => {
  await signIn(page, "en");
  await openAssistant(page);

  await page.route("**/api/assistant/query", (route) => route.abort());
  await page.locator("#assistant-question").fill("hello");
  await page.locator(".assistant-chat-input .primary-button").click();
  await expect(page.locator(".assistant-message.assistant").last()).toContainText("Ana cannot reach the server");

  await page.locator(".assistant-close").click();
  await page.getByTestId("lang-switch-id").click();
  await openAssistant(page);
  await page.locator("#assistant-question").fill("halo");
  await page.locator(".assistant-chat-input .primary-button").click();
  await expect(page.locator(".assistant-message.assistant").last()).toContainText("Ana tidak dapat terhubung ke server");
});
