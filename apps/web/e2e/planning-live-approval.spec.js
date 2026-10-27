// Live approval, Tomorrow: a dispatcher submits the plan and keeps the page
// open; a supervisor approves it elsewhere (here through the API). Within one 15 s poll the
// dispatcher's page says it is approved, by whom, and how many work orders it drafted.
import { expect, test } from "@playwright/test";
import { API, buildAndSubmit, freeDay, signIn } from "./lib/tomorrow.js";

test("the dispatcher sees the supervisor's approval without reloading", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const day = await freeDay(page.request, [2, 3, 4]);
  await signIn(page, { lang: "id", path: `/app/tomorrow?date=${day}` });
  await expect(page.getByTestId("plan-total")).toBeVisible({ timeout: 60000 });

  const plan = await buildAndSubmit(page, day);
  await expect(page.getByTestId("plan-awaiting-approval")).toBeVisible();
  await expect(page.getByTestId("approval-done")).toHaveCount(0);

  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "supervisor", password: "supervisor-demo-pass" },
  });
  const supervisor = await response.json();
  const approved = await page.request.post(`${API}/operations/${plan.plan_id}/approve`, {
    headers: { Authorization: `Bearer ${supervisor.token}` },
  });
  expect(approved.status()).toBe(200);

  await expect(page.getByTestId("approval-done")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("plan-awaiting-approval")).toHaveCount(0);
  await expect(page.getByTestId("approval-approved-by")).toContainText(
    /Disetujui oleh Pengawas pukul \d\d:\d\d · \d+ surat jalan disiapkan/,
  );
  await expect(page.getByTestId("approval-spj-drafts")).toHaveAttribute("href", "/app/work-orders");
  await expect(page.locator(".planning-progress li[aria-current=step]")).toHaveCount(0);
});
