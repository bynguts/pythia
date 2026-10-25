// Pre-heats every backend cache (command-center, kecamatan predictions, TPA,
// map-truth) so the suite's t=0 fetch storm hits warm caches instead of
// serialized rebuilds behind the command-center lock — rebuilds stall poll
// requests past the fetch-settle window and reset keep-alive connections.
import { request } from "@playwright/test";

// Specs take PLAYWRIGHT_API_BASE_URL with the /api suffix; accept either form.
const API = (process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001").replace(/\/api\/?$/, "");

export default async function globalSetup() {
  // Signed in, so the gated SPJ list warms up too; without a token everything
  // public still pre-heats.
  let headers = {};
  try {
    const login = await request.newContext();
    const res = await login.post(`${API}/api/auth/login`, {
      data: { username: "dispatcher", password: "dispatcher-demo-pass" },
      timeout: 45000,
    });
    if (res.ok()) headers = { Authorization: `Bearer ${(await res.json()).token}` };
    await login.dispose();
  } catch (error) {
    console.warn(`[global-setup] login failed: ${error.message}`);
  }
  const ctx = await request.newContext({ extraHTTPHeaders: headers });
  const endpoints = [
    "/api/command-center",
    "/api/predictions/kecamatan?rainfall_mm=42&event_attendance=85000&is_weekend=true",
    "/api/predictions/kecamatan?rainfall_mm=0&event_attendance=0&is_weekend=false&horizon_days=7",
    "/api/facilities/gap-analysis?rainfall_mm=42&event_attendance=85000",
    "/api/tpa/queue-status",
    "/api/fleet/map-truth",
    "/api/routes/osrm",
    "/api/ai/tpa-queue-live",
    "/api/ai/events",
    "/api/spj",
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await ctx.get(`${API}${endpoint}`, { timeout: 45000 });
      if (res.status() >= 400) {
        throw new Error(`pre-heat ${endpoint} returned ${res.status()}`);
      }
    } catch (error) {
      console.warn(`[global-setup] pre-heat failed for ${endpoint}: ${error.message}`);
    }
  }
  await ctx.dispose();
}
