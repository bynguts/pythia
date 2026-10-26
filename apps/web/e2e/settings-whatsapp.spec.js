// wave9 settings: Settings (Pengaturan) replaces the audit workspace in the rail and is where an
// operator connects WhatsApp. Every gateway answer here is stubbed with page.route, and the
// writes (alert group, test send, logout, gateway start) never reach a real gateway.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PROVENANCE = { classification: "UNOFFICIAL_CLIENT", label: "Baileys" };

async function signIn(page, role, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    },
    { ...principal, lang },
  );
}

function status(linkState, extra = {}) {
  return {
    configured: true,
    connected: linkState === "connected",
    link_state: linkState,
    linked_account: null,
    alert_group: { jid: "12036****0042@g.us", source: "contacts_file" },
    message: "WhatsApp gateway is offline: <urlopen error [WinError 10061] refused>",
    provider: "baileys",
    state: null,
    provenance: PROVENANCE,
    ...extra,
  };
}

// Serves `body()` for the status read and counts the reads.
async function stubStatus(page, body) {
  const calls = { count: 0 };
  await page.route("**/whatsapp/status", (route) => {
    calls.count += 1;
    return route.fulfill({ json: typeof body === "function" ? body() : body });
  });
  return calls;
}

test.beforeEach(async ({ page }) => {
  // Safety net: no write reaches a real gateway unless a test stubs it on top.
  for (const path of [
    "**/whatsapp/logout",
    "**/whatsapp/test",
    "**/whatsapp/alert-group",
    "**/whatsapp/gateway/start",
  ]) {
    await page.route(path, (route) => route.abort());
  }
});

test("Settings opens on Integrations: live statuses and two Coming soon rows, no Audit workspace", async ({
  page,
}) => {
  await signIn(page, "dispatcher");
  await page.goto("/app/settings", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();
  await expect(page.getByTestId("settings-tab-integrations")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("integration-whatsapp")).toBeVisible();
  for (const id of ["gps", "weighbridge"]) {
    await expect(page.getByTestId(`integration-${id}`)).toContainText("Segera hadir");
  }
  await expect(page.getByTestId("settings-nav")).not.toContainText("Audit workspace");
  // Manage opens the WhatsApp section in place.
  await expect(page.getByTestId("settings-whatsapp")).toHaveCount(0);
  await page.getByTestId("settings-whatsapp-manage").click();
  await expect(page.getByTestId("settings-whatsapp")).toBeVisible();
});

test("old /audit links land on Settings → data sources, query kept", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/audit?lang=en", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/settings\?lang=en&tab=data$/);
  await expect(page.getByTestId("settings-tab-data")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Data sources & model" })).toBeVisible({ timeout: 15000 });
  // Collapsed by default; the honesty labels are one tap away.
  await expect(page.getByTestId("model-card")).toBeHidden();
  await page.getByTestId("model-card-disclosure").locator("summary").click();
  await expect(page.getByTestId("model-card")).toContainText("Calibrated-synthetic");
});

test("gateway offline shows a human state and a Connect button, never the raw error or a command", async ({
  page,
}) => {
  await signIn(page, "administrator");
  await stubStatus(page, status("offline"));
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  const state = page.getByTestId("settings-wa-status");
  await expect(state).toHaveAttribute("data-state", "offline");
  await expect(state).toHaveText("Gateway WhatsApp belum berjalan");
  const offline = page.getByTestId("settings-wa-offline");
  await expect(offline.getByRole("button", { name: "Hubungkan WhatsApp" })).toBeVisible();
  await expect(offline).not.toContainText("npm start");
  await expect(page.locator("main")).not.toContainText("urlopen");
  await expect(page.locator("main")).not.toContainText("WinError");
  // The unofficial transport stays disclosed.
  await expect(page.getByTestId("settings-whatsapp")).toContainText("tidak resmi");
});

// The founder pairs WhatsApp without a terminal: Connect starts the gateway on the server,
// the page shows it starting, and the status poll brings the QR code.
test("Connect WhatsApp starts the gateway once, then the QR code appears", async ({ page }) => {
  await signIn(page, "administrator");
  let current = status("offline", { gateway_process: { managed: "local", running: false, exit_code: null } });
  await stubStatus(page, () => current);
  let starts = 0;
  await page.route("**/whatsapp/gateway/start", (route) => {
    starts += 1;
    current = status("offline", { gateway_process: { managed: "local", running: true, exit_code: null } });
    return route.fulfill({ json: { started: true, state: "starting" } });
  });
  await page.route("**/whatsapp/qr", (route) => route.fulfill({ json: { state: "qr", qr: PNG_1PX } }));
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });

  const connect = page.getByTestId("settings-wa-connect");
  await connect.click();
  await expect(connect).toHaveText("Menjalankan gateway…");
  await expect(connect).toBeDisabled();
  expect(starts).toBe(1);

  current = status("pairing", { state: "qr" });
  await expect(page.getByTestId("settings-wa-qr")).toBeVisible({ timeout: 12000 });
  await expect(page.getByTestId("settings-wa-offline")).toHaveCount(0);
  expect(starts).toBe(1);
});

