// Operations composition (U0H9au): the old /fleet link lands on Operations; a
// deviation card carries one reroute, drawn on the map only while the card is open, and
// sends it to that driver after a preview the dispatcher may edit; the head's buttons reach
// the existing flows; the Indonesian screen has no English backend prose; phones stack the
// panels under the map and desktops frame the fleet. The shell's nav and profile menu are
// covered by routing.spec.js.
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function signIn(page, path = "/app/operations") {
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
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

// One deviation decision with a computed route: the snapshot's alert and the needs-you item
// share the id, as the API's do (ALT-<truck>).
const DECISION = {
  id: "ALT-T-047",
  type: "route_deviation",
  severity: "critical",
  truck_code: "T-047",
  title: "T-047 deviated from assigned corridor",
  description: "Truck is 2924 meters from the assigned corridor.",
  distance_meters: 2924,
  sustained: false,
  status: "active",
  recommended_routes: [
    {
      code: "B",
      name: "Route B - Daan Mogot Recovery",
      eta_minutes: 95,
      distance_km: 34.7,
      source: "fallback",
      eta_source: "fallback_estimate",
      path: [
        { lat: -6.221, lng: 106.785 },
        { lat: -6.21, lng: 106.81 },
        { lat: -6.195, lng: 106.802 },
      ],
    },
  ],
};

const FEED = {
  date: "2026-01-01",
  counts: { all: 1, urgent: 0, trucks: 1, gate: 0, tps: 0 },
  items: [
    {
      id: "ALT-T-047",
      kind: "deviation",
      category: "trucks",
      severity: "normal",
      truck_code: "T-047",
      spj_id: null,
      created_at: null,
      facts: { distance_meters: 2924 },
      actions: ["send_route", "mark_handled"],
      classification: "SIMULATED",
    },
  ],
};

async function stubDecision(page) {
  await page.route(/\/api\/ops\/needs-you$/, (route) => route.fulfill({ json: FEED }));
  await page.route(/\/api\/command-center(\?|$)/, async (route) => {
    try {
      const response = await route.fetch();
      const snapshot = await response.json();
      const alerts = snapshot.alerts.filter((alert) => alert.truck_code !== "T-047");
      await route.fulfill({ response, json: { ...snapshot, alerts: [DECISION, ...alerts] } });
    } catch {
      // The sign-in reload can abandon an in-flight snapshot request; the next poll is stubbed.
    }
  });
}

const deviation = (page) => page.locator('[data-testid=action-row][data-kind="deviation"]');

test("the old /fleet link lands on Operations, marked current in the nav", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "/fleet");
  await expect(page).toHaveURL(/\/app\/operations$/);
  await expect(page.getByTestId("fleet-workspace")).toBeVisible();
  await expect(page.getByTestId("nav-operations")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("main")).toHaveCount(1);
});

test("a deviation has one reroute, drawn on the map only while its card is open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubDecision(page);
  await signIn(page);
  const card = deviation(page);
  await expect(card.getByTestId("decision-route-name")).toHaveText(
    "Lewat Rute B · pemulihan via Daan Mogot: 34,7 km, 95 mnt.",
    { timeout: 30000 },
  );
  await expect(card).toContainText("T-047 keluar dari koridornya");
  await expect(card.getByTestId("needs-action-send_route")).toBeEnabled();
  const routeRow = page.locator('[data-testid=map-legend-row][data-layer="osrm"]');
  await expect(routeRow).toHaveText("Rute usulan");

  // Collapsing the card removes its suggestion, and the route leaves the map and the legend.
  await card.locator(".ops-item-title").click();
  await expect(card).not.toHaveClass(/is-open/);
  await expect(card.getByTestId("needs-suggestion")).toHaveCount(0);
  await expect(routeRow).toHaveCount(0);
  await card.locator(".ops-item-title").click();
  await expect(routeRow).toHaveCount(1);
});

