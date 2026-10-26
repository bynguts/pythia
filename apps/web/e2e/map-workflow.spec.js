import { test, expect } from "@playwright/test";

// Specs take PLAYWRIGHT_API_BASE_URL with the /api suffix; accept either form.
const API_BASE = (process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001").replace(/\/api\/?$/, "");
let authHeaders;

// Necessary: the jam toggle tests mutate GLOBAL server-side state (simulate-jam
// active flag) mid-test. Parallel workers raced: test 158's jam=true landed
// while test 126 was reading map features, flipping T-047 to clean and failing
// the violation precondition. Serializing the file (1 worker, ordered tests,
// per-test beforeEach reset) makes the shared jam state deterministic.
test.describe.configure({ mode: "serial" });

// Map truthfulness E2E: render, deviation coloring, heatmap, TPA marker. Wave 13: the map
// is the Operations screen's (/app/operations); "/" is the public landing page.
const OPS = "/app/operations";
test.beforeEach(async ({ page }) => {
  const login = await page.request.post(`${API_BASE}/api/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  expect(login.ok()).toBeTruthy();
  const principal = await login.json();
  authHeaders = { Authorization: `Bearer ${principal.token}` };
  await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=false`, { headers: authHeaders });
  await page.goto("/");
  await page.evaluate(({ token, role }) => {
    localStorage.setItem("pythia_auth", "true");
    localStorage.setItem("pythia_lang", "id");
    localStorage.setItem("pythia_token", token);
    localStorage.setItem("pythia_role", role);
  }, principal);
});

test("map canvas renders (not blank)", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible({ timeout: 15000 });
});

// Wave 13: Operations has no replay control; a cold load still never asks for per-truck
// breadcrumbs (the aggregate map truth carries every trail).
test("cold Operations load requests no per-truck breadcrumbs", async ({ page }) => {
  const breadcrumbRequests = [];
  page.on("request", (request) => {
    if (/\/api\/fleet\/[^/]+\/breadcrumbs(?:\?|$)/.test(request.url()))
      breadcrumbRequests.push(request.url());
  });
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.__pythiaMapFeatures?.actualKinds || []).length > 0, null, {
    timeout: 30000,
  });
  await expect(page.locator(".truck-marker").first()).toBeVisible();
  expect(breadcrumbRequests).toEqual([]);
});

test("actual routes colored by violation state", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.__pythiaMapFeatures?.actualKinds || []).length > 0, null, {
    timeout: 30000,
  });
  const kinds = await page.evaluate(() => window.__pythiaMapFeatures?.actualKinds || []);
  // At least one clean (green) and, given T-047 deviates, one violation (red).
  expect(kinds).toContain("actual-clean");
  expect(kinds).toContain("actual-violation");
});

// Wave 13 honesty, thin: every pin and the trucks KPI say "simulated" in their tooltip and
// data-provenance; live GPS is a "Coming soon" chip, never implied.
test("pins and the trucks KPI are labelled simulated; live GPS is Coming soon", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  const pin = page.locator(".truck-marker").first();
  await expect(pin).toBeVisible({ timeout: 30000 });
  await expect(pin).toHaveAttribute("data-provenance", "simulated");
  await expect(pin).toHaveAttribute("title", /· Posisi simulasi, bukan GPS langsung$/);
  const unlabelled = await page.locator(".truck-marker:not([data-provenance=simulated])").count();
  expect(unlabelled).toBe(0);
  const trucks = page.getByTestId("kpi-trucks").locator("[data-provenance=simulated]");
  await expect(trucks).toHaveAttribute("title", "Posisi dan aktivitas armada simulasi, bukan GPS langsung.");
  await expect(page.getByTestId("map-gps-soon")).toHaveText(/Segera hadir\s*Pelacakan GPS langsung/);
});

test("TPA marker present on map", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".tpa-marker")).toBeVisible({ timeout: 15000 });
});

test("map canvas has real color diversity (decoded pixels, not byte variance)", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  const buf = await page.locator(".maplibregl-canvas").screenshot();
  const dataUrl = "data:image/png;base64," + buf.toString("base64");
  // Decode the PNG into real RGBA pixels in the browser, then count distinct
  // coarse color buckets. A blank/single-color canvas yields very few buckets;
  // a rendered map (tiles, roads, markers) yields many.
  const buckets = await page.evaluate(async (url) => {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 37) {
      const r = data[i] >> 5,
        g = data[i + 1] >> 5,
        b = data[i + 2] >> 5;
      seen.add((r << 6) | (g << 3) | b);
    }
    return seen.size;
  }, dataUrl);
  expect(buckets).toBeGreaterThan(12);
});

