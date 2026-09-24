// DriverOutbox: durable offline submission queue for the Driver PWA (#45).
//
// Every driver mutation (pre-trip inspection, damage report, stop completion,
// receipt) that fails to reach the backend is queued in localStorage with a
// stable operation ID and replayed when connectivity returns. Replays are
// idempotent: the server treats a repeated stop completion as a no-op, a
// repeated pre-trip as the same daily record, and receipts carry
// operation_id-based dedup — so flushing twice can never double-record.
const KEY = "jwis_driver_outbox";

// Endpoints whose 409 means "already recorded" — a replay that lands here is
// a SUCCESS for the queue (the server state already matches the intent):
// pre-trip is a daily record, stop completion is idempotent, and a receipt
// replay with the same operation_id conflicts with itself on record.
const CONFLICT_MEANS_DONE = [
  "/pretrip",
  "/stops/",
  "/receipt",
];

export function readDriverOutbox() {
  try {
    const raw = localStorage.getItem(KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function writeDriverOutbox(items) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Queue one durable mutation. `path` is the API path (e.g. "/spj/<id>/stops/0/complete"),
// `data` the JSON body, `label` a short human identifier used by the UI badge.
// Re-enqueueing the same (path, data) pair replaces the pending entry instead
// of duplicating it (stable identity: the operation the driver intends).
export function enqueueDriverOperation({ path, data, label }) {
  const items = readDriverOutbox();
  const fingerprint = JSON.stringify({ path, data });
  const existing = items.findIndex((item) => item.fingerprint === fingerprint);
  const entry = {
    op_id: existing >= 0 ? items[existing].op_id : newOperationId(),
    path,
    data,
    label: label || path,
    fingerprint,
    queued_at: existing >= 0 ? items[existing].queued_at : new Date().toISOString(),
    attempts: existing >= 0 ? items[existing].attempts : 0,
  };
  if (existing >= 0) items[existing] = entry;
  else items.push(entry);
  writeDriverOutbox(items);
  return items.length;
}

// #45: single-flight — concurrent flush attempts would replay the same
// entry against each other and resurrect drained queues (a 409 loop).
let flushInFlight = false;

export async function flushDriverOutbox(apiUrl) {
  if (flushInFlight) return { flushed: 0, remaining: readDriverOutbox().length, errors: [] };
  flushInFlight = true;
  try {
    return await doFlushDriverOutbox(apiUrl);
  } finally {
    flushInFlight = false;
  }
}

async function doFlushDriverOutbox(apiUrl) {
  const items = readDriverOutbox();
  if (items.length === 0) return { flushed: 0, remaining: 0, errors: [] };
  const token = localStorage.getItem("jwis_token");
  const remaining = [];
  let flushed = 0;
  const errors = [];
  for (const item of items) {
    try {
      const res = await fetch(`${apiUrl}${item.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operation-Id": item.op_id,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(item.data),
      });
      // 2xx = recorded. A 409 on these endpoints means the server state
      // already matches the queued intent (e.g. pre-trip already saved
      // today, stop already completed) — the operation is done.
      const done = res.ok || (res.status === 409 && CONFLICT_MEANS_DONE.some((p) => item.path.includes(p)));
      if (done) {
        flushed += 1;
      } else {
        item.attempts += 1;
        errors.push({ op_id: item.op_id, label: item.label, status: res.status });
        remaining.push(item);
      }
    } catch {
      // Network still down: keep the record durable and retry later.
      item.attempts += 1;
      remaining.push(item);
    }
  }
  writeDriverOutbox(remaining);
  return { flushed, remaining: remaining.length, errors };
}
