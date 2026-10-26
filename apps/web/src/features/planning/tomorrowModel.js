// Pure helpers for the Tomorrow page (wave 13): plan grouping, the pre-submit checks and
// time formatting. Every number comes from the API payloads; nothing here invents one.

const JAKARTA = "Asia/Jakarta";

// "2026-10-27" → "Tue 27 Oct" in the UI language.
export function dayLabel(iso, locale) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${part("weekday")} ${part("day")} ${part("month")}`.replace(/\./g, "").trim();
}

// An ISO instant (UTC) → "15:52" on the Jakarta clock.
export function wibTime(iso) {
  if (!iso) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: JAKARTA,
  }).format(date);
}

export function tomorrowIso(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: JAKARTA }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// The plan day for a `?date=` value: tomorrow unless it names a later day of the forecast
// week (tomorrow + 0..5).
export function planDateFor(requested, now = new Date()) {
  const tomorrow = tomorrowIso(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(requested || ""))) return tomorrow;
  const days = (Date.parse(`${requested}T00:00:00Z`) - Date.parse(`${tomorrow}T00:00:00Z`)) / 864e5;
  return days >= 0 && days <= 5 ? requested : tomorrow;
}

export function prettyArea(area) {
  return String(area || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The plan's district labels by slug, from its dispatch stops (the API's own labels).
export function areaLabels(plan) {
  const labels = {};
  for (const dispatch of plan?.dispatches || []) {
    for (const stop of dispatch.fields?.stops || []) labels[stop.area] = stop.kecamatan;
  }
  return labels;
}

// One row per truck: its districts, trips, the modelled gate slot of its first arrival
// (one slot per truck dispatch, not per trip), total load and the model's reason.
export function truckRows(plan) {
  const labels = areaLabels(plan);
  const slots = {};
  for (const dispatch of plan?.dispatches || []) {
    slots[dispatch.truck_code] = dispatch.fields?.gate_slot || null;
  }
  const byTruck = new Map();
  for (const a of plan?.assignments || []) {
    const row = byTruck.get(a.truck_code) || {
      truck: a.truck_code,
      areas: [],
      trips: 0,
      tons: 0,
      capacity: 0,
      demand: null,
    };
    if (!row.areas.includes(a.area)) row.areas.push(a.area);
    row.trips += 1;
    row.tons += Number(a.assigned_tons) || 0;
    row.capacity += Number(a.evidence?.capacity_tons) || 0;
    if (row.demand == null && a.evidence?.area_demand_tons != null) {
      row.demand = { area: a.area, tons: Number(a.evidence.area_demand_tons) };
    }
    byTruck.set(a.truck_code, row);
  }
  return [...byTruck.values()].map((row) => ({
    ...row,
    tons: Math.round(row.tons * 10) / 10,
    districts: row.areas.map((area) => labels[area] || prettyArea(area)),
    slot: slots[row.truck] || null,
    over: row.capacity > 0 && row.tons > row.capacity + 1e-6,
    demandLabel: row.demand ? labels[row.demand.area] || prettyArea(row.demand.area) : null,
  }));
}

// One row per district: trucks, trips, assigned tonnes and the forecast it serves.
export function districtRows(plan) {
  const labels = areaLabels(plan);
  const byArea = new Map();
  for (const a of plan?.assignments || []) {
    const row = byArea.get(a.area) || { area: a.area, trucks: [], trips: 0, tons: 0, demand: null };
    if (!row.trucks.includes(a.truck_code)) row.trucks.push(a.truck_code);
    row.trips += 1;
    row.tons += Number(a.assigned_tons) || 0;
    if (a.evidence?.area_demand_tons != null) row.demand = Number(a.evidence.area_demand_tons);
    byArea.set(a.area, row);
  }
  return [...byArea.values()]
    .map((row) => ({
      ...row,
      tons: Math.round(row.tons * 10) / 10,
      label: labels[row.area] || prettyArea(row.area),
    }))
    .sort((a, b) => b.tons - a.tons);
}

// The plan's trucks grouped by their modelled gate slot, with the expected wait (model):
// the slot board's once the plan is approved (the board sees every approved plan), else
// the plan's own slot model. `noWait` says why a row has none: "facility" (no weighbridge
// model, e.g. RDF) or "older" (a plan built before slot waits were modelled).
export function gateRows(plan, board) {
  const waits = {};
  if (plan?.status === "approved") {
    for (const slot of board?.slots || []) waits[`${slot.date} ${slot.start}`] = slot.expected_wait_min;
  }
  const bySlot = new Map();
  for (const dispatch of plan?.dispatches || []) {
    const slot = dispatch.fields?.gate_slot;
    if (!slot?.start) continue;
    const row = bySlot.get(slot.start) || {
      start: slot.start,
      end: slot.end,
      trucks: [],
      over: false,
      wait: null,
      noWait: "facility",
    };
    row.trucks.push(dispatch.truck_code);
    if (slot.capacity_model?.over_capacity) row.over = true;
    if (row.wait == null && slot.capacity_model) {
      row.wait = waits[`${slot.date} ${slot.start}`] ?? slot.capacity_model.expected_wait_min ?? null;
      row.noWait = row.wait == null ? "older" : null;
    }
    bySlot.set(slot.start, row);
  }
  return [...bySlot.values()].sort((a, b) => a.start.localeCompare(b.start));
}

// "Check before you submit": over-capacity trucks, districts the plan leaves short (from
// the solver's quota usage) and the gate slots the model sees saturated, merged into
// ranges. Only what the payloads say; a long shortage list is summed into one chip.
export function planFlags(plan, rows, { maxShort = 1 } = {}) {
  const flags = [];
  for (const row of rows) {
    if (row.over) flags.push({ kind: "over", tone: "warn", code: row.truck, tons: row.tons });
  }
  const short = (plan?.quota_usage || [])
    .filter((q) => Number(q.unassigned_tons) > 0)
    .sort((a, b) => b.unassigned_tons - a.unassigned_tons);
  for (const q of short.slice(0, maxShort)) {
    const trips = q.rit_needed != null && q.rit_used != null ? Math.max(0, q.rit_needed - q.rit_used) : null;
    flags.push({
      kind: "short",
      tone: "warn",
      area: q.label || prettyArea(q.area),
      trips,
      tons: Number(q.unassigned_tons),
    });
  }
  const rest = short.slice(maxShort);
  if (rest.length) {
    flags.push({
      kind: "short_more",
      tone: "warn",
      count: rest.length,
      tons: rest.reduce((total, q) => total + Number(q.unassigned_tons), 0),
    });
  }
  if (!short.length && plan?.unassigned_tons > 0) {
    flags.push({ kind: "unassigned", tone: "warn", tons: plan.unassigned_tons });
  }
  const saturated = new Map();
  for (const dispatch of plan?.dispatches || []) {
    const slot = dispatch.fields?.gate_slot;
    if (slot?.start && (slot.capacity_model?.saturated || slot.capacity_model?.over_capacity)) {
      saturated.set(slot.start, slot.end);
    }
  }
  const ranges = [];
  for (const start of [...saturated.keys()].sort()) {
    const last = ranges.at(-1);
    if (last && last.to === start) last.to = saturated.get(start);
    else ranges.push({ from: start, to: saturated.get(start) });
  }
  for (const range of ranges) flags.push({ kind: "gate", tone: "neutral", ...range });
  return flags;
}

// The plan's own gate window: first slot start to last slot end of its dispatches.
export function planGateWindow(plan) {
  const slots = (plan?.dispatches || []).map((d) => d.fields?.gate_slot).filter((s) => s?.start);
  if (!slots.length) return null;
  const starts = slots.map((s) => s.start).sort();
  const ends = slots.map((s) => s.end).sort();
  return { from: starts[0], to: ends.at(-1) };
}

// "assumption: 4 weighbridge lanes x 30 trucks/h …" → 4 (lanes only when the basis says so).
export function lanesFromBasis(basis) {
  const match = String(basis || "").match(/(\d+)\s+weighbridge lanes/i);
  return match ? Number(match[1]) : null;
}

// The fleet trucks a field fact keeps out of the plan (as the plan recorded them).
export function heldTrucks(plan) {
  return (plan?.scenario?.auto_inputs?.field_facts_applied || []).map((f) => f.truck_code);
}

// Truck codes mentioned in a fact's text that exist in the fleet: "T-112 stays in the workshop".
export function mentionedTruck(text, fleetCodes) {
  const match = String(text || "")
    .toUpperCase()
    .match(/\bT-?\d{2,4}\b/);
  if (!match) return null;
  const code = match[0].includes("-") ? match[0] : `T-${match[0].slice(1)}`;
  return fleetCodes.includes(code) ? code : null;
}