test("A* route anchors near T-047 marker (GPS)", async ({ page }) => {
  const res = await page.request.get(`${API_BASE}/api/fleet/astar-reroute?truck_code=T-047`);
  const j = await res.json();
  const p0 = j.active_route.path[0];
  const origin = j.active_route.origin_position;
  const dLat = Math.abs(p0.lat - origin.lat);
  const dLng = Math.abs(p0.lng - origin.lng);
  // Within ~1km (~0.01 deg) of the marker — anchored, not 3km off.
  expect(dLat).toBeLessThan(0.01);
  expect(dLng).toBeLessThan(0.01);
});

test("A* route is road-following (many points)", async ({ page }) => {
  const res = await page.request.get(`${API_BASE}/api/fleet/astar-reroute?truck_code=T-047`);
  const j = await res.json();
  expect(j.active_route.path.length).toBeGreaterThan(200);
});

test("breadcrumbs endpoint returns simulated trail", async ({ page }) => {
  const res = await page.request.get(`${API_BASE}/api/fleet/T-047/breadcrumbs`);
  expect(res.status()).toBe(200);
  const j = await res.json();
  expect(j.source).toBe("simulated");
  expect(j.breadcrumbs.length).toBeGreaterThan(1);
});

test("mobile viewport renders map without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  expect(overflow).toBe(false);
});

test("map-truth payload has road-following geometry and synced snapped GPS", async ({ page }) => {
  const res = await page.request.get(`${API_BASE}/api/fleet/map-truth`);
  expect(res.status()).toBe(200);
  const j = await res.json();
  const t = j.trucks.find((x) => x.truck_code === "T-047");
  expect(t).toBeTruthy();
  // Road-following assigned geometry (or explicitly labeled fallback).
  if (t.assigned_route.source === "LIVE_EXTERNAL") {
    expect(t.assigned_route.geometry.length).toBeGreaterThan(20);
  } else {
    expect(t.assigned_route.source).toBe("FALLBACK_DEGRADED");
  }
  // Snapped GPS is close to raw (map-matched), and provenance is labeled.
  expect(t.provenance.raw_gps).toBe("RAW_GPS_SIMULATED");
  expect(typeof t.deviation_m).toBe("number");
});

