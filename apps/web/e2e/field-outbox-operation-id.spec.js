import { test, expect, request } from "@playwright/test";

// a queued field confirmation carries one operation id from the
// moment it is queued, and every flush retry re-sends that same id, so the
// backend's #44 replay guard keeps the confirmation exactly-once.
const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function authenticatedApi() {
  const bootstrap = await request.newContext();
  const login = await bootstrap.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  await bootstrap.dispose();
  const api = await request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  return { api, token };
}

test("a retried field confirmation re-sends the operation id it was queued with", async ({
  page,
  context,
}) => {
  const { api, token } = await authenticatedApi();
  const instruction = `E2E op-id ${Date.now()}`;
  const create = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-001", instruction, manager_id: "e2e" },
  });
  expect(create.ok()).toBeTruthy();
  const dispatch = await create.json();

  await page.goto("/field");
  await page.evaluate((value) => localStorage.setItem("pythia_token", value), token);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("truck-select").selectOption("T-001");
  await expect(page.getByTestId("active-dispatch")).toContainText(instruction, { timeout: 10000 });

  await context.setOffline(true);
  await page.getByTestId("btn-ready").click();
  await page.getByTestId("btn-ready").click();
  const queued = await page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("pythia_field_outbox") || "[]").filter(
        (entry) => entry.dispatchId === id,
      ),
    dispatch.id,
  );
  expect(queued).toHaveLength(1);
  expect(queued[0].operation_id.length).toBeGreaterThanOrEqual(8);

  // First delivery attempt fails server-side; the retry must reuse the id.
  const sentIds = [];
  let failNext = true;
  await page.route(`**/dispatch/${dispatch.id}/confirm`, async (route) => {
    sentIds.push(JSON.parse(route.request().postData()).operation_id);
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, json: { detail: "temporarily unavailable" } });
    } else {
      await route.continue();
    }
  });
  await context.setOffline(false);
  await expect.poll(() => sentIds.length, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: /sinkronkan sekarang|sync now/i }).click();
  await expect.poll(() => sentIds.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);

  expect(new Set(sentIds)).toEqual(new Set([queued[0].operation_id]));
  const status = await (await api.get(`${API}/dispatch/${dispatch.id}/status`)).json();
  expect(status.field_status).toBe("READY");
  await api.dispose();
});