for (const [code, detail] of [
  [
    409,
    "The WhatsApp gateway is managed externally (OPENWA_BASE_URL is not this machine); start it where it runs.",
  ],
  [503, "Node.js is not installed on the server (node is not on PATH)."],
]) {
  test(`a ${code} from Connect WhatsApp shows the server's reason and allows a retry`, async ({ page }) => {
    await signIn(page, "administrator");
    await stubStatus(page, status("offline"));
    await page.route("**/whatsapp/gateway/start", (route) =>
      route.fulfill({ status: code, json: { detail } }),
    );
    await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
    await page.getByTestId("settings-wa-connect").click();
    await expect(page.getByTestId("settings-wa-connect-error")).toHaveText(detail);
    await expect(page.getByTestId("settings-wa-connect")).toBeEnabled();
    await expect(page.getByTestId("settings-wa-connect")).toHaveText("Hubungkan WhatsApp");
  });
}

// The dispatcher pairs WhatsApp without an administrator; the supervisor still cannot.
test("a dispatcher sees the gateway offline with a Connect button", async ({ page }) => {
  await signIn(page, "dispatcher");
  await stubStatus(page, status("offline"));
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-connect")).toBeVisible();
  await expect(page.getByTestId("settings-wa-readonly")).toHaveCount(0);
  await expect(page.getByTestId("settings-wa-offline")).not.toContainText("Minta");
});

test("a supervisor sees the gateway offline without a Connect button", async ({ page }) => {
  await signIn(page, "supervisor");
  await stubStatus(page, status("offline"));
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-offline")).toContainText(
    "Minta pengatur armada atau administrator menghubungkan",
  );
  await expect(page.getByTestId("settings-wa-connect")).toHaveCount(0);
});

test("pairing shows the QR, polls while waiting and stops when hidden or left", async ({ page }) => {
  await signIn(page, "administrator");
  const calls = await stubStatus(page, status("pairing", { state: "qr" }));
  let qrReads = 0;
  await page.route("**/whatsapp/qr", (route) => {
    qrReads += 1;
    return route.fulfill({ json: { state: "qr", qr: PNG_1PX } });
  });
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-status")).toHaveText("Menunggu pemindaian QR");
  const qr = page.getByTestId("settings-wa-qr");
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute("src", PNG_1PX);
  await expect(qr).toHaveAttribute("alt", "Kode QR untuk menautkan WhatsApp ke Pythia");

  const first = calls.count;
  await expect.poll(() => calls.count, { timeout: 12000 }).toBeGreaterThan(first);
  expect(qrReads).toBeGreaterThan(1);

  // A hidden tab stops polling.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = calls.count;
  await page.waitForTimeout(5000);
  expect(calls.count).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls.count).toBeGreaterThan(hidden);

  // Leaving Settings stops it too.
  await page.locator('.cx-sidebar a[href="/app/fleet"]').click();
  await expect(page).toHaveURL(/\/app\/fleet/);
  const left = calls.count;
  await page.waitForTimeout(5000);
  expect(calls.count).toBe(left);
});

