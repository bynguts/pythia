// OfflineOutbox: queues field confirmations in localStorage when offline and
// replays them when connectivity returns. Keeps the field workflow auditable
// even without a live connection (Task 7 offline requirement).
import { apiFetch } from "../../shared/api/client.js";

const KEY = "pythia_field_outbox";

export function readOutbox() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function writeOutbox(items) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

// 8–80 chars, matching the backend's DispatchConfirmRequest.operation_id.
function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `field-${crypto.randomUUID()}`;
  return `field-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function enqueue(entry) {
  const items = readOutbox();
  // #44: queue identity is (dispatchId, status) — the dispatch and the
  // intended terminal state. Repeated taps of the same choice collapse into
  // one pending operation (keeping the earliest queued_at so ordering across
  // distinct operations is stable); a different status on the same dispatch
  // is a distinct operation and is appended.
  const existing = items.findIndex(
    (item) => item.dispatchId === entry.dispatchId && item.status === entry.status,
  );
  // The operation id is fixed when the operation is first queued, so every
  // flush retry is recognised by the server as the same confirmation.
  if (existing >= 0) {
    const kept = items[existing];
    items[existing] = {
      ...kept,
      ...entry,
      queued_at: kept.queued_at,
      operation_id: kept.operation_id || newOperationId(),
    };
  } else {
    items.push({ ...entry, queued_at: new Date().toISOString(), operation_id: newOperationId() });
  }
  writeOutbox(items);
  return items.length;
}

export async function flushOutbox() {
  const items = readOutbox();
  if (items.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [];
  let flushed = 0;
  for (const item of items) {
    try {
      const res = await apiFetch(`/dispatch/${item.dispatchId}/confirm`, {
        method: "POST",
        // Entries queued before operation ids existed replay without one.
        body: { status: item.status, note: item.note, operation_id: item.operation_id },
      });
      if (!res.ok) throw new Error("send failed");
      flushed += 1;
    } catch {
      remaining.push(item);
    }
  }
  writeOutbox(remaining);
  return { flushed, remaining: remaining.length };
}
