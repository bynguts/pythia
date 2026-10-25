import { test, expect, request } from "@playwright/test";

// #44: repeated taps must not enqueue duplicate confirmations. wave10
// driver-field-app: the /field app merged into /driver, whose outbox replaces
// a repeated (instruction, answer) instead of adding to it; an answered
// instruction leaves the list, so it takes one answer. Flush retries keep
// exactly-once observable confirmation behaviour.
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

async function openInstructions(page, token, truck) {
  await page.goto("/");
  await page.evaluate(
    ({ token, truck }) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
      }
      localStorage.setItem("pythia_lang", "id");
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: truck }));
    },
    { token, truck },
  );
  await page.goto("/driver?tab=instruksi", { waitUntil: "domcontentloaded" });
}

async function queuedFor(page, dispatchId) {
  return page.evaluate(
    (id) =>
      JSON.parse(localStorage.getItem("pythia_driver_outbox") || "[]").filter(
        (entry) => entry.path === `/dispatch/${encodeURIComponent(id)}/confirm`,
      ),
    dispatchId,
  );
}

test("a triple tap while offline enqueues exactly one confirmation and closes the instruction", async ({
  page,
  context,
}) => {
  const { api, token } = await authenticatedApi();
  const instruction = `E2E dedup ${Date.now()}`;
  const create = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-001", instruction, manager_id: "e2e" },
  });
  expect(create.ok()).toBeTruthy();
  const dispatch = await create.json();

  await openInstructions(page, token, "T-001");
  const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
  await expect(item).toContainText(instruction, { timeout: 10000 });

  // Go offline and tap READY three times in one go (faster than a re-render).
  await context.setOffline(true);
  await item.getByTestId("driver-instruction-ready").evaluate((button) => {
    button.click();
    button.click();
    button.click();
  });
  await expect(page.getByTestId("driver-queued-count")).toHaveText("1 item menunggu sinyal");
  const entries = await queuedFor(page, dispatch.id);
  expect(entries).toHaveLength(1);
  expect(entries[0].data.status).toBe("READY");
  // Answered: the instruction leaves the list, so no second answer can be queued.
  await expect(item).toHaveCount(0);

  await context.setOffline(false);
  await api.dispose();
});

test("flush sends each queued operation exactly once and clears the queue", async ({ page, context }) => {
  const { api, token } = await authenticatedApi();
  const instruction = `E2E flush-once ${Date.now()}`;
  const create = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-001", instruction, manager_id: "e2e" },
  });
  expect(create.ok()).toBeTruthy();
  const dispatch = await create.json();

  await openInstructions(page, token, "T-001");
  const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
  await expect(item).toContainText(instruction, { timeout: 10000 });

  await context.setOffline(true);
  await item.getByTestId("driver-instruction-issue").click();
  await expect.poll(async () => (await queuedFor(page, dispatch.id)).length).toBe(1);

  // Back online: the app syncs on reconnect, and the queue drains and stays drained.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await queuedFor(page, dispatch.id)).length, { timeout: 20000 }).toBe(0);
  await page.waitForTimeout(800);
  expect(await queuedFor(page, dispatch.id)).toHaveLength(0);

  const status = await (await api.get(`${API}/dispatch/${dispatch.id}/status`)).json();
  expect(status.field_status).toBe("ISSUE");
  await api.dispose();
});

test("a confirmation the retired /field app queued is adopted and delivered", async ({ page }) => {
  const { api, token } = await authenticatedApi();
  const create = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-001", instruction: `E2E legacy ${Date.now()}`, manager_id: "e2e" },
  });
  const dispatch = await create.json();
  await page.goto("/");
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        "pythia_field_outbox",
        JSON.stringify([
          {
            dispatchId: id,
            status: "READY",
            note: "Dikonfirmasi dari aplikasi lapangan",
            operation_id: "field-legacy-e2e-0001",
          },
        ]),
      ),
    dispatch.id,
  );
  // The adopted entry keeps its operation id (the backend replay guard) and
  // is delivered exactly once, even across reconnect events and reloads.
  const sentIds = [];
  await page.route(`**/dispatch/${dispatch.id}/confirm`, async (route) => {
    sentIds.push(JSON.parse(route.request().postData()).operation_id);
    await route.continue();
  });
  await openInstructions(page, token, "T-001");
  await expect
    .poll(async () => (await (await api.get(`${API}/dispatch/${dispatch.id}/status`)).json()).field_status, {
      timeout: 20000,
    })
    .toBe("READY");
  expect(await page.evaluate(() => localStorage.getItem("pythia_field_outbox"))).toBeNull();
  await expect.poll(async () => (await queuedFor(page, dispatch.id)).length, { timeout: 20000 }).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  expect(sentIds).toEqual(["field-legacy-e2e-0001"]);
  await api.dispose();
});
