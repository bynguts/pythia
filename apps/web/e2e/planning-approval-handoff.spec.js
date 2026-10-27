// Plan approval handoff, Tomorrow: a dispatcher builds the plan and sends it to
// the supervisor in one browser; the supervisor turns on supervisor mode in another, sees the
// same plan (who proposed it, "Your turn") and approves it. The dispatcher can build and
// submit but never approve.
import { expect, test } from "@playwright/test";
import { buildAndSubmit, freeDay, signIn } from "./lib/tomorrow.js";

test("a supervisor approves the dispatcher's plan from another browser", async ({ browser }) => {
  test.setTimeout(180000);
  const dispatcherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const supervisorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const dispatcher = await dispatcherContext.newPage();
    const day = await freeDay(dispatcher.request, [1, 2, 3]);
    await signIn(dispatcher, { path: `/app/tomorrow?date=${day}` });
    await expect(dispatcher.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
    const plan = await buildAndSubmit(dispatcher, day);
    expect(plan.scope.fleet_classification).toBe("SIMULATED");
    expect(plan.scenario.inputs_auto).toBe(true);

    // The dispatcher cannot approve: no button, a clear waiting state instead.
    await expect(dispatcher.getByTestId("plan-awaiting-approval")).toContainText(
      "Waiting for supervisor approval",
    );
    await expect(dispatcher.getByTestId("approve-plan")).toHaveCount(0);
    await expect(dispatcher.locator(".planning-progress li").nth(3)).toHaveAttribute("aria-current", "step");

    const supervisor = await supervisorContext.newPage();
    await signIn(supervisor, { role: "supervisor", supervisor: true, path: `/app/tomorrow?date=${day}` });
    await expect(supervisor.getByTestId("approval-plan")).toHaveAttribute("data-plan-id", plan.plan_id, {
      timeout: 30000,
    });
    await expect(supervisor.getByTestId("tmr-subtitle")).toContainText("Dispatcher submitted this plan at");
    await expect(supervisor.locator(".planning-progress li").nth(3)).toContainText("Your turn");
    await expect(supervisor.getByTestId("tmr-footer")).toContainText(
      /On approval, Pythia drafts \d+ work orders? and sends/,
    );
    // Facts are the dispatcher's input; the reviewer reads them.
    await expect(supervisor.getByTestId("tmr-fact-input")).toHaveCount(0);

    const approved = supervisor.waitForResponse((res) =>
      res.url().includes(`/operations/${plan.plan_id}/approve`),
    );
    await supervisor.getByTestId("approve-plan").click();
    expect((await approved).status()).toBe(200);
    await expect(supervisor.getByTestId("approval-done")).toBeVisible();
    await expect(supervisor.getByTestId("approval-approved-by")).toContainText(
      /Approved by Supervisor at \d\d:\d\d · \d+ work orders drafted/,
    );
    await expect(supervisor.getByTestId("approve-plan")).toHaveCount(0);
  } finally {
    await dispatcherContext.close();
    await supervisorContext.close();
  }
});
