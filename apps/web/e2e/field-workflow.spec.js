import { test, expect, request } from "@playwright/test";

// wave10 driver-field-app: /field merged into /driver; the field instruction
// behaviours below run against the driver app's Instruksi tab.
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

async function openAuthorizedField(page, token, truck = "T-047") {
  await page.goto("/");
  await page.evaluate(
    ({ token, truck }) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("pythia_driver")) localStorage.removeItem(key);
      }
      localStorage.setItem("pythia_field_token", token);
      localStorage.setItem("pythia_driver", JSON.stringify({ driver_name: "E2E", truck_code: truck }));
    },
    { token, truck },
  );
  await page.goto("/driver?tab=instruksi", { waitUntil: "domcontentloaded" });
}

async function expectMinimumTouchTarget(locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

async function instructionOrder(page) {
  return page
    .locator('[data-testid^="driver-instruction-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.testid).filter((id) => !/-(ready|issue|reason|cant|depart)$/.test(id)),
    );
}

// Manager dispatches an instruction -> the driver sees it newest first and confirms it.
test("newest manager dispatch flows to the driver's Instruksi tab and is confirmed", async ({ page }) => {
  const { api, token } = await authenticatedApi();
  const runId = Date.now();
  const older = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-047", instruction: `E2E older instruction ${runId}`, manager_id: "e2e" },
  });
  const newest = await api.post(`${API}/dispatch`, {
    data: { truck_code: "T-047", instruction: `E2E newest instruction ${runId}`, manager_id: "e2e" },
  });
  expect(older.ok()).toBeTruthy();
  expect(newest.ok()).toBeTruthy();
  const olderDispatch = await older.json();
  const newestDispatch = await newest.json();
  expect(Number.isNaN(Date.parse(newestDispatch.created_at))).toBe(false);

  await openAuthorizedField(page, token);
  const item = page.getByTestId(`driver-instruction-${newestDispatch.id}`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("driver-tab-instruksi-count")).toBeVisible();
  // Every pending instruction stays answerable, the newest first.
  const order = await instructionOrder(page);
  expect(order.indexOf(`driver-instruction-${newestDispatch.id}`)).toBeLessThan(
    order.indexOf(`driver-instruction-${olderDispatch.id}`),
  );

  await item.getByTestId("driver-instruction-ready").click();
  await expect(item).toHaveCount(0, { timeout: 10000 });
  const status = await (await api.get(`${API}/dispatch/${newestDispatch.id}/status`)).json();
  expect(status.field_status).toBe("READY");
  await api.post(`${API}/dispatch/${olderDispatch.id}/confirm`, {
    data: { status: "READY", note: "E2E cleanup" },
  });
  await api.dispose();
});

test("same-millisecond dispatches preserve ISO microsecond ordering", async ({ page }) => {
  await page.route("**/api/dispatch/T-047", async (route) => {
    await route.fulfill({
      json: [
        {
          id: "z-older",
          truck_code: "T-047",
          instruction: "Older microsecond instruction",
          field_status: "PENDING",
          created_at: "2026-07-15T10:00:00.123456+00:00",
        },
        {
          id: "a-newer",
          truck_code: "T-047",
          instruction: "Newest microsecond instruction",
          field_status: "PENDING",
          created_at: "2026-07-15T10:00:00.123789+00:00",
        },
      ],
    });
  });

  // gsc-2026 P0-2: the driver app signs in first; the stubbed dispatch list needs a valid token.
  const { api, token } = await authenticatedApi();
  await api.dispose();
  await openAuthorizedField(page, token);
  await expect(page.getByTestId("driver-instruction-a-newer")).toBeVisible();
  expect(await instructionOrder(page)).toEqual(["driver-instruction-a-newer", "driver-instruction-z-older"]);
});

// Offline confirmation, a failed sync and recovery, in the chosen language.
test("offline confirmation queues, reports a lost session, and recovers in ID and EN", async ({
  page,
  context,
}) => {
  const { api, token } = await authenticatedApi();
  for (const [lang, copy] of [
    ["id", { queued: "1 menunggu", expired: "Sesi" }],
    ["en", { queued: "1 waiting", expired: "session" }],
  ]) {
    const instruction = `E2E ${lang} offline ${Date.now()}`;
    const create = await api.post(`${API}/dispatch`, {
      data: { truck_code: "T-001", instruction, manager_id: "e2e" },
    });
    expect(create.ok()).toBeTruthy();
    const dispatch = await create.json();
    await openAuthorizedField(page, token, "T-001");
    await page.evaluate((value) => localStorage.setItem("pythia_lang", value), lang);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
    await expect(item).toContainText(instruction, { timeout: 10000 });

    await context.setOffline(true);
    await item.getByTestId("driver-instruction-ready").click();
    await expect(page.getByTestId("driver-queued-count")).toHaveText(copy.queued);
    // The backend no longer knows the token: the queue is kept and the driver is asked to sign in.
    await page.evaluate(() => localStorage.setItem("pythia_field_token", "invalid"));
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByTestId("driver-session-expired")).toContainText(new RegExp(copy.expired, "i"), {
      timeout: 15000,
    });
    await expect(page.getByTestId("driver-queued-count")).toBeVisible();

    // Signed in again, the queued confirmation is delivered once.
    await page.evaluate((value) => localStorage.setItem("pythia_field_token", value), token);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("driver-queued-count")).toHaveCount(0, { timeout: 20000 });
    const status = await (await api.get(`${API}/dispatch/${dispatch.id}/status`)).json();
    expect(status.field_status).toBe("READY");
  }
  await api.dispose();
});

