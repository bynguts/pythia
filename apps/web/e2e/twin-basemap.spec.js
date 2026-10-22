// gsc-2026 P2 E7: open city base for the twin — the "Satellite + relief" toggle exists, automation keeps the deterministic offline style, the imagery licence credit is visible on the map when the satellite base is on, and a failing imagery host falls back to the street base.
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const STYLE_URL = "https://tiles.openfreemap.org/**";
const IMAGERY_URL = "https://tiles.maps.eox.at/**";
const DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/**";
const REMOTE_BASE = /openfreemap\.org|tiles\.maps\.eox\.at|elevation-tiles-prod/;

// Stub street style: no sources, so nothing else leaves the machine.
const STUB_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "stub-bg", type: "background", paint: { "background-color": "#dfe5e1" } }],
};

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// Solid-colour 256×256 PNG, built here so the stub tiles need no fixture file.
function solidPng([r, g, b]) {
  const size = 256;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function signIn(page, lang = "en") {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
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

async function waitForTwin(page) {
  await page.waitForFunction("window.__pythiaTwin && window.__pythiaTwin.ready", null, { timeout: 45000 });
}

function trackRemoteBase(page) {
  const urls = [];
  page.on("request", (request) => {
    if (REMOTE_BASE.test(request.url())) urls.push(request.url());
  });
  return urls;
}

async function stubStreetStyle(page) {
  await page.route(STYLE_URL, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(STUB_STYLE) }),
  );
}

test("automation keeps the deterministic offline base and the satellite toggle off", async ({ page }) => {
  const remote = trackRemoteBase(page);
  await signIn(page);
  await page.goto("/twin");
  await waitForTwin(page);

  await expect(page.getByTestId("twin-map")).toHaveAttribute("data-city-base", "offline");
  const toggle = page.getByTestId("twin-base-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText("Satellite + relief");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const box = await toggle.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("twin-imagery-credit")).toHaveCount(0);
  expect(remote).toEqual([]);
});

test("satellite + relief shows the imagery licence on the map and uses only the keyless sources", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const remote = trackRemoteBase(page);
  await stubStreetStyle(page);
  await page.route(IMAGERY_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: solidPng([92, 110, 100]) }),
  );
  // Terrarium: rgb(128, 0, 0) decodes to 0 m.
  await page.route(DEM_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: solidPng([128, 0, 0]) }),
  );

  await signIn(page);
  await page.goto("/twin?basemap=streets");
  await waitForTwin(page);
  const map = page.getByTestId("twin-map");
  await expect(map).toHaveAttribute("data-city-base", "streets");

  const toggle = page.getByTestId("twin-base-toggle");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveAttribute("data-city-base", "satellite");

  const credit = page.getByTestId("twin-imagery-credit");
  await expect(credit).toBeVisible();
  await expect(credit).toContainText("2016 imagery, not current conditions.");
  await expect(credit).toContainText("EOxCloudless 2016 by EOX IT Services GmbH");
  await expect(credit).toContainText("contains modified Copernicus Sentinel data 2016");
  await expect(credit).toContainText("CC BY 4.0");
  await expect(credit).toContainText("SRTM & GMTED2010 courtesy of USGS");
  // The credit sits on the map window, not off-screen.
  const stage = await page.locator(".twin-viewport").boundingBox();
  const creditBox = await credit.boundingBox();
  expect(creditBox.y).toBeGreaterThanOrEqual(stage.y);
  expect(creditBox.y + creditBox.height).toBeLessThanOrEqual(stage.y + stage.height + 1);

  // Only the free, keyless hosts: the CC BY 2016 mosaic and the terrarium DEM.
  await expect
    .poll(() => remote.filter((url) => url.includes("tiles.maps.eox.at")).length)
    .toBeGreaterThan(0);
  await expect.poll(() => remote.filter((url) => url.includes("/terrarium/")).length).toBeGreaterThan(0);
  for (const url of remote.filter((u) => u.includes("tiles.maps.eox.at")))
    expect(url).toContain("/s2cloudless_3857/");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(map).toHaveAttribute("data-city-base", "streets");
  await expect(credit).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the satellite toggle and credit are localized in Indonesian", async ({ page }) => {
  await stubStreetStyle(page);
  await page.route(IMAGERY_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: solidPng([92, 110, 100]) }),
  );
  await page.route(DEM_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: solidPng([128, 0, 0]) }),
  );
  await signIn(page, "id");
  await page.goto("/twin?basemap=streets");
  await waitForTwin(page);
  const toggle = page.getByTestId("twin-base-toggle");
  await expect(toggle).toHaveText("Satelit + relief");
  await toggle.click();
  await expect(page.getByTestId("twin-imagery-credit")).toContainText("Citra 2016, bukan kondisi terkini.");
});

test("a failing imagery host falls back to the street base", async ({ page }) => {
  await stubStreetStyle(page);
  await page.route(IMAGERY_URL, (route) => route.abort("failed"));
  await page.route(DEM_URL, (route) => route.abort("failed"));
  await signIn(page);
  await page.goto("/twin?basemap=streets");
  await waitForTwin(page);

  const toggle = page.getByTestId("twin-base-toggle");
  await toggle.click();
  await expect(page.getByText("Satellite imagery unavailable: showing the street basemap.")).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByTestId("twin-map")).toHaveAttribute("data-city-base", "streets");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("twin-imagery-credit")).toHaveCount(0);
});
