// wave13 Tomorrow, supervisor mode: the reviewer can send a plan back with a note instead of
// approving it. The plan leaves the inbox, the dispatcher's page shows "Returned" with the
// note (live, within one poll), and Rebuild is the way forward. At phone width the review
// footer keeps 44 px targets and the page never scrolls sideways.
import { expect, test } from "@playwright/test";
import { buildAndSubmit, freeDay, signIn } from "./lib/tomorrow.js";

test("the supervisor returns a plan with a note and the dispatcher sees it", async ({ browser }) => {
  test.setTimeout(180000);
  const dispatcherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const supervisorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const dispatcher = await dispatcherContext.newPage();
    const day = await freeDay(dispatcher.request, [3, 4, 5]);
    await signIn(dispatcher, { path: `/app/tomorrow?date=${day}` });
    await expect(dispatcher.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });
    const plan = await buildAndSubmit(dispatcher, day);

    const supervisor = await supervisorContext.newPage();
    await signIn(supervisor, { role: "supervisor", supervisor: true, path: `/app/tomorrow?date=${day}` });
    await expect(supervisor.getByTestId("approval-plan")).toHaveAttribute("data-plan-id", plan.plan_id, {
      timeout: 30000,
    });
    for (const id of ["tmr-return", "approve-plan"]) {
      const box = await supervisor.getByTestId(id).boundingBox();
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    expect(
      await supervisor.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(0);

    await supervisor.getByTestId("tmr-return").click();
    const note = supervisor.getByTestId("tmr-return-note");
    await note.fill("Swap T-031 to the early slot");
    const returned = supervisor.waitForResponse((res) => res.url().includes(`/plans/${plan.plan_id}/return`));
    await supervisor.getByTestId("tmr-return-send").click();
    expect((await returned).status()).toBe(200);
    await expect(supervisor.getByTestId("tmr-review-empty")).toBeVisible();

    await expect(dispatcher.getByTestId("tmr-returned")).toContainText("Returned by Supervisor", {
      timeout: 20000,
    });
    await expect(dispatcher.getByTestId("tmr-returned")).toContainText("Swap T-031 to the early slot");
    await expect(dispatcher.getByTestId("tmr-subtitle")).toHaveText(
      "The supervisor sent this plan back. Read the note, then rebuild.",
    );
    await expect(dispatcher.getByTestId("tmr-rebuild")).toBeVisible();
    await expect(dispatcher.getByTestId("tmr-grip")).toHaveCount(0);
  } finally {
    await dispatcherContext.close();
    await supervisorContext.close();
  }
});
