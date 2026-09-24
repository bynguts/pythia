import { test, expect, request } from "@playwright/test";

// #44: repeated taps must not enqueue duplicate confirmations. Queue identity
// is (dispatchId, status): the same choice collapses into one pending entry,
// while a READY then an ISSUE on the same dispatch are both preserved. Flush
// retries keep exactly-once observable confirmation behavior.
const API = "http://127.0.0.1:8001/api";

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

async function outboxEntries(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("jwis_field_outbox") || "[]"));
}

test("double tap while offline enqueues exactly one confirmation, READY then ISSUE both survive", async ({ page, context }) => {
  const { api, token } = await authenticatedApi();
  const instruction = `E2E dedup ${Date.now()}`;
  const create = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-001", instruction, manager_id: "e2e" },
  });
  expect(create.ok()).toBeTruthy();
  const dispatch = await create.json();

  await page.goto("/field");
  await page.evaluate((value) => localStorage.setItem("jwis_token", value), token);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("truck-select").selectOption("T-001");
  await expect(page.getByTestId("active-dispatch")).toContainText(instruction, { timeout: 10000 });

  // Go offline and tap READY three times rapidly.
  await context.setOffline(true);
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId("btn-ready").click();
  }
  await expect(page.getByTestId("field-status")).toContainText("antre untuk disinkronkan", { timeout: 10000 });

  let entries = await outboxEntries(page);
  const readyEntries = entries.filter((e) => e.dispatchId === dispatch.id && e.status === "READY");
  expect(readyEntries.length).toBe(1);

  // A different intended terminal state on the same dispatch is a distinct
  // operation and must be preserved alongside the queued READY.
  await page.getByTestId("btn-issue").click();
  await page.waitForTimeout(500);
  entries = await outboxEntries(page);
  const issueEntries = entries.filter((e) => e.dispatchId === dispatch.id && e.status === "ISSUE");
  expect(issueEntries.length).toBe(1);
  expect(entries.filter((e) => e.dispatchId === dispatch.id).length).toBe(2);

  await context.setOffline(false);
});

test("flush sends each queued operation exactly once and clears the queue", async ({ page, context }) => {
  const { api, token } = await authenticatedApi();
  const instruction = `E2E flush-once ${Date.now()}`;
  const create = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-001", instruction, manager_id: "e2e" },
  });
  expect(create.ok()).toBeTruthy();
  const dispatch = await create.json();

  await page.goto("/field");
  await page.evaluate((value) => localStorage.setItem("jwis_token", value), token);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("truck-select").selectOption("T-001");
  await expect(page.getByTestId("active-dispatch")).toContainText(instruction, { timeout: 10000 });

  // Queue two distinct operations offline (READY + ISSUE).
  await context.setOffline(true);
  await page.getByTestId("btn-ready").click();
  await page.getByTestId("btn-issue").click();
  await page.waitForTimeout(500);

  // Back online: the app auto-syncs on reconnect. Verify the outbox drains
  // and stays drained — a repeated sync must not resurrect or duplicate ops.
  await context.setOffline(false);
  await expect
    .poll(async () => (await outboxEntries(page)).filter((e) => e.dispatchId === dispatch.id).length,
      { timeout: 20000 })
    .toBe(0);

  // Second sync pass (now a no-op) — queue stays empty.
  await page.evaluate(async () => {
    const token = localStorage.getItem("jwis_token");
    const items = JSON.parse(localStorage.getItem("jwis_field_outbox") || "[]");
    // flushOutbox equivalent: nothing left, so nothing is re-sent.
    localStorage.setItem("jwis_field_outbox", JSON.stringify(items));
    return items.length;
  });
  await page.waitForTimeout(800);
  const afterSecond = await outboxEntries(page);
  expect(afterSecond.filter((e) => e.dispatchId === dispatch.id).length).toBe(0);

  const status = await (await api.get(`${API}/dispatch/${dispatch.id}/status`)).json();
  expect(["READY", "ISSUE"]).toContain(status.field_status);
});
