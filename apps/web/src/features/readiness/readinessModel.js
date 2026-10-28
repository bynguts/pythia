// Pure derivations over GET /api/readiness for the Morning readiness screen.
import { fromCatalog } from "../../shared/i18n/index.jsx";

// Pre-trip item key -> i18n key of its name.
export const PRETRIP_ITEM_KEYS = {
  rem: "s2_item_brakes",
  mesin: "s2_item_engine",
  ban: "s2_item_tyres",
  bbm: "s2_item_fuel",
  oli: "s2_item_oil",
  bak_compactor: "s2_item_compactor",
  lampu: "s2_item_lights",
  // A problem the driver typed under "anything else" in the pre-trip check.
  lainnya: "s2_item_other",
  // Components a driver's quick breakdown / accident report files (api routers/driver.py).
  mogok: "lx_item_breakdown",
  kecelakaan: "lx_item_accident",
};

// A damage component code ("rem", "mogok") in the UI language; free text stays as typed.
export function componentLabel(code, t) {
  const key = PRETRIP_ITEM_KEYS[code];
  return key ? t(key) : code;
}

// The code of a component picked or typed by its name in either language ("Brakes" -> "rem").
export function componentCode(text) {
  const known = fromCatalog(text, Object.values(PRETRIP_ITEM_KEYS));
  return known ? Object.keys(PRETRIP_ITEM_KEYS).find((code) => PRETRIP_ITEM_KEYS[code] === known.key) : text;
}

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

// The WhatsApp alert body, through `wt` (a translator in the WhatsApp message language):
// one language per message, whatever language the console is in.
export function reminderText(truck, wt) {
  const missing = truck.blockers.includes("pretrip_missing");
  const unread = truck.blockers.includes("instruction_pending");
  const issue = [missing && wt("lx_wa_remind_pretrip"), unread && wt("lx_wa_remind_instruction")]
    .filter(Boolean)
    .join(wt("lx_wa_remind_and"));
  return {
    issue: issue.charAt(0).toUpperCase() + issue.slice(1),
    recommendation: wt("lx_wa_remind_reco"),
  };
}

// One alert-group message for "Remind N drivers": a line per issue listing its trucks (stays
// well under the 2000-character summary limit), then the shared ask.
export function reminderSummary(trucks, wt) {
  const byIssue = new Map();
  for (const truck of trucks) {
    const { issue } = reminderText(truck, wt);
    byIssue.set(issue, [...(byIssue.get(issue) || []), truck.truck_code]);
  }
  const lines = [...byIssue].map(([issue, codes]) => `${issue}: ${codes.join(", ")}`);
  return [wt("lx_wa_remind_head"), ...lines, `${reminderText(trucks[0], wt).recommendation}.`].join("\n");
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