test("connected: masked number, group picker, test send and confirmed disconnect", async ({ page }) => {
  await signIn(page, "administrator");
  let current = status("connected", {
    state: "open",
    linked_account: "62812****7890@s.whatsapp.net",
    alert_group: { jid: "6281234567890-1620000000@g.us", source: "placeholder" },
  });
  await stubStatus(page, () => current);
  const groups = [
    { jid: "120363000000000001@g.us", subject: "Posko Utara", selected: false },
    { jid: "120363000000000042@g.us", subject: "Pythia Ops", selected: false },
  ];
  await page.route("**/whatsapp/groups", (route) =>
    route.fulfill({ json: { connected: true, groups, message: "2 groups found" } }),
  );
  const writes = [];
  await page.route("**/whatsapp/alert-group", (route) => {
    writes.push(route.request().postDataJSON());
    groups[1].selected = true;
    current = { ...current, alert_group: { jid: "12036****0042@g.us", source: "contacts_file" } };
    return route.fulfill({ json: { alert_group: current.alert_group } });
  });
  await page.route("**/whatsapp/test", (route) =>
    route.fulfill({ json: { sent: true, recipient: "12036****0042@g.us" } }),
  );
  let loggedOut = 0;
  await page.route("**/whatsapp/logout", (route) => {
    loggedOut += 1;
    current = status("pairing", { state: "qr" });
    return route.fulfill({ json: { logged_out: true, state: "starting" } });
  });
  await page.route("**/whatsapp/qr", (route) => route.fulfill({ json: { state: "qr", qr: PNG_1PX } }));

  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-status")).toHaveText("Terhubung");
  await expect(page.getByTestId("settings-wa-account")).toHaveText("+62812****7890");
  await expect(page.getByTestId("settings-wa-group")).toContainText("Belum dipilih");
  await expect(page.getByTestId("settings-wa-group-count")).toHaveText("2 grup ditemukan");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/\d{9,}/);

  await page.getByLabel("Pilih grup peringatan").selectOption({ label: "Pythia Ops" });
  await page.getByRole("button", { name: "Simpan grup" }).click();
  await expect(page.getByTestId("settings-wa-notice")).toHaveText("Grup peringatan disimpan.");
  expect(writes).toEqual([{ group_jid: "120363000000000042@g.us" }]);
  await expect(page.getByTestId("settings-wa-group")).toContainText("Pythia Ops");

  await page.getByRole("button", { name: "Kirim pesan uji" }).click();
  await expect(page.getByTestId("settings-wa-notice")).toHaveText("Pesan uji terkirim ke grup peringatan.");

  await page.getByRole("button", { name: "Putuskan", exact: true }).click();
  await page.getByRole("button", { name: "Batal" }).click();
  expect(loggedOut).toBe(0);
  await page.getByRole("button", { name: "Putuskan", exact: true }).click();
  await expect(page.locator(".settings-confirm")).toContainText("Putuskan WhatsApp dari Pythia?");
  await page.getByRole("button", { name: "Ya, putuskan" }).click();
  await expect(page.getByTestId("settings-wa-notice")).toContainText("WhatsApp diputus");
  expect(loggedOut).toBe(1);
  await expect(page.getByTestId("settings-wa-qr")).toBeVisible();
});

test("a supervisor sees WhatsApp read-only", async ({ page }) => {
  await signIn(page, "supervisor");
  await stubStatus(page, status("connected", { state: "open" }));
  let privileged = 0;
  await page.route(/\/whatsapp\/(groups|qr)$/, (route) => {
    privileged += 1;
    return route.abort();
  });
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-status")).toHaveText("Terhubung");
  await expect(page.getByTestId("settings-wa-readonly")).toContainText(
    "hanya pengatur armada atau administrator",
  );
  await expect(page.getByTestId("settings-wa-manage")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Putuskan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Kirim pesan uji" })).toHaveCount(0);
  expect(privileged).toBe(0);

  await page.getByTestId("settings-tab-team").click();
  await expect(page.getByTestId("settings-role-supervisor")).toContainText("Peran Anda");
  await expect(page.getByTestId("settings-role-administrator")).toContainText("Mengelola integrasi & kontak");
});

test("every Settings section fits a 390 px phone with 44 px targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "administrator");
  await stubStatus(page, status("pairing", { state: "qr" }));
  await page.route("**/whatsapp/qr", (route) => route.fulfill({ json: { state: "qr", qr: PNG_1PX } }));
  await page.goto("/settings?tab=whatsapp", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-wa-qr")).toBeVisible();
  for (const tab of ["integrations", "team", "data"]) {
    await page.getByTestId(`settings-tab-${tab}`).click();
    await expect(page.getByTestId(`settings-tab-${tab}`)).toHaveAttribute("aria-current", "page");
    if (tab === "data") {
      for (const id of ["model-card-disclosure", "source-registry-disclosure"]) {
        await page.getByTestId(id).locator("summary").click();
      }
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${tab} overflows`).toBeLessThanOrEqual(0);
    const box = await page.getByTestId(`settings-tab-${tab}`).boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
