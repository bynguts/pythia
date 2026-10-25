// wave12 readiness and recap: the Fleet record tabs carry the morning readiness board
// (one row per truck, ready or its blockers, under the counts) and the close-of-day recap
// (recorded vs planned, gate wait, incidents, evidence gaps and the day's summary), both
// read from the real API and labelled as recorded in the app or as model output.
import { expect, test } from "@playwright/test";

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
  await page.goto("/fleet", { waitUntil: "domcontentloaded" });
  return principal;
}

test("the readiness tab lists every truck as ready or with its blockers", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token } = await signIn(page);
  const board = await (
    await page.request.get(`${API}/readiness?scope=plan`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();

  await page.locator(".fleet-record-tabs").getByRole("tab", { name: "Kesiapan" }).click();
  const list = page.getByTestId("readiness-list");
  await expect(list).toBeVisible({ timeout: 30000 });
  await expect(list).toHaveAttribute("data-scope", board.scope_used);
  await expect(list.getByTestId("readiness-count-ready")).toContainText(String(board.counts.ready));
  await expect(list.getByTestId("readiness-count-ready").getByTestId("prov")).toHaveText(
    "Tercatat di aplikasi",
  );
  const rows = list.getByTestId("readiness-row");
  await expect(rows).toHaveCount(board.trucks.length);
  const first = board.trucks[0];
  await expect(rows.first()).toContainText(first.truck_code);
  // A truck that is not ready names what holds it, in Indonesian, never a raw code.
  if (!first.ready) await expect(rows.first().locator(".ui-row-meta")).not.toContainText("_");
});

test("the recap tab shows the day against the plan and never invents a figure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token } = await signIn(page);
  const recap = await (
    await page.request.get(`${API}/recap/daily`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();

  await page.locator(".fleet-record-tabs").getByRole("tab", { name: "Rekap harian" }).click();
  const list = page.getByTestId("recap-list");
  await expect(list).toBeVisible({ timeout: 30000 });
  await expect(list).toHaveAttribute("data-date", recap.date);
  // A figure the day has not recorded reads "—", never 0.
  const actual = list.getByTestId("recap-actual").locator(".metric-value");
  if (recap.actual.receipt_tons == null) await expect(actual).toHaveText("—");
  await expect(list.getByTestId("recap-planned").getByTestId("prov")).toHaveText("HASIL MODEL");
  await expect(list.getByTestId("recap-evidence-row")).toHaveCount(3);
  await expect(list.getByTestId("recap-summary")).toContainText(recap.summary.id);
});
