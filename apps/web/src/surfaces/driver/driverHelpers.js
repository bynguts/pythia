// Pure helpers for the driver PWA (no React, no network): node-checkable.

// Audit gap 5: in-cab navigation hands off to Google Maps. A coordinate is
// used when known; an unverified facility falls back to a name search, so
// the link never pretends to a coordinate the registry does not have.
export function mapsDirectionsUrl(target) {
  const lat = Number(target?.lat);
  const lng = Number(target?.lng);
  const hasCoord =
    target?.lat !== null &&
    target?.lat !== undefined &&
    target?.lng !== null &&
    target?.lng !== undefined &&
    Number.isFinite(lat) &&
    Number.isFinite(lng);
  const destination = hasCoord ? `${lat},${lng}` : String(target?.name || "").trim();
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination).replace(/%2C/g, ",")}&travelmode=driving`;
}

// Audit gap 9: a stop the outbox will complete counts as done locally, so the
// next stop unlocks while the phone is offline. `queuedKeys` holds
// "<spj_id>:<index>" (DriverOutbox.queuedStopKeys).
export function withQueuedStops(spj, queuedKeys) {
  if (!spj || !Array.isArray(spj.stops)) return spj;
  let changed = false;
  const stops = spj.stops.map((stop, index) => {
    if (stop.status !== "completed" && queuedKeys.has(`${spj.spj_id}:${index}`)) {
      changed = true;
      return { ...stop, status: "completed", queued: true };
    }
    return stop;
  });
  return changed ? { ...spj, stops } : spj;
}

export function pretripQueuedFor(items, truckCode) {
  return items.some((item) => item.path === "/pretrip" && item.data?.truck_code === truckCode);
}

// Confirmations waiting in the outbox hide their instruction locally.
export function queuedDispatchIds(items) {
  const ids = new Set();
  for (const item of items) {
    const match = /^\/dispatch\/([^/]+)\/confirm$/.exec(item.path || "");
    if (match) ids.add(decodeURIComponent(match[1]));
  }
  return ids;
}

export function pendingInstructions(list, hiddenIds = new Set()) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (d) =>
        d &&
        typeof d.id === "string" &&
        d.field_status === "PENDING" &&
        typeof d.instruction === "string" &&
        d.instruction.trim() &&
        !hiddenIds.has(d.id),
    )
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// The safety contract (GET /api/safety/driver/{truck}); thresholds come from
// the payload, never from constants here.
export function safetyNotices(safety) {
  if (!safety || typeof safety !== "object") return [];
  const notices = [];
  const hours = (minutes, fallback) => {
    const n = Number(minutes);
    return Number.isFinite(n) && n > 0 ? Math.round((n / 60) * 10) / 10 : fallback;
  };
  if (safety.duty_state === "blocked") {
    notices.push({
      kind: "blocked",
      hours: hours(safety.block_at_minutes, 12),
      override: safety.override || null,
    });
  } else if (safety.duty_state === "warn") {
    notices.push({ kind: "warn", hours: hours(safety.warn_at_minutes, 10) });
  }
  if (safety.gate_state === "alert") {
    notices.push({ kind: "gate", hours: hours(safety.gate_alert_at_minutes, 3) });
  }
  return notices;
}

// New SPJ work is held at the duty cap unless a supervisor override exists.
export function safetyBlocksNewWork(safety) {
  return Boolean(safety && safety.duty_state === "blocked" && !safety.override);
}

// R1: AR is opt-in and offered only where it can run: a secure context with a
// camera API, and not on a phone reporting 2 GB of memory or less.
export function arCapable(env) {
  if (!env) return false;
  if (env.isSecureContext === false) return false;
  if (typeof env.mediaDevices?.getUserMedia !== "function") return false;
  const memory = Number(env.deviceMemory);
  if (Number.isFinite(memory) && memory > 0 && memory <= 2) return false;
  return true;
}

// GET /api/driver/session: a personal driver account carries its truck, so
// the app skips the truck picker; a shared demo login has none and picks.
export function boundDriverOf(session) {
  const truck = typeof session?.truck_code === "string" ? session.truck_code.trim() : "";
  if (!truck) return null;
  return { truck_code: truck, driver_name: session.display_name || session.username || truck, bound: true };
}

// The SPJ poll asks for this truck only; `limit` keeps the newest N.
export function spjListPath(status, truckCode, limit) {
  const params = new URLSearchParams({ status, truck_code: truckCode });
  if (limit) params.set("limit", String(limit));
  return `/spj?${params}`;
}

// Weighbridge ticket weights for the receipt, both optional. The tare goes
// only with a gross weight above it (the server needs both to compute net,
// and rejects a tare alone); a tare typed without a gross weight is left out.
// Returns { ok, weights } or { ok: false, error: "gross" | "tare" }.
export function receiptWeights(grossText, tareText) {
  const read = (text) => {
    const s = String(text ?? "").trim();
    return s ? Number(s) : null;
  };
  const gross = read(grossText);
  const tare = read(tareText);
  if (gross === null) return { ok: true, weights: {} };
  if (!Number.isFinite(gross) || gross <= 0) return { ok: false, error: "gross" };
  if (tare === null) return { ok: true, weights: { total_weight_kg: gross, weight_source: "manual" } };
  if (!Number.isFinite(tare) || tare <= 0 || tare >= gross) return { ok: false, error: "tare" };
  return { ok: true, weights: { total_weight_kg: gross, tare_weight_kg: tare, weight_source: "manual" } };
}

// The recorded receipt's weights, one row per key the server labels in
// `weight_labels`. A weight the server did not record stays null: the net is
// never computed here.
export function receiptWeightRows(receipt) {
  const labels = receipt?.weight_labels;
  if (!labels || typeof labels !== "object") return [];
  return ["gross_weight_kg", "tare_weight_kg", "net_weight_kg"]
    .filter((key) => key in labels)
    .map((key) => {
      const raw = key === "gross_weight_kg" ? (receipt[key] ?? receipt.total_weight_kg) : receipt[key];
      const kg = raw === null || raw === undefined ? null : Number(raw);
      return { key, kg: Number.isFinite(kg) ? kg : null };
    });
}

// The gate slot a plan instruction carries only as text (a dispatch without
// structured fields): "Berangkat 05:30 · Slot gerbang <facility> 10:00–10:15".
// Returns { facility, start, end, depart_at } or null.
export function instructionSlotFromText(text) {
  const s = String(text || "");
  const slot = /Slot gerbang (.+?) (\d{1,2}:\d{2})[–-](\d{1,2}:\d{2})/.exec(s);
  const depart = /Berangkat (\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}|\d{1,2}:\d{2})/.exec(s);
  if (!slot && !depart) return null;
  return {
    facility: slot ? slot[1] : null,
    start: slot ? slot[2] : null,
    end: slot ? slot[3] : null,
    depart_at: depart ? depart[1] : null,
  };
}

// The "Depart HH:MM" headline of a gate slot. `depart_at` is "HH:MM", or
// "YYYY-MM-DD HH:MM" when the departure falls on another day than the slot.
export function departHeadline(slot) {
  const raw = typeof slot?.depart_at === "string" ? slot.depart_at.trim() : "";
  const match = /^(?:(\d{4}-\d{2}-\d{2}) )?(\d{1,2}:\d{2})$/.exec(raw);
  if (!match) return null;
  return { time: match[2], date: match[1] || null };
}

// Today's pre-trip record ({ items, created_at }) for the done banner: the time,
// how many minor NO items went to dispatch, and whether a serious one did.
export function pretripSummary(record, seriousKeys) {
  const items = record && typeof record.items === "object" && record.items ? record.items : {};
  const failed = Object.keys(items).filter((key) => items[key] === false);
  const serious = failed.some((key) => seriousKeys.has(key));
  return {
    time: clockTime(record?.created_at),
    minor: failed.filter((key) => !seriousKeys.has(key)).length,
    serious,
  };
}

// "14:05" (HH:MM, 24 h) in the phone's local time; id-ID would print "14.05".
export function clockTime(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