// The reroute is previewed as the driver will read it, may be edited, and goes
// to that one driver only (POST /api/driver/messages), then the follow-up is logged.
test("Send route to driver previews the message, sends the edited text and logs the follow-up", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubDecision(page);
  const writes = [];
  for (const [name, pattern] of [
    ["driver-message", /\/api\/driver\/messages$/],
    ["follow-up", /\/api\/alert\/follow-up$/],
  ]) {
    await page.route(pattern, async (route) => {
      writes.push({ name, body: route.request().postDataJSON() });
      await route.fulfill({ json: { ok: true } });
    });
  }
  await signIn(page);
  const card = deviation(page);
  await expect(card.getByTestId("needs-action-send_route")).toBeEnabled({ timeout: 30000 });
  await card.getByTestId("needs-action-send_route").click();
  const preview = card.getByTestId("needs-send-preview");
  await expect(preview).toContainText("Kirim ke sopir T-047?");
  await expect(preview.getByTestId("send-preview-to")).toContainText("Sopir T-047 · aplikasi sopir");
  await expect(preview.getByTestId("send-preview-text")).toContainText("Rute B · pemulihan via Daan Mogot");
  expect(writes).toEqual([]);

  await preview.getByTestId("send-preview-edit").click();
  const edited = "Gunakan Rute B lewat Daan Mogot, hindari Jl. Panjang. Konfirmasi setelah diterima.";
  await preview.getByTestId("send-preview-input").fill(edited);
  await preview.getByTestId("send-preview-send").click();
  // #needs-you: sending the route handles the deviation; the confirmation stays above the list.
  await expect(page.getByTestId("needs-you-notice")).toHaveText("Rute terkirim ke T-047. Ditandai selesai.");
  expect(writes.map((write) => write.name)).toEqual(["driver-message", "follow-up"]);
  expect(writes[0].body).toMatchObject({
    truck_code: "T-047",
    text: edited,
    kind: "instruction",
    instruction_kind: "use_route",
  });
  expect(writes[1].body).toMatchObject({ alert_id: "ALT-T-047", status: "RESOLVED" });
});

test("Dismiss on the route preview sends nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubDecision(page);
  const writes = [];
  await page.route(/\/api\/(driver\/messages|dispatch|alert\/follow-up)$/, async (route) => {
    writes.push(route.request().url());
    await route.fulfill({ json: { ok: true } });
  });
  await signIn(page);
  const card = deviation(page);
  await expect(card.getByTestId("needs-action-send_route")).toBeEnabled({ timeout: 30000 });
  await card.getByTestId("needs-action-send_route").click();
  await card.getByTestId("send-preview-dismiss").click();
  await expect(card.getByTestId("needs-send-preview")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("New instruction sends to one truck", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sent = [];
  await page.route(/\/api\/dispatch$/, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await signIn(page);
  await page.getByTestId("ops-new-instruction").click();
  const drawer = page.getByTestId("instruction-drawer");
  await expect(drawer).toBeVisible();
  const truck = page.getByTestId("instruction-truck");
  await expect(truck.locator("option").first()).toHaveText(/^T-\d+/, { timeout: 30000 });
  const code = await truck.inputValue();
  await expect(page.getByTestId("instruction-send")).toBeDisabled();
  await page.getByTestId("instruction-text").fill("Lanjut ke TPS berikutnya setelah titik ini.");
  await page.getByTestId("instruction-send").click();
  await expect(drawer.getByRole("status")).toHaveText(
    `Terkirim ke ${code}. Sopir mengonfirmasi di aplikasi.`,
  );
  expect(sent).toEqual([
    {
      truck_code: code,
      instruction: "Lanjut ke TPS berikutnya setelah titik ini.",
      manager_id: "dispatcher",
    },
  ]);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

// "Message drivers" posts free text to the WhatsApp alert group; it says plainly when the
// gateway is offline or no group is chosen (with the way to choose one).
test("Message drivers posts to the WhatsApp group and names a failure honestly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const answers = [
    { status: 503, json: { detail: "The WhatsApp gateway did not deliver the summary." } },
    { status: 409, json: { detail: "Choose an alert group before sending a summary." } },
  ];
  const sent = [];
  await page.route(/\/api\/whatsapp\/summary$/, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill(answers.shift());
  });
  await signIn(page);
  await page.getByTestId("ops-message-drivers").click();
  const drawer = page.getByTestId("message-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("message-send")).toBeDisabled();
  await page.getByTestId("message-text").fill("Hujan di rute timur, hati-hati.");
  await page.getByTestId("message-send").click();
  await expect(page.getByTestId("message-error")).toHaveText(
    "Gateway WhatsApp offline. Pesan tidak terkirim.",
  );
  expect(sent).toEqual([{ text: "Hujan di rute timur, hati-hati.", lang: "id" }]);
  await page.getByTestId("message-send").click();
  await expect(page.getByTestId("message-error")).toHaveText("Belum ada grup WhatsApp yang dipilih.");
  await page.getByTestId("message-settings").click();
  await expect(page).toHaveURL(/\/app\/settings\?tab=whatsapp$/);
});

// A double tap on Send posts one WhatsApp message, not two.
test("Message drivers sends one WhatsApp message despite a double tap", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let posts = 0;
  await page.route(/\/api\/whatsapp\/summary$/, async (route) => {
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 200, json: { delivered: true } });
  });
  await signIn(page);
  await page.getByTestId("ops-message-drivers").click();
  await page.getByTestId("message-text").fill("Gerbang TPA padat, tahan 15 menit.");
  await page.evaluate(() => {
    const button = document.querySelector("[data-testid=message-send]");
    button.click();
    button.click();
  });
  await expect(page.getByTestId("message-text")).toHaveValue("");
  expect(posts).toBe(1);
});