for (const [width, height] of [
  [375, 812],
  [768, 1024],
  [860, 1024],
]) {
  test(`instruction controls fit ${width}px and meet minimum touch targets`, async ({ page }) => {
    const { api, token } = await authenticatedApi();
    const create = await api.post(`${API}/dispatch`, {
      data: { truck_code: "T-112", instruction: `E2E touch target ${width}`, manager_id: "e2e" },
    });
    const dispatch = await create.json();
    await page.setViewportSize({ width, height });
    await openAuthorizedField(page, token, "T-112");

    const item = page.getByTestId(`driver-instruction-${dispatch.id}`);
    await expect(item).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    // Wave 13: a problem goes back through "Can't do this?", which reveals the reason field.
    const cant = item.getByTestId("driver-instruction-cant");
    await expectMinimumTouchTarget(cant);
    await cant.click();
    for (const control of [
      item.getByTestId("driver-instruction-reason"),
      item.getByTestId("driver-instruction-ready"),
      item.getByTestId("driver-instruction-issue"),
      page.getByTestId("driver-tab-instruksi"),
    ]) {
      await expectMinimumTouchTarget(control);
    }
    await api.post(`${API}/dispatch/${dispatch.id}/confirm`, {
      data: { status: "READY", note: "E2E cleanup" },
    });
    await api.dispose();
  });
}

// Wave 13: Operations sends a free-text instruction from its drawer; a double tap still
// persists one dispatch, signed by the operator's role.
test("a new instruction from Operations persists one dispatch despite a double tap", async ({ page }) => {
  const { api, token } = await authenticatedApi();
  const key = `e2e-instruction-${Date.now()}`;
  await page.goto("/");
  await page.evaluate((value) => {
    localStorage.setItem("pythia_token", value);
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_role", "dispatcher");
    localStorage.setItem("pythia_lang", "id");
  }, token);
  await page.goto("/app/operations");
  await page.getByTestId("ops-new-instruction").click();
  const drawer = page.getByTestId("instruction-drawer");
  await expect(drawer).toBeVisible();
  // The truck list fills once the fleet snapshot is in.
  await expect(drawer.getByTestId("instruction-truck")).toHaveValue(/^T-\d+$/, { timeout: 20000 });
  const truck = await drawer.getByTestId("instruction-truck").inputValue();
  await drawer.getByTestId("instruction-text").fill(`Follow up ${key}`);
  await page.evaluate(() => {
    const button = document.querySelector("[data-testid=instruction-send]");
    button.click();
    button.click();
  });
  let created;
  try {
    await expect
      .poll(
        async () => {
          const response = await api.get(`${API}/dispatch/${truck}`);
          expect(response.ok()).toBeTruthy();
          const matches = (await response.json()).filter((dispatch) => dispatch.instruction.includes(key));
          created = matches[0];
          return matches.length;
        },
        { timeout: 15000 },
      )
      .toBe(1);
    await expect(drawer.getByRole("status")).toContainText(truck);
    expect(created.manager_id).toBe("dispatcher");
  } finally {
    if (created)
      await api.post(`${API}/dispatch/${created.id}/confirm`, {
        data: { status: "READY", note: "E2E cleanup" },
      });
    await api.dispose();
  }
});

// The dispatcher sees the driver's answer: READY reads "ready", ISSUE reads "can't" with the
// driver's own note, under the instruction just sent from Operations.
test("the instruction drawer distinguishes the driver's READY from ISSUE and shows the field note", async ({
  page,
}) => {
  test.setTimeout(100000);
  const { api, token } = await authenticatedApi();
  await page.goto("/");
  await page.evaluate((value) => {
    localStorage.setItem("pythia_token", value);
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_role", "dispatcher");
    localStorage.setItem("pythia_lang", "id");
  }, token);
  await page.goto("/app/operations");
  await page.getByTestId("ops-new-instruction").click();
  const drawer = page.getByTestId("instruction-drawer");
  await expect(drawer.getByTestId("instruction-truck")).toHaveValue(/^T-\d+$/, { timeout: 20000 });
  const created = [];
  try {
    for (const status of ["READY", "ISSUE"]) {
      const responsePromise = page.waitForResponse(
        (response) => response.url().endsWith("/api/dispatch") && response.request().method() === "POST",
      );
      await drawer.getByTestId("instruction-text").fill(`E2E answer ${status} ${Date.now()}`);
      await drawer.getByTestId("instruction-send").click();
      const dispatch = await (await responsePromise).json();
      created.push(dispatch.id);
      const answer = drawer.getByTestId("instruction-driver-answer");
      await expect(answer).toHaveText("Sopir: belum menjawab");
      const note = `E2E field ${status} ${Date.now()}`;
      const confirm = await api.post(`${API}/dispatch/${dispatch.id}/confirm`, { data: { status, note } });
      expect(confirm.ok()).toBeTruthy();
      if (status === "READY") {
        await expect(answer).toHaveText("Sopir: siap", { timeout: 25000 });
      } else {
        await expect(answer).toHaveText(`Sopir: tidak bisa, ${note}`, { timeout: 25000 });
      }
      await expect(answer).toHaveAttribute("data-status", status);
    }
  } finally {
    for (const id of created) {
      const response = await api.get(`${API}/dispatch/${id}/status`);
      if (response.ok() && (await response.json()).field_status === "PENDING") {
        await api.post(`${API}/dispatch/${id}/confirm`, { data: { status: "READY", note: "E2E cleanup" } });
      }
    }
    await api.dispose();
  }
});
