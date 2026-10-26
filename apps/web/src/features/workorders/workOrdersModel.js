// Pure helpers for the Work orders screen. The list is GET /api/spj (summaries); a status the API
// does not store (proof missing, on route, at TPA) is derived here from the fields it does.

export const TABS = ["active", "proof", "drafts", "closed"];

const completedStops = (spj) => (spj.stops || []).filter((stop) => stop.status === "completed");

// An active order whose completed stop carries no field evidence and no supervisor override, or
// one that must weigh on site and whose completed stop has no weights.
export function proofMissing(spj) {
  if (spj.status !== "aktif") return false;
  return completedStops(spj).some((stop) => {
    if (stop.override) return false;
    if (!stop.evidence_summary) return true;
    return !!spj.weigh_on_site && !stop.evidence_summary.weighing_count;
  });
}

export function tabOf(spj) {
  if (spj.status === "draft") return "drafts";
  if (spj.status === "selesai") return "closed";
  if (spj.status === "aktif") return "active";
  return null; // batal stays hidden
}

export function tabCounts(items) {
  const counts = { active: 0, proof: 0, drafts: 0, closed: 0 };
  for (const spj of items) {
    const tab = tabOf(spj);
    if (tab) counts[tab] += 1;
    if (proofMissing(spj)) counts.proof += 1;
  }
  return counts;
}

export function inTab(spj, tab) {
  return tab === "proof" ? proofMissing(spj) : tabOf(spj) === tab;
}

// waitingSpjIds: SPJ ids whose truck is waiting at the TPA gate (GET /safety/overview).
export function rowState(spj, waitingSpjIds) {
  if (spj.status === "draft") return "draft";
  if (spj.status === "selesai") return "closed";
  if (proofMissing(spj)) return "proof";
  if (waitingSpjIds.has(spj.spj_id)) return "at_tpa";
  return completedStops(spj).length === 0 ? "activated" : "on_route";
}

export const STATE_TONE = {
  proof: "warn",
  on_route: "ok",
  at_tpa: "info",
  activated: "idle",
  draft: "idle",
  closed: "idle",
};

export function matches(spj, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [spj.spj_number, spj.truck_code, spj.driver_name].some((field) =>
    String(field || "")
      .toLowerCase()
      .includes(needle),
  );
}

// The plan an SPJ was drafted from: its note starts "Rencana <plan_id> ...".
export function planIdOf(spj) {
  const found = /^Rencana (\S+)/.exec(spj.note || "");
  return found ? found[1] : null;
}

export function stopsDone(spj) {
  return `${completedStops(spj).length}/${(spj.stops || []).length}`;
}

// kg → tonnes, one decimal, in the UI language.
export function tonnes(kg, locale) {
  return (Number(kg) / 1000).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// A receipt whose OCR reading nobody has confirmed or corrected yet.
export function receiptNeedsReview(spj) {
  return !!spj.receipt && !["confirmed", "corrected"].includes(spj.receipt.ocr?.status);
}

export const FRACTIONS = ["Residu", "Organik", "Anorganik"];

// Audit action → i18n key. Unknown actions fall back to the raw action name.
export const AUDIT_KEYS = {
  plan_proposed: "s4_audit_plan_proposed",
  plan_approved: "s4_audit_plan_approved",
  dispatch_sent: "s4_audit_dispatch_sent",
  dispatch_confirmed: "s4_audit_dispatch_confirmed",
  create: "s4_audit_create",
  activate: "s4_audit_activate",
  complete_stop: "s4_audit_complete_stop",
  skip_stop: "s4_audit_skip_stop",
  complete: "s4_audit_complete",
  override: "s4_audit_override",
  cancel: "s4_audit_cancel",
  gate_arrival: "s4_audit_gate_arrival",
  receipt: "s4_audit_receipt",
  receipt_ocr: "s4_audit_receipt_ocr",
  receipt_review: "s4_audit_receipt_review",
  reassign: "s4_audit_reassign",
};

export function mergeAudit(audit, planEvents) {
  return [...(planEvents || []), ...(audit || [])]
    .filter((entry) => entry.created_at && !Number.isNaN(new Date(entry.created_at).getTime()))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}
