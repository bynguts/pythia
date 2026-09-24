import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-001";

// #43: UI transitions must not animate layout properties (width, height,
// min-*, padding). Computed styles of every transitioned property across
// the dispatcher app and driver app are audited.
async function signIn(page, lang = "id") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const principal = await response.json();
  await page.evaluate(({ token, role, lang }) => {
    localStorage.setItem("jwis_auth", "true");
    localStorage.setItem("jwis_lang", lang);
    localStorage.setItem("jwis_token", token);
    localStorage.setItem("jwis_role", role);
  }, { ...principal, lang });
  await page.reload({ waitUntil: "domcontentloaded" });
  return { Authorization: "Bearer " + principal.token };
}

const LAYOUT_PROPS = new Set([
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "top", "left", "right", "bottom",
]);

async function auditTransitions(page, scope) {
  return page.evaluate(({ LAYOUT_PROPS }) => {
    const bad = [];
    document.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      const props = cs.transitionProperty.split(", ").map((p) => p.trim());
      const durations = cs.transitionDuration.split(", ").map((d) => d.trim());
      props.forEach((prop, i) => {
        if (prop === "none") return;
        const hasDuration = durations[i] && durations[i] !== "0s";
        if (LAYOUT_PROPS.includes(prop) && hasDuration) {
          bad.push(`${el.tagName}.${(typeof el.className === "string" ? el.className : "").split(" ")[0]} → ${prop}`);
        }
      });
    });
    return bad;
  }, { LAYOUT_PROPS: [...LAYOUT_PROPS] });
}

test("dispatcher app transitions never animate layout properties", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Prediksi", exact: true }).click();
  await page.waitForTimeout(1500);
  const bad = await auditTransitions(page);
  expect(bad, `layout-property transitions: ${bad.join("; ")}`).toEqual([]);
});

test("driver app progress bar animates without layout properties", async ({ page, context }) => {
  // Driver surfaces the pretrip progress bar only with an active dispatch.
  const headers = await signIn(page);
  const resp = await page.request.get(`${API}/spj?status=aktif`);
  for (const s of (await resp.json()).spj || []) {
    if (s.truck_code === TEST_TRUCK) {
      await page.request.post(`${API}/spj/${s.spj_id}/cancel`, { headers });
    }
  }
  const fleet = await (await page.request.get(`${API}/fleet`)).json();
  const trucks = Array.isArray(fleet) ? fleet : fleet.trucks;
  const truck = trucks.find((t) => t.truck_code === TEST_TRUCK);
  const create = await page.request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: truck.driver_name,
      truck_code: TEST_TRUCK,
      destination: "TPST Bantargebang",
      weigh_on_site: true,
      priority: "normal",
      note: "e2e animation audit",
    },
  });
  expect(create.status()).toBe(201);
  const spj = await create.json();
  try {
    await page.request.post(`${API}/spj/${spj.spj_id}/stops`, {
      headers,
      data: { name: "TPS E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 },
    });
    await page.request.post(`${API}/spj/${spj.spj_id}/activate`, { headers });

    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: -6.29, longitude: 106.79 });
    await page.goto("/driver");
    const pretripLoaded = page.waitForResponse((response) => response.url().includes(`/pretrip/today/${TEST_TRUCK}`));
    await page.locator(`[data-testid="pick-${TEST_TRUCK}"]`).click();
    await pretripLoaded;
    await page.waitForTimeout(800);

    const bad = await auditTransitions(page);
    expect(bad, `layout-property transitions: ${bad.join("; ")}`).toEqual([]);

    // Reduced-motion: layout transitions must stay disabled under
    // prefers-reduced-motion.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await auditTransitions(page);
    expect(reduced).toEqual([]);
  } finally {
    await page.request.post(`${API}/spj/${spj.spj_id}/cancel`, { headers }).catch(() => {});
  }
});
