// Pure derivations over GET /api/readiness for the Morning readiness screen (lane S2).

// Pre-trip item key -> i18n key of its name.
export const PRETRIP_ITEM_KEYS = {
  rem: "s2_item_brakes",
  mesin: "s2_item_engine",
  ban: "s2_item_tyres",
  bbm: "s2_item_fuel",
  oli: "s2_item_oil",
  bak_compactor: "s2_item_compactor",
  lampu: "s2_item_lights",
};

// Blockers a driver can clear by answering a message (the "Remind drivers" set).
const REMINDABLE = ["pretrip_missing", "instruction_pending"];

export const isHard = (truck) => Boolean(truck.damage?.heavy) || truck.blockers.includes("duty_blocked");
export const isRemindable = (truck) => !truck.ready && truck.blockers.some((b) => REMINDABLE.includes(b));

// What blocks departure first: hard stops, then the most blockers, then the code.
export function sortTrucks(trucks) {
  return [...trucks].sort(
    (a, b) =>
      Number(isHard(b)) - Number(isHard(a)) ||
      b.blockers.length - a.blockers.length ||
      a.truck_code.localeCompare(b.truck_code),
  );
}

export function legendCounts(board) {
  const count = (test) => board.trucks.filter(test).length;
  return {
    ready: board.counts.ready,
    pretrip: count((t) => t.blockers.includes("pretrip_missing")),
    notRoadworthy: count((t) => t.damage?.heavy),
    dutyBlock: count((t) => t.blockers.includes("duty_blocked")),
    unread: count((t) => t.blockers.includes("instruction_pending")),
  };
}

// The one action a not-ready row offers: swap (a backup exists), override (duty), message, or details.
export function rowAction(truck, { canSwap, canMessage, canOverride, hasBackup }) {
  if (truck.ready) return "ready";
  if (canSwap && hasBackup && isHard(truck) && truck.blockers.includes("damage_open")) return "swap";
  if (canOverride && truck.blockers.includes("duty_blocked")) return "override";
  if (canMessage && isRemindable(truck)) return "message";
  return "details";
}

// Indonesian text for the WhatsApp alert body: the driver reads it, whatever language the console is in.
export function reminderText(truck) {
  const missing = truck.blockers.includes("pretrip_missing");
  const unread = truck.blockers.includes("instruction_pending");
  const issue = [missing && "pre-trip belum diisi", unread && "instruksi belum dikonfirmasi"]
    .filter(Boolean)
    .join(" dan ");
  return {
    issue: issue.charAt(0).toUpperCase() + issue.slice(1),
    recommendation: "Isi pre-trip dan konfirmasi instruksi di aplikasi Pythia sebelum berangkat",
  };
}

// One alert-group message for "Remind N drivers": a line per issue listing its trucks (stays
// well under the 2000-character summary limit), then the shared ask.
export function reminderSummary(trucks) {
  const byIssue = new Map();
  for (const truck of trucks) {
    const { issue } = reminderText(truck);
    byIssue.set(issue, [...(byIssue.get(issue) || []), truck.truck_code]);
  }
  const lines = [...byIssue].map(([issue, codes]) => `${issue}: ${codes.join(", ")}`);
  return ["Pengingat Pythia sebelum berangkat", ...lines, `${reminderText(trucks[0]).recommendation}.`].join(
    "\n",
  );
}

// The approved plan of the board's day that holds a truck, with that truck's stops and gate slot.
export function planFor(plans, date, truckCode) {
  for (const plan of plans) {
    if (plan.plan_date !== date) continue;
    const dispatch = (plan.dispatches || []).find((d) => d.truck_code === truckCode);
    if (dispatch) {
      return {
        planId: plan.plan_id,
        stops: dispatch.fields?.stops?.length ?? null,
        slotStart: dispatch.fields?.gate_slot?.start ?? null,
      };
    }
  }
  return null;
}
