// OfflineOutbox: queues field confirmations in localStorage when offline and
// replays them when connectivity returns. Keeps the field workflow auditable
// even without a live connection (Task 7 offline requirement).
const KEY = "jwis_field_outbox";

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
  if (existing >= 0) {
    items[existing] = { ...items[existing], ...entry, queued_at: items[existing].queued_at };
  } else {
    items.push({ ...entry, queued_at: new Date().toISOString() });
  }
  writeOutbox(items);
  return items.length;
}

export async function flushOutbox(apiUrl) {
  const items = readOutbox();
  if (items.length === 0) return { flushed: 0, remaining: 0 };
  const remaining = [];
  let flushed = 0;
  const token = localStorage.getItem("jwis_token");
  for (const item of items) {
    try {
      const res = await fetch(`${apiUrl}/dispatch/${item.dispatchId}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ status: item.status, note: item.note }),
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
