import { expect, request as apiRequest, test } from "@playwright/test";
import { apiLogin, authHeaders, createActiveSpj, cancelSpj, openDriver } from "./lib/driverSpj.js";

const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

// Behaviour: English mode is fully English and Indonesian mode fully Indonesian, on
// every console page, behind every tab, menu, drawer and disclosure a role can open,
// in the driver app, on the landing and the sign-in, and in Ana's answers. Text in an
// element marked with the other `lang` (a WhatsApp body sent to drivers) is a quote,
// not interface copy, and is skipped.

// Words that only occur in Indonesian copy.
const ID_MARKERS = `
  dan yang untuk dengan belum sudah tidak truk hari besok ini itu dari pada atau akan bisa perlu harus
  setiap menit detik dtk rencana laporan pengemudi sopir armada antrean gerbang tunggu setujui tolak
  kirim simpan batal memuat lihat semua siap selesai aktif catatan perjalanan ritasi cuaca hujan libur
  acara bulan terakhir terlambat segera masuk keluar berat bersih kotor tiket timbangan sampah
  diperbarui pengawas petugas kendaraan muatan baru minggu jadwal kosong rusak kecelakaan ditutup
  disetujui menunggu dikirim berhasil gagal sedang masih jika karena agar oleh tanpa sebelum sesudah
  setelah hingga sampai bukti foto lapor ringkasan rata perkiraan prakiraan kapasitas tersedia pukul
  tanggal nomor spj surat
`
  .trim()
  .split(/\s+/);
// Words that only occur in English copy.
const EN_MARKERS = `
  the and with for not yet trucks truck today tomorrow waiting loading driver drivers weather approve
  approved reject send sent save saved cancel ready done late settings sign pending draft view none
  from this that will can should must need needs been has have was were are is of to your you our by
  yes open close show hide more less back next previous update updated last week month days hours
  minutes report reports queue gate trip trips weight ticket error failed unknown available
  unavailable check review when what which where who how why there here only each every about
  after before until photo proof receipt breakdown accident road closed empty full
`
  .trim()
  .split(/\s+/);

// Proper nouns and shared technical names that are the same in both languages.
const KECAMATAN = `
  Cakung, Cempaka Putih, Cengkareng, Cilandak, Cilincing, Cipayung, Ciracas, Duren Sawit, Gambir,
  Grogol Petamburan, Jagakarsa, Jatinegara, Johar Baru, Kalideres, Kebayoran Baru, Kebayoran Lama,
  Kebon Jeruk, Kelapa Gading, Kemayoran, Kembangan, Kepulauan Seribu Selatan, Kepulauan Seribu Utara,
  Koja, Kramat Jati, Makasar, Mampang Prapatan, Matraman, Menteng, Pademangan, Palmerah, Pancoran,
  Pasar Minggu, Pasar Rebo, Penjaringan, Pesanggrahan, Pulo Gadung, Pulogadung, Sawah Besar, Senen,
  Setiabudi, Taman Sari, Tambora, Tanah Abang, Tanjung Priok, Tebet
`
  .trim()
  .split(/\s*,\s*/);
const PROPER_NOUNS = [
  ...KECAMATAN,
  "Dinas Lingkungan Hidup",
  "Bank Sampah",
  "Kepulauan Seribu",
  "Surat Perintah Jalan",
  "Rawa Bebek",
  "OpenStreetMap contributors",
  "Open-Meteo",
  "Open Data",
];
// Provenance labels stay as the data pipeline writes them (CLAUDE.md: data honesty).
const PROVENANCE = ["SIMULATED_DEMO_CITY", "SIMULATED", "MODEL OUTPUT", "ASSUMPTION"];

