// #89: SPJ cleanup helpers with an independent, bounded APIRequestContext.
// A slow or hanging scenario burns the test timeout; when `finally` runs
// Playwright has already torn the page (and its shared request context)
// down — the leftover active/draft SPJ then poisons the next run. Cleanup
// gets its own 10s-bounded context, created lazily and closed by the specs
// in test.afterAll.
import { expect, request } from "@playwright/test";

const API = "http://127.0.0.1:8001/api";

export const CLEANUP_TIMEOUT_MS = 10000;
let cleanupContext;

export async function cleanupContextGet() {
  if (!cleanupContext) {
    cleanupContext = await request.newContext({ timeout: CLEANUP_TIMEOUT_MS });
  }
  return cleanupContext;
}

export async function disposeCleanupContext() {
  if (cleanupContext) await cleanupContext.dispose();
  cleanupContext = undefined;
}

export async function cancelSpjIndependently(token, spjId) {
  const ctx = await cleanupContextGet();
  const detail = await ctx.get(`${API}/spj/${spjId}`);
  if (!detail.ok()) return `detail ${detail.status()}`;
  const state = (await detail.json()).status;
  if (!["draft", "aktif"].includes(state)) return `already ${state}`;
  const cancel = await ctx.post(`${API}/spj/${spjId}/cancel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return cancel.ok() ? "cancelled" : `cancel ${cancel.status()}`;
}

export async function assertNoLeftoverActiveSpj(token, truck = "T-210") {
  const ctx = await cleanupContextGet();
  const list = await ctx.get(`${API}/spj`);
  expect(list.ok()).toBeTruthy();
  const { spj = [] } = await list.json();
  const leftovers = spj.filter((s) => s.truck_code === truck && ["draft", "aktif"].includes(s.status));
  expect(leftovers, `leftover SPJ for ${truck}: ${JSON.stringify(leftovers)}`).toEqual([]);
  return leftovers;
}