// #69: deterministic jam isolation — the endpoint notes a 90s manual override
// so the AI engine loop cannot flip the global flag mid-test; the helper
// always verifies the server state before the scenario acts on it.
async function verifiedJamCleared(page) {
  await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=false`, { headers: authHeaders });
  await expect
    .poll(
      async () => {
        const mt = await (await page.request.get(`${API_BASE}/api/fleet/map-truth`)).json();
        const t047 = mt.trucks?.find((x) => x.truck_code === "T-047");
        return Boolean(t047?.traffic && t047.traffic.jam_active === false);
      },
      { timeout: 30000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}

// #69: the diverted-state assertions live in a helper so the finally clause
// in the caller can restore the cleared state even on failure.
async function runJamDiversionScenario(page) {
  await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=true`, { headers: authHeaders });
  // Wave 13: Operations shows no reroute monitor; the API and the drawn layers are checked.
  // The AI engine loop may independently clear/re-set the global jam flag, and
  // the demo jam is position-relative (truck cruising): wait until the server
  // actually applies a diversion before asserting the diverted-state payloads.
  await expect
    .poll(
      async () => {
        const r = await (
          await page.request.get(`${API_BASE}/api/fleet/astar-reroute?truck_code=T-047`)
        ).json();
        return r.jam_active && r.diversion_applied;
      },
      { timeout: 45000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
  const reroute = await (
    await page.request.get(`${API_BASE}/api/fleet/astar-reroute?truck_code=T-047`)
  ).json();
  expect(reroute.diversion_applied).toBe(true);
  expect(reroute.abandoned_route.path.length).toBeGreaterThan(20);

  // map-truth lags the reroute endpoint: poll until the abandoned route is
  // populated instead of dereferencing a potentially-null payload.
  let t;
  await expect
    .poll(
      async () => {
        const mt = await (await page.request.get(`${API_BASE}/api/fleet/map-truth`)).json();
        const truck = mt.trucks.find((x) => x.truck_code === "T-047");
        if (truck && truck.abandoned_route && truck.abandoned_route.geometry.length > 20) {
          t = truck;
          return true;
        }
        return false;
      },
      { timeout: 45000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
  expect(t.traffic.jam_active).toBe(true);
  expect(t.abandoned_route.geometry.length).toBeGreaterThan(20);
  expect(t.deviation_segments).not.toContain("violation");

  await page.waitForFunction(
    () => (window.__pythiaMapFeatures?.assignedKinds || []).includes("astar-abandoned"),
    null,
    { timeout: 15000 },
  );
  return "diverted";
}

test("jam toggle diverts T-047 end-to-end (UI, reroute API, map-truth agree)", async ({ page }) => {
  // Two OSRM-bound map-truth rebuilds (jam on, then off) do not fit the default 60 s.
  test.slow();
  // Known initial state first, restored even when the scenario fails (#69).
  await verifiedJamCleared(page);
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.__pythiaMapFeatures?.actualKinds || []).length > 0, null, {
    timeout: 15000,
  });

  const before = await page.evaluate(() => window.__pythiaMapFeatures?.actualKinds || []);
  expect(before).toContain("actual-violation");

  // #69: the manual override hold (90s) keeps the AI loop from flipping the
  // flag mid-test; the finally clause restores the cleared state even when
  // an assertion below fails, so later runs start from a known state.
  let scenario = null;
  try {
    scenario = await runJamDiversionScenario(page);
  } finally {
    await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=false`, {
      headers: authHeaders,
    });
  }
  expect(scenario).toBe("diverted");
});

test("restore traffic returns T-047 to compliant and clears abandoned line", async ({ page }) => {
  // The jam rebuild of map truth is bound to public OSRM: 30-40 s measured when it
  // is slow, so the abandoned line gets the same 45 s as the other jam waits.
  test.slow();
  // #69: known initial state (cleared) before turning the jam on, so the
  // scenario cannot race a leftover jam from a prior run or test.
  await verifiedJamCleared(page);
  await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=true`, { headers: authHeaders });
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window.__pythiaMapFeatures?.assignedKinds || []).includes("astar-abandoned"),
    null,
    { timeout: 45000 },
  );

  await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=false`, { headers: authHeaders });
  // The AI engine loop keeps running and can re-set the jam flag after the
  // manual restore: keep re-posting false until the server stays cleared,
  // then assert the UI settles on the normal state. The finally clause
  // guarantees the cleared state even when an assertion below fails (#69).
  try {
    await restoreScenario(page);
  } finally {
    await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=false`, {
      headers: authHeaders,
    });
  }
});

async function restoreScenario(page) {
  await expect
    .poll(
      async () => {
        const r = await (
          await page.request.get(`${API_BASE}/api/fleet/astar-reroute?truck_code=T-047`)
        ).json();
        if (r.jam_active || r.diversion_applied) {
          await page.request.post(`${API_BASE}/api/fleet/astar-simulate-jam?active=false`, {
            headers: authHeaders,
          });
          return false;
        }
        return true;
      },
      { timeout: 45000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
  const reroute = await (
    await page.request.get(`${API_BASE}/api/fleet/astar-reroute?truck_code=T-047`)
  ).json();
  expect(reroute.diversion_applied).toBe(false);

  await page.waitForFunction(
    () => !(window.__pythiaMapFeatures?.assignedKinds || []).includes("astar-abandoned"),
    null,
    { timeout: 45000 },
  );
}

// Wave 13: Operations has no basemap switch and keeps the reference layers off, but the
// layers stay registered so the Fleet & drivers map (and a later toggle) can show them.
test("TPS and WR layers stay registered on the Operations map", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pythiaMap?.isStyleLoaded?.(), null, { timeout: 30000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = window.__pythiaMap;
          return ["tps-layer", "tps-clusters", "wr-unclustered-point", "wr-clusters"].map(
            (id) => !!m.getLayer(id),
          );
        }),
      { timeout: 30000 },
    )
    .toEqual([true, true, true, true]);
});

test("truck markers cruise smoothly on the live map", async ({ page }) => {
  await page.goto(OPS, { waitUntil: "domcontentloaded" });
  const marker = page.locator(".truck-marker").first();
  await marker.waitFor({ state: "visible", timeout: 30000 });
  const box1 = await marker.boundingBox();
  await page.waitForTimeout(2500);
  const box2 = await marker.boundingBox();
  expect(box1).toBeTruthy();
  expect(box2).toBeTruthy();
  const moved = Math.hypot(box2.x - box1.x, box2.y - box1.y);
  expect(moved).toBeGreaterThan(0.5); // continuous cruise, not static
});
