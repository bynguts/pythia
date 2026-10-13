// Records product footage for the competition video (docs/competition/VIDEO_SCRIPT.md).
//
// Each shot is a separate 1920×1080 .webm in RECORD_DIR (default ./recordings),
// English UI, real basemap tiles. Start the backend (:8001, PYTHIA_AI_ENGINE=on)
// and `npm run build && npm run preview -- --port 5175` first, then:
//
//   node e2e/recording/record-demo.mjs            # every shot
//   node e2e/recording/record-demo.mjs S4 S7      # selected shots
//   HEADED=1 node e2e/recording/record-demo.mjs   # use the GPU (smoother 3D)
//
// The phone shots (S6 AR navigation, S7 on a real ARCore phone) must be filmed
// on a device; this script only captures the desktop/browser footage.
import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5175";
const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";
const OUT = resolve(process.env.RECORD_DIR || "recordings");
const SIZE = { width: 1920, height: 1080 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(role = "dispatcher") {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: role, password: `${role}-demo-pass` }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).token;
}

async function waitForTwin(page, timeout = 60000) {
  await page.waitForFunction(() => window.__pythiaTwin?.ready, null, { timeout });
}

async function waitForTourEnd(page) {
  await page.waitForFunction(() => window.__pythiaTwin?.tourActive, null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => !window.__pythiaTwin?.tourActive, null, { timeout: 60000 });
}

const SHOTS = {
  // S1/S3 backdrop: cinematic tour over Jakarta, presentation mode.
  S1: async (page) => {
    await page.goto(`${BASE}/?present=1`);
    await waitForTwin(page);
    await wait(3000);
    await page.evaluate(() => window.__pythiaTwin.startTour());
    await waitForTourEnd(page);
    await wait(2000);
  },
  // S4: scenario — 80 mm rain, then a 50,000-person concert, then scrub the week.
  S4: async (page) => {
    await page.goto(`${BASE}/?workspace=twin`);
    await waitForTwin(page);
    await wait(3000);
    await page.evaluate(() => window.__pythiaTwin.setRainfall(80));
    await wait(4000);
    await page.evaluate(() => window.__pythiaTwin.setEventPreset("50k"));
    await wait(4000);
    for (let day = 0; day < 7; day += 1) {
      await page.evaluate((d) => window.__pythiaTwin.setDay(d), day);
      await wait(1600);
    }
    await wait(1500);
  },
  // S5: fleet command — simulated jam triggers the A* reroute of T-047.
  S5: async (page, { token }) => {
    const headers = { Authorization: `Bearer ${token}` };
    await fetch(`${API}/fleet/astar-simulate-jam?active=false`, { method: "POST", headers });
    await page.goto(`${BASE}/`);
    await page.getByTestId("fleet-workspace").waitFor({ timeout: 60000 });
    await wait(5000);
    await page.getByTestId("deck-tools-toggle").click();
    await wait(2000);
    await fetch(`${API}/fleet/astar-simulate-jam?active=true`, { method: "POST", headers });
    await page.getByTestId("deck-tools-panel").locator(".traffic-status-badge")
      .filter({ hasText: /Jam|Macet|JAM/ }).waitFor({ timeout: 45000 });
    await wait(10000);
    await fetch(`${API}/fleet/astar-simulate-jam?active=false`, { method: "POST", headers });
  },
  // S7 (desktop stand-in): the XR tabletop twin in the orbit viewer.
  S7: async (page) => {
    await page.goto(`${BASE}/xr?city=jakarta&rainfall_mm=80&event_attendance=50000`);
    await page.waitForFunction(() => window.__pythiaXr?.ready, null, { timeout: 60000 });
    await wait(15000);
  },
  // S8: data provenance and model audit.
  S8: async (page) => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("workspace-navigation").getByRole("button", { name: /Data & ML Audit/ }).click();
    await page.getByTestId("audit-workspace").waitFor({ timeout: 30000 });
    await wait(4000);
    await page.mouse.wheel(0, 900);
    await wait(4000);
    await page.mouse.wheel(0, 900);
    await wait(4000);
  },
  // S9: SEA expansion — Ho Chi Minh City demo city in the twin.
  S9: async (page) => {
    await page.goto(`${BASE}/?present=1`);
    await waitForTwin(page);
    await page.evaluate(() => window.__pythiaTwin.setCity("hcmc"));
    await page.waitForFunction(() => window.__pythiaTwin?.ready && window.__pythiaTwin.city === "hcmc",
      null, { timeout: 60000 });
    await wait(3000);
    await page.evaluate(() => window.__pythiaTwin.startTour());
    await waitForTourEnd(page);
    await wait(1500);
  },
};

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
  const unknown = wanted.filter((id) => !SHOTS[id]);
  if (unknown.length) throw new Error(`unknown shot(s): ${unknown.join(", ")}`);
  await mkdir(OUT, { recursive: true });
  const token = await login();
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    // navigator.webdriver stays false so the app uses real tiles and motion,
    // exactly as a person sees it (the e2e suite relies on the opposite).
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    for (const id of wanted) {
      const context = await browser.newContext({
        viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: SIZE },
      });
      await context.addInitScript((value) => {
        localStorage.setItem("pythia_token", value);
        localStorage.setItem("pythia_auth", "true");
        localStorage.setItem("pythia_role", "dispatcher");
        localStorage.setItem("pythia_lang", "en");
      }, token);
      const page = await context.newPage();
      process.stdout.write(`recording ${id} … `);
      try {
        await SHOTS[id](page, { token });
      } finally {
        const video = page.video();
        await context.close();
        if (video) await rename(await video.path(), join(OUT, `${id}.webm`));
      }
      console.log(`saved ${join(OUT, `${id}.webm`)}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
