// #drv6-photo: audit gap 1 (D1). Evidence photos are shrunk on the phone
// (longest side 1280 px, JPEG ~0.7) with the size shown; a full phone storage
// is reported in Indonesian and keeps the form; queued photos live in
// IndexedDB, not in localStorage.
import { expect, test } from "@playwright/test";
import {
  API,
  apiLogin,
  authHeaders,
  cancelSpj,
  createActiveSpj,
  finishPretrip,
  openDriver,
  PHOTO,
} from "./lib/driverSpj.js";

const STOP = { name: "TPS Foto E2E", kecamatan: "Cilandak", address: "Jl. E2E", lat: -6.29, lng: 106.79 };

// A camera-sized JPEG (3000×2250, mild noise so it does not compress away).
async function cameraJpeg(page) {
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2250;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const p = i / 4;
      const x = p % canvas.width;
      const noise = (Math.random() * 24) | 0;
      img.data[i] = (x / 12 + noise) & 255;
      img.data[i + 1] = (p / 30000 + noise) & 255;
      img.data[i + 2] = (128 + noise) & 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, "base64");
}

async function imageSize(page, dataUrl) {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, dataUrl);
}

test("a camera-sized photo is shrunk to a 1280 px JPEG before upload and its size is shown", async ({
  page,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-240", [STOP]);
  try {
    await openDriver(page, request, { token, truck: "T-240" });
    await finishPretrip(page);
    const card = page.getByTestId("stop-0");
    await card.getByTestId("stop-start").click();

    const big = await cameraJpeg(page);
    expect(big.length).toBeGreaterThan(1024 * 1024);
    await card
      .getByTestId("arrival-input")
      .setInputFiles({ name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: big });
    // Shown size: the shrunk photo and the original (Indonesian: "asli").
    await expect(card.getByTestId("photo-size").first()).toContainText("asli");
    await expect(card.getByTestId("photo-size").first()).toContainText(/MB\)/);

    await card
      .getByTestId("officer-input")
      .setInputFiles({ name: "IMG_0002.jpg", mimeType: "image/jpeg", buffer: big });
    await card.getByLabel("Nama Petugas").fill("Petugas Foto");

    const posted = page.waitForRequest((r) => r.url().includes(`/spj/${spj.spj_id}/stops/0/complete`));
    await card.getByRole("button", { name: "Selesaikan Titik" }).click();
    const body = (await posted).postDataJSON();
    const arrival = body.evidence.arrival.photo_b64;
    expect(arrival.startsWith("data:image/jpeg")).toBe(true);
    // ~0.7 JPEG of a 1280 px frame: far below the original camera file.
    expect(arrival.length * 0.75).toBeLessThan(600 * 1024);
    const size = await imageSize(page, arrival);
    expect(Math.max(size.width, size.height)).toBe(1280);
    expect(body.evidence.officer.photo_name).toBe("IMG_0002.jpg");

    await expect(page.getByTestId("delivery-card")).toBeVisible({ timeout: 15000 });
  } finally {
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("a full phone storage is reported in Indonesian and the stop form is kept", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-241", [STOP]);
  // No IndexedDB and a localStorage that refuses the outbox: the worst case.
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "pythia_driver_outbox") {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  try {
    await openDriver(page, request, { token, truck: "T-241" });
    await finishPretrip(page);
    const card = page.getByTestId("stop-0");
    await card.getByTestId("stop-start").click();
    await card.getByTestId("arrival-input").setInputFiles(PHOTO);
    await card.getByTestId("officer-input").setInputFiles(PHOTO);
    await card.getByLabel("Nama Petugas").fill("Petugas Penuh");

    await context.setOffline(true);
    await card.getByRole("button", { name: "Selesaikan Titik" }).click();
    await expect(card.getByTestId("stop-storage-full")).toContainText("Memori HP penuh");
    // Not silent, not queued, not completed: the evidence is still in the form.
    await expect(page.getByTestId("driver-queued-count")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Selesaikan Titik" })).toBeEnabled();
    await expect(card.getByTestId("stop-queued-note")).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await cancelSpj(request, token, spj.spj_id);
  }
});

test("queued photos go to IndexedDB, the outbox index stays small, and the stop syncs", async ({
  page,
  context,
  request,
}) => {
  const { token } = await apiLogin(request);
  const spj = await createActiveSpj(request, token, "T-242", [STOP]);
  try {
    await openDriver(page, request, { token, truck: "T-242" });
    await finishPretrip(page);
    const card = page.getByTestId("stop-0");
    await card.getByTestId("stop-start").click();
    await card.getByTestId("arrival-input").setInputFiles(PHOTO);
    await card.getByTestId("officer-input").setInputFiles(PHOTO);
    await card.getByLabel("Nama Petugas").fill("Petugas IDB");

    await context.setOffline(true);
    await card.getByRole("button", { name: "Selesaikan Titik" }).click();
    await expect(page.getByTestId("driver-queued-count")).toBeVisible();
    const raw = await page.evaluate(() => localStorage.getItem("pythia_driver_outbox"));
    expect(raw).toContain('"$photo"');
    expect(raw).not.toContain("data:image");

    await context.setOffline(false);
    await expect(async () => {
      const detail = await (
        await request.get(`${API}/spj/${spj.spj_id}`, { headers: authHeaders(token) })
      ).json();
      expect(detail.stops[0].status).toBe("completed");
      // Responses carry a photo_ref; the queued photo arrived as the shrunk JPEG.
      const ref = detail.stops[0].evidence?.arrival?.photo_ref;
      expect(Number.isInteger(ref)).toBe(true);
      const photo = await request.get(`${API}/spj/${spj.spj_id}/evidence/${ref}`, {
        headers: authHeaders(token),
      });
      expect(photo.headers()["content-type"]).toBe("image/jpeg");
    }).toPass({ timeout: 30000 });
  } finally {
    await context.setOffline(false);
    await cancelSpj(request, token, spj.spj_id);
  }
});
