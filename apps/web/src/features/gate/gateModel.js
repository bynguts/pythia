// Pure helpers for the TPA gate screen: the Jakarta clock, the board's slot arithmetic and the
// KPI rules. Everything reads GET /api/gate/slots (SIMULATED board), /safety/overview,
// /recap/daily and /tpa/queue-status; nothing here invents a number.

const JAKARTA = "Asia/Jakarta";
const clockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: JAKARTA,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: JAKARTA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const BOARD_WINDOW_MIN = 90;

// "HH:MM" of an ISO timestamp (or Date) on the Jakarta clock; null when it does not parse.
export function jakartaClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : clockFormat.format(date);
}

export function jakartaDay(date = new Date()) {
  return dayFormat.format(date);
}

export function addDays(isoDay, days) {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function minutesOfDay(clock) {
  const [h, m] = String(clock).split(":").map(Number);
  return h * 60 + m;
}

// Minutes since Jakarta midnight.
export function nowMinutes(date = new Date()) {
  return minutesOfDay(clockFormat.format(date));
}

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

// A slot is a peak when its arrivals plus the queue carried in exceed what the weighbridges
// clear in 15 minutes: the same test the board uses to decide a hold.
export function isPeakSlot(slot, capacity) {
  if (!Number.isFinite(capacity)) return false;
  const demand =
    (slot.background_load || 0) + (slot.planned_trucks || []).length + (slot.queue_carried_in || 0);
  return demand > capacity;
}

export function currentSlot(slots, minutes) {
  return slots.find((slot) => {
    const start = minutesOfDay(slot.start);
    return minutes >= start && minutes < start + 15;
  });
}

export function peakSlot(slots) {
  let best = null;
  for (const slot of slots) {
    if (num(slot.expected_wait_min) !== null && (!best || slot.expected_wait_min > best.expected_wait_min)) {
      best = slot;
    }
  }
  return best;
}

// Slots from now to now + 90 minutes (today), or the first 90 minutes of the board (any other day).
export function boardWindow(slots, minutes) {
  if (minutes == null) return slots.slice(0, BOARD_WINDOW_MIN / 15 + 1);
  return slots.filter((slot) => {
    const start = minutesOfDay(slot.start);
    return start + 15 > minutes && start <= minutes + BOARD_WINDOW_MIN;
  });
}

// The slice of the day the chart draws: the board's own slots.
export function plannedTotal(slots) {
  return slots.reduce((sum, slot) => sum + (slot.planned_trucks || []).length, 0);
}

// Safety-overview trucks that reached the gate, newest arrival first (latest visit per truck).
export function latestArrivals(trucks, limit = 6) {
  return (trucks || [])
    .filter((truck) => truck.gate_arrived_at && jakartaClock(truck.gate_arrived_at))
    .sort((a, b) => new Date(b.gate_arrived_at) - new Date(a.gate_arrived_at))
    .slice(0, limit);
}

export function longestWait(trucks) {
  let best = null;
  for (const truck of trucks || []) {
    const wait = num(truck.gate_wait_minutes);
    if (wait !== null && (!best || wait > best.gate_wait_minutes)) best = truck;
  }
  return best;
}

// "T-031 and T-044" / "T-031, T-044 and T-100" in the UI language.
export function listTrucks(codes, locale) {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(codes);
  } catch {
    return codes.join(", ");
  }
}

// A closure the dispatcher recorded as a field fact (effect gate_lane_closed).
export function laneClosure(facts) {
  const fact = (facts || []).find((item) => item.effect?.kind === "gate_lane_closed");
  return fact ? { from: fact.effect.from, to: fact.effect.to } : null;
}
