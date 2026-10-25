// wave12 live approval: a dispatcher proposes a plan in Rencana and keeps the page open;
// a supervisor approves it elsewhere (here through the API). Within one 15 s poll the
// dispatcher's step 03 says it is approved, by whom, and how many draft SPJs it made.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function login(request, role) {
  const response = await request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("the dispatcher sees the supervisor's approval without reloading", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const principal = await login(page.request, "dispatcher");
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/planning", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 30000 });

  const built = page.waitForResponse(
    (res) => res.url().includes("/operations/plan?") && res.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: "Susun Alokasi Armada" }).click();
  const plan = await (await built).json();
  expect(plan.status).toBe("proposed");
  const approval = page.locator(".planning-approval");
  await expect(approval.getByTestId("plan-awaiting-approval")).toBeVisible();
  await expect(approval.getByTestId("approval-done")).toHaveCount(0);

  const supervisor = await login(page.request, "supervisor");
  const approved = await page.request.post(`${API}/operations/${plan.plan_id}/approve`, {
    headers: { Authorization: `Bearer ${supervisor.token}` },
  });
  expect(approved.status()).toBe(200);

  await expect(page.getByTestId("approval-done")).toBeVisible({ timeout: 20_000 });
  await expect(approval.getByTestId("plan-awaiting-approval")).toHaveCount(0);
  await expect(approval.getByTestId("approval-approved-by")).toContainText("Disetujui oleh Pengawas");
  const drafts = approval.getByTestId("approval-spj-drafts");
  await expect(drafts).toContainText("draf SPJ");
  await expect(drafts).toContainText("(MODEL)");
});
