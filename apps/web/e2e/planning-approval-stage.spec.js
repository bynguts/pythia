// wave10 planning step 03: "Tinjau & setujui" is one decision brief beside its authority
// column. No panel nests inside the stage card, the TPA queue is one joined strip, the
// approval column always names the next step, and the layout holds at phone width.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
}

test("step 03 is a flat brief with a joined queue strip and an approval column", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/planning");
  const stage = page.locator(".planning-approval-stage");
  await expect(stage.getByTestId("exec-headline")).not.toHaveText("", { timeout: 30000 });

  // No card inside the stage card, and the queue is said once, as a strip.
  await expect(stage.locator(".panel")).toHaveCount(0);
  await expect(stage.getByTestId("exec-queue-title")).toHaveText("Antrean TPA Bantargebang (simulasi)");
  await expect(stage.locator(".exec-queue-strip > div").first()).toBeVisible({ timeout: 30000 });

  // The brief and the authority column sit side by side on desktop.
  const brief = await stage.locator(".planning-summary").boundingBox();
  const authority = await stage.locator(".planning-approval").boundingBox();
  expect(authority.x).toBeGreaterThan(brief.x + brief.width - 1);

  // Without a plan the column points back to step 02 and moves focus there.
  const approval = page.getByRole("complementary", { name: "Kewenangan keputusan" });
  await expect(approval).toContainText("Belum ada rencana untuk disetujui.");
  await expect(approval).toContainText("Peran: Pengatur armada");
  await approval.getByRole("button", { name: "Ke langkah 02" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest("section")?.querySelector("#planning-stage-02")),
      ),
    )
    .toBe(true);
});

for (const width of [320, 390]) {
  test(`step 03 stacks without sideways scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signIn(page);
    await page.goto("/planning");
    const stage = page.locator(".planning-approval-stage");
    await expect(stage.getByTestId("exec-headline")).not.toHaveText("", { timeout: 30000 });
    const brief = await stage.locator(".planning-summary").boundingBox();
    const authority = await stage.locator(".planning-approval").boundingBox();
    expect(authority.y).toBeGreaterThanOrEqual(brief.y + brief.height - 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const goto = stage.getByRole("button", { name: "Ke langkah 02" });
    const box = await goto.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
}