function markerPattern(words) {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])(${words.join("|")})(?![\\p{L}\\p{N}_-])`, "iu");
}
const PATTERN = { en: markerPattern(ID_MARKERS), id: markerPattern(EN_MARKERS) };

function strip(text) {
  let out = text;
  for (const noun of [...PROPER_NOUNS, ...PROVENANCE]) out = out.split(noun).join(" ");
  // Road names, plates, ids and e-mail/url-like tokens are data, not copy.
  return (
    out
      .replace(/\b(Jl|Jln)\.\s*[^,;·]+/g, " ")
      .replace(/\bhttps?:\/\/\S+/g, " ")
      .replace(/\S+@\S+/g, " ")
      // Records other specs type into the shared stack ("E2E Receipt") are test data.
      .replace(/\bE2E\b[\w -]*/g, " ")
      // Work order numbers (SPJ-000001, DLH-DKI/SPJ/27-10-2026/0001) are document ids.
      .replace(/\S*SPJ\/\S*/g, " ")
      .replace(/\b[\w-]+\.(app|id|com|org)\/\S*/g, " ")
  );
}

// Every visible text node plus aria-label / title / placeholder / alt of the document
// (portals included), skipping anything inside an element in the other language.
async function collect(page) {
  return page.evaluate(() => {
    const docLang = document.documentElement.lang;
    const out = new Set();
    const foreign = (el) => {
      const holder = el?.closest?.("[lang]");
      return holder && holder !== document.documentElement && holder.getAttribute("lang") !== docLang;
    };
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode;
      const el = node.parentElement;
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (text.length < 2 || !el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
      if (foreign(el)) continue;
      // translate="no" marks a document id (a work order number), not copy.
      if (el.closest("[translate=no]")) continue;
      out.add(text);
    }
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],img[alt]")) {
      if (foreign(el)) continue;
      for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
        const value = el.getAttribute(attr)?.replace(/\s+/g, " ").trim();
        if (value && value.length > 1) out.add(`@${attr}: ${value}`);
      }
    }
    return [...out];
  });
}

function hitsIn(lang, texts, where, sink) {
  for (const text of texts) {
    const match = strip(text).match(PATTERN[lang]);
    // Each string once, where it first showed up.
    if (match && !sink.has(text)) sink.set(text, `${where} :: [${match[1]}] ${text.slice(0, 200)}`);
  }
}

async function settle(page, ms = 700) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(ms);
}

// Open every tab, menu, popup and disclosure on the current screen, one at a time,
// collecting the text each reveals. Controls that would write (approve, send, …)
// are never clicked: only tabs, aria-expanded / aria-haspopup controls and summaries.
async function crawlControls(page, lang, where, sink, { limit = 40 } = {}) {
  const selector = [
    "[role=tab]:not([aria-selected=true]):not([disabled])",
    "[aria-expanded=false]:not([disabled])",
    "[aria-haspopup]:not([aria-haspopup=false]):not([aria-expanded=true]):not([disabled])",
    "details:not([open]) > summary",
  ].join(",");
  const url = page.url();
  const seen = new Set();
  for (let i = 0; i < limit; i++) {
    const handles = await page.locator(selector).all();
    let target = null;
    let key = "";
    for (const handle of handles) {
      if (!(await handle.isVisible().catch(() => false))) continue;
      const label = await handle
        .evaluate((el) => `${el.tagName}|${el.getAttribute("aria-label") || ""}|${el.textContent.trim()}`)
        .catch(() => "");
      if (!label || seen.has(label)) continue;
      target = handle;
      key = label;
      break;
    }
    if (!target) break;
    seen.add(key);
    await target.click({ timeout: 3000 }).catch(() => {});
    await settle(page, 900);
    hitsIn(lang, await collect(page), `${where} > ${key.split("|").slice(1).join(" ").slice(0, 60)}`, sink);
    if (page.url().split("#")[0] !== url.split("#")[0] && !page.url().includes("tab=")) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await settle(page, 1500);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 300);
    }
  }
}

async function signIn(page, role, lang, extra = {}) {
  await page.goto("/");
  const response = await page.request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  const principal = await response.json();
  await page.evaluate(
    ({ token, role, lang, extra }) => {
      localStorage.clear();
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    },
    { ...principal, lang, extra },
  );
}

function report(sink) {
  return [...sink.values()].sort().join("\n");
}

// Records written in one language that every page then shows: a driver's quick breakdown
// report and a pre-trip NO without a typed reason (the notes the API and the driver app
// write themselves). Resolved again after the run.
async function seedRecords() {
  const request = await apiRequest.newContext();
  const login = await request.post(`${API}/auth/login`, {
    data: { username: "dispatcher", password: "dispatcher-demo-pass" },
  });
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const reports = [
    {
      component: "mogok",
      note: "Truk mogok/rusak di jalan (laporan cepat sopir)",
      source: "driver_exception",
    },
    { component: "rem", note: "NO during pretrip: Brakes", source: "pretrip" },
  ];
  const ids = [];
  for (const [i, report] of reports.entries()) {
    const res = await request.post(`${API}/damage-reports`, {
      headers,
      data: { truck_code: `T-04${i}`, driver_name: "Pengemudi Sim 40", severity: "berat", ...report },
    });
    if (res.ok()) ids.push((await res.json()).report_id);
  }
  return async () => {
    for (const id of ids) await request.post(`${API}/damage-reports/${id}/resolve`, { headers });
    await request.dispose();
  };
}

const PAGES = ["operations", "readiness", "gate", "work-orders", "tomorrow", "fleet", "reports", "settings"];
const ROW_OPENERS = {
  "work-orders": ['[data-testid="wo-row"]'],
  fleet: ['[data-testid="truck-row"]'],
  tomorrow: ['[data-testid="tmr-district-row"]', '[data-testid="tmr-truck-row"]'],
  operations: ['[data-testid="action-row"]'],
};

for (const lang of ["en", "id"]) {
  test.describe(`${lang.toUpperCase()} mode is one language`, () => {
    test.describe.configure({ timeout: 240000 });
    let unseed = null;
    test.beforeAll(async () => {
      unseed = await seedRecords();
    });
    test.afterAll(async () => {
      await unseed?.();
    });

    test(`landing and sign-in (${lang})`, async ({ page }) => {
      const sink = new Map();
      await page.goto(`/?lang=${lang}`);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await settle(page, 2500);
      hitsIn(lang, await collect(page), "landing", sink);
      await crawlControls(page, lang, "landing", sink, { limit: 20 });
      await page.evaluate(() => localStorage.removeItem("pythia_auth"));
      await page.goto(`/app/operations?lang=${lang}`);
      await settle(page, 2000);
      hitsIn(lang, await collect(page), "sign-in", sink);
      expect(report(sink), "mixed-language strings").toBe("");
    });

    for (const role of ["dispatcher", "supervisor"]) {
      for (const name of PAGES) {
        test(`${role} /app/${name} (${lang})`, async ({ page }) => {
          const sink = new Map();
          await signIn(page, role, lang, role === "supervisor" ? { pythia_supervisor_mode: "1" } : {});
          await page.goto(`/app/${name}`, { waitUntil: "domcontentloaded" });
          await expect(page.locator("main h1").first()).toBeVisible({ timeout: 30000 });
          await settle(page, 5000);
          const where = `${role} ${name}`;
          hitsIn(lang, await collect(page), where, sink);
          await crawlControls(page, lang, where, sink);
          for (const opener of ROW_OPENERS[name] || []) {
            const row = page.locator(opener).first();
            if (!(await row.isVisible().catch(() => false))) continue;
            await row.click().catch(() => {});
            await settle(page, 1500);
            hitsIn(lang, await collect(page), `${where} > ${opener}`, sink);
            await crawlControls(page, lang, `${where} > ${opener}`, sink, { limit: 15 });
            await page.keyboard.press("Escape").catch(() => {});
          }
          expect(report(sink), "mixed-language strings").toBe("");
        });
      }
    }

    test(`Ask Ana drawer and answer (${lang})`, async ({ page }) => {
      const sink = new Map();
      await signIn(page, "dispatcher", lang);
      await page.goto("/app/operations?ana=1", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("ana-drawer")).toBeVisible({ timeout: 30000 });
      await settle(page, 1500);
      hitsIn(lang, await collect(page), "ana", sink);
      const prompts = page.getByTestId("assistant-prompt");
      const count = Math.min(await prompts.count(), 4);
      for (let i = 0; i < count; i++) {
        const before = await page.locator('[data-testid="assistant-message"][data-role="assistant"]').count();
        await prompts.nth(i).click();
        await expect(page.locator('[data-testid="assistant-message"][data-role="assistant"]')).toHaveCount(
          before + 1,
          { timeout: 60000 },
        );
        await settle(page, 500);
        hitsIn(lang, await collect(page), `ana answer ${i + 1}`, sink);
        if (
          !(await prompts
            .nth(i)
            .isVisible()
            .catch(() => false))
        )
          break;
      }
      expect(report(sink), "mixed-language strings").toBe("");
    });

    test(`driver app (${lang})`, async ({ page, request }) => {
      const truck = "T-046";
      const sink = new Map();
      const { token } = await apiLogin(request, "dispatcher");
      const driver = await apiLogin(request, "driver");
      const spj = await createActiveSpj(request, token, truck, [
        { name: "TPS Menteng", kecamatan: "Menteng", address: "Menteng", lat: -6.196, lng: 106.832 },
        { name: "TPS Gambir", kecamatan: "Gambir", address: "Gambir", lat: -6.176, lng: 106.822 },
      ]);
      try {
        await openDriver(page, request, { token: driver.token, truck, lang });
        await settle(page, 4000);
        for (const tab of ["instruksi", "rute", "lapor", "tpa"]) {
          await page.goto(`/driver?tab=${tab}`, { waitUntil: "domcontentloaded" });
          await settle(page, 3000);
          hitsIn(lang, await collect(page), `driver ${tab}`, sink);
          await crawlControls(page, lang, `driver ${tab}`, sink, { limit: 15 });
        }
      } finally {
        await cancelSpj(request, token, spj.spj_id);
        await request.get(`${API}/health`, { headers: authHeaders(token) }).catch(() => {});
      }
      expect(report(sink), "mixed-language strings").toBe("");
    });
  });
}
