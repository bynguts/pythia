import { test, expect, request } from "@playwright/test";

// a queued instruction confirmation carries one operation id from the moment
// it is queued, and every flush retry re-sends that same id, so the backend's
// #44 replay guard keeps the confirmation exactly-once. wave10
// driver-field-app: runs on the driver app's Instruksi tab (/field merged).
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

  await page.goto("/");
  await page.evaluate((value) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
    }
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_field_token", value);
    localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: "T-001" }));
  }, token);
  await page.goto("/driver?tab=instruksi", { waitUntil: "domcontentloaded" });
  const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
  await expect(item).toContainText(instruction, { timeout: 10000 });

  await context.setOffline(true);
  await item.getByTestId("driver-instruction-ready").click();
  const path = `/dispatch/${encodeURIComponent(dispatch.id)}/confirm`;
  await expect
    .poll(() =>
      page.evaluate(
        (p) =>
          JSON.parse(localStorage.getItem("pythia_driver_outbox") || "[]").filter((e) => e.path === p).length,
        path,
      ),
    )
    .toBe(1);
  const queued = await page.evaluate(
    (p) => JSON.parse(localStorage.getItem("pythia_driver_outbox") || "[]").filter((e) => e.path === p),
    path,
  );
  expect(queued[0].data.operation_id.length).toBeGreaterThanOrEqual(8);

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
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => sentIds.length, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  await page.getByTestId("driver-sync-now").click();
  await expect.poll(() => sentIds.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);

  expect(new Set(sentIds)).toEqual(new Set([queued[0].data.operation_id]));
  await expect
    .poll(async () => (await (await api.get(`${API}/dispatch/${dispatch.id}/status`)).json()).field_status)
    .toBe("READY");
  await api.dispose();
});