test("the Indonesian Operations screen shows no English backend prose or engineering jargon", async ({
  page,
}) => {
  await stubDecision(page);
  await signIn(page);
  await expect(deviation(page).getByTestId("decision-route-name")).toContainText("Rute B", {
    timeout: 30000,
  });
  await expect(page.getByTestId("needs-you")).toContainText("Perlu Anda");
  await expect(page.getByTestId("kpi-trucks")).toContainText("Truk di jalan");
  const leaks =
    /deviated|Hauling|Maintenance hold|Recovery|Route [ABC]\b|Confidence|Auto-detected|OSRM|A\*|auto_reroute|\bseed\b|real-time|Needs you|Good (morning|afternoon|evening)|Trucks on route|Coming soon/;
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(leaks);
});

for (const width of [320, 390]) {
  test(`at ${width} px the page never scrolls sideways and the panels sit under the map`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await stubDecision(page);
    await signIn(page);
    await expect(deviation(page).getByTestId("decision-route-name")).toBeVisible({ timeout: 30000 });
    const geometry = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const stage = box("[data-testid=fleet-map-stage]");
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        needsBelowMap: box("[data-testid=needs-you]").top >= stage.bottom - 1,
        gateBelowMap: box(".ops-corner").top >= stage.bottom - 1,
      };
    });
    expect(geometry).toEqual({ overflow: 0, needsBelowMap: true, gateBelowMap: true });
    for (const button of await page.getByTestId("needs-you").getByRole("button").all()) {
      const buttonBox = await button.boundingBox();
      if (!buttonBox) continue;
      expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    }
  });
}

// Lead visual review: the first view frames the fleet in the map area the panels leave free,
// instead of a few trucks in a corner or under the needs-you panel.
for (const width of [1280, 1440]) {
  test(`at ${width} px the fleet is framed beside the needs-you panel`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await expect(page.locator(".truck-marker").first()).toBeVisible({ timeout: 60000 });
    await page.waitForTimeout(1500);
    const framing = await page.evaluate(() => {
      const stage = document.querySelector("[data-testid=fleet-map-stage]").getBoundingClientRect();
      const panel = document.querySelector("[data-testid=needs-you]").getBoundingClientRect();
      const markers = [...document.querySelectorAll(".truck-marker")].map((m) => m.getBoundingClientRect());
      const inside = markers.filter(
        (r) =>
          r.left >= stage.left && r.right <= stage.right && r.top >= stage.top && r.bottom <= stage.bottom,
      );
      const xs = inside.map((r) => r.left);
      return {
        total: markers.length,
        inside: inside.length,
        underPanel: inside.filter((r) => r.right <= panel.right).length,
        spread: xs.length ? (Math.max(...xs) - Math.min(...xs)) / stage.width : 0,
      };
    });
    expect(framing.total).toBeGreaterThan(5);
    expect(framing.inside / framing.total).toBeGreaterThan(0.8);
    expect(framing.underPanel / framing.total).toBeLessThan(0.2);
    expect(framing.spread).toBeGreaterThan(0.3);
  });
}
