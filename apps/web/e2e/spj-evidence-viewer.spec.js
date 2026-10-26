// #gap3: supervisors see per-stop evidence photos (fetched with the session token)
// and an approximate geotag is labelled "Lokasi perkiraan, bukan GPS" on the Work orders detail.
import { expect, test } from "@playwright/test";
import { cancelSpjIndependently, disposeCleanupContext } from "./lib/spjCleanup.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const TEST_TRUCK = "T-213";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.afterAll(async () => {
  await disposeCleanupContext();
});

async function login(request, role) {
  const res = await request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test("evidence thumbnails and the approximate-geotag label render in the work order detail", async ({
  page,
}) => {
  const operator = await login(page.request, "dispatcher");
  const driver = await login(page.request, "driver");
  const headers = { Authorization: `Bearer ${operator.token}` };
  const driverHeaders = { Authorization: `Bearer ${driver.token}` };

  const existing = await page.request.get(`${API}/spj?truck_code=${TEST_TRUCK}`, { headers });
  for (const spj of (await existing.json()).spj || []) {
    if (["draft", "aktif"].includes(spj.status)) {
      await page.request.post(`${API}/spj/${spj.spj_id}/cancel`, { headers });
    }
  }
  const create = await page.request.post(`${API}/spj`, {
    headers,
    data: {
      driver_name: "E2E Driver",
      truck_code: TEST_TRUCK,
      destination: "TPST Bantargebang",
      weigh_on_site: false,
      stops: [
        { name: "TPS E2E 1", kecamatan: "Gambir", address: "Jl. E2E 1", lat: -6.17, lng: 106.82 },
        { name: "TPS E2E 2", kecamatan: "Gambir", address: "Jl. E2E 2", lat: -6.18, lng: 106.83 },
      ],
    },
  });
  expect(create.status()).toBe(201);
  const spj = await create.json();
  try {
    expect((await page.request.post(`${API}/spj/${spj.spj_id}/activate`, { headers })).ok()).toBeTruthy();
    const done = await page.request.post(`${API}/spj/${spj.spj_id}/stops/0/complete`, {
      headers: driverHeaders,
      data: {
        evidence: {
          arrival: { photo_name: "a.png", photo_b64: PNG, lat: -6.17, lng: 106.82, approx: true },
          weighing: [],
          officer: { name: "Petugas E2E", photo_name: "o.png", photo_b64: PNG },
        },
      },
    });
    expect(done.ok()).toBeTruthy();

    await page.goto("/");
    await page.evaluate(({ token, role }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", "id");
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
    }, operator);
    await page.goto("/app/work-orders", { waitUntil: "domcontentloaded" });
    await page.getByTestId("wo-search").fill(spj.spj_number);
    await page.getByTestId("wo-row").filter({ hasText: spj.spj_number }).click();

    const detail = page.getByTestId("wo-detail");
    await expect(detail.getByTestId("spj-geotag").first()).toContainText("Lokasi perkiraan, bukan GPS");
    const thumb = detail.getByTestId("spj-evidence-photo-1");
    await expect(thumb.getByRole("img")).toHaveCount(1, { timeout: 15000 });
    const box = await thumb.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await thumb.click();
    await expect(thumb).toHaveAttribute("aria-pressed", "true");
  } finally {
    console.log(`[cleanup] ${spj.spj_number}: ${await cancelSpjIndependently(operator.token, spj.spj_id)}`);
  }
});
