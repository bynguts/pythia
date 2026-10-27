// Shared steps for the Tomorrow specs (/app/tomorrow): sign in with a language and
// supervisor mode, pick a plan day of the forecast week that no approved plan holds, and
// build (and submit) the plan from the page.
import { expect } from "@playwright/test";

export const API = process.env.PLAYWRIGHT_API_BASE_URL || "http://127.0.0.1:8001/api";

async function login(request, role) {
  const response = await request.post(`${API}/auth/login`, {
    data: { username: role, password: `${role}-demo-pass` },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

export async function signIn(page, { role = "dispatcher", lang = "en", supervisor = false, path } = {}) {
  await page.goto("/");
  const principal = await login(page.request, role);
  await page.evaluate(
    ({ token, role, lang, supervisor }) => {
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_lang", lang);
      localStorage.setItem("pythia_token", token);
      localStorage.setItem("pythia_role", role);
      localStorage.setItem("pythia_supervisor_mode", supervisor ? "1" : "0");
    },
    { ...principal, lang, supervisor },
  );
  if (path) await page.goto(path, { waitUntil: "domcontentloaded" });
  return principal.token;
}

// Tomorrow (Jakarta) + offset days, as YYYY-MM-DD.
export function planDay(offset = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1 + offset)).toISOString().slice(0, 10);
}

// The first of `offsets` whose day holds no approved plan; live plans left on it by an
// earlier run are withdrawn, so the page opens on "No plan … yet".
export async function freeDay(request, offsets) {
  const { token } = await login(request, "dispatcher");
  const headers = { Authorization: `Bearer ${token}` };
  const plans = await (await request.get(`${API}/operations/plans?limit=100`, { headers })).json();
  const day = offsets
    .map(planDay)
    .find((date) => !plans.some((p) => p.plan_date === date && p.status === "approved"));
  expect(day, "every candidate day already holds an approved plan").toBeTruthy();
  for (const plan of plans) {
    if (plan.plan_date === day && ["draft", "proposed", "returned"].includes(plan.status)) {
      await request.post(`${API}/operations/plans/${plan.plan_id}/withdraw`, { headers });
    }
  }
  return day;
}

// Build from the page; a draft is then submitted. A server without drafts proposes on build.
export async function buildAndSubmit(page, day) {
  const built = page.waitForResponse(
    (res) => res.url().includes("/operations/plan?") && res.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByTestId("tmr-build").click();
  let plan = await (await built).json();
  expect(plan.plan_date).toBe(day);
  if (plan.status === "draft") {
    const submitted = page.waitForResponse((res) => res.url().includes(`/plans/${plan.plan_id}/submit`));
    await page.getByTestId("tmr-submit").click();
    plan = await (await submitted).json();
  }
  expect(plan.status).toBe("proposed");
  return plan;
}
