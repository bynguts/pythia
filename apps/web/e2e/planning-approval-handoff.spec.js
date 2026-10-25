// wave11 plan approval handoff: a dispatcher proposes a plan in one browser and a
// supervisor approves it from another. The dispatcher may build but not approve, so
// step 03 tells them it waits for a supervisor; the supervisor's step 03 opens the
// newest proposed plan (same id), says who proposed it, and approves it.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, role) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
  await page.goto("/planning", { waitUntil: "domcontentloaded" });
}

test("a supervisor approves the dispatcher's plan from another browser", async ({ browser }) => {
  test.setTimeout(180000);
  const dispatcherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const supervisorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const dispatcher = await dispatcherContext.newPage();
    await signIn(dispatcher, "dispatcher");
    await expect(dispatcher.getByTestId("plan-total")).toBeVisible({ timeout: 30000 });
    const built = dispatcher.waitForResponse(
      (res) => res.url().includes("/operations/plan?") && res.request().method() === "POST",
      { timeout: 120000 },
    );
    await dispatcher.getByRole("button", { name: "Susun Alokasi Armada" }).click();
    const plan = await (await built).json();
    expect(plan.status).toBe("proposed");

    // The dispatcher cannot approve: no button, a clear waiting state instead.
    const dispatcherApproval = dispatcher.locator(".planning-approval");
    await expect(dispatcherApproval.getByTestId("plan-awaiting-approval")).toContainText(
      "Menunggu persetujuan supervisor.",
    );
    await expect(dispatcherApproval.getByTestId("approve-plan")).toHaveCount(0);

    const supervisor = await supervisorContext.newPage();
    await signIn(supervisor, "supervisor");
    const approval = supervisor.locator(".planning-approval");
    await expect(approval.getByTestId("pending-plan")).toBeVisible({ timeout: 30000 });
    await expect(approval.getByTestId("approval-plan")).toHaveAttribute("data-plan-id", plan.plan_id, {
      timeout: 30000,
    });
    await expect(approval.getByTestId("approval-proposed-by")).toContainText(
      "Diusulkan oleh Pengatur armada",
    );
    // wave11 review: the approver sees which day the trips are for, not only the page's date.
    await expect(approval.getByTestId("approval-plan-date")).toHaveText(plan.plan_date);
    await expect(supervisor.locator(".planning-progress li").nth(2)).toHaveAttribute("aria-current", "step");

    const approved = supervisor.waitForResponse((res) =>
      res.url().includes(`/operations/${plan.plan_id}/approve`),
    );
    await approval.getByTestId("approve-plan").click();
    expect((await approved).status()).toBe(200);
    await expect(approval.getByTestId("approval-done")).toBeVisible();
    // wave12: approval drafts the SPJs and says so, with who approved and when.
    await expect(approval.getByTestId("approval-approved-by")).toContainText("Disetujui oleh Pengawas");
    await expect(approval.getByTestId("approval-spj-drafts")).toContainText("draf SPJ");
    await expect(approval.getByTestId("approve-plan")).toHaveCount(0);
  } finally {
    await dispatcherContext.close();
    await supervisorContext.close();
  }
});
