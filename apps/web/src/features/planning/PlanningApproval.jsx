import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { ArrowUp, Check, Clock } from "lucide-react";

const ROLE_KEYS = ["administrator", "supervisor", "dispatcher", "executive", "auditor", "driver"];

export function ScenarioPanel({ mode, children }) {
  return <div className={`scenario-panel scenario-${mode}`}>{children}</div>;
}

// Step 03's authority column: who may decide, what the plan holds, and the one
// next action. Without a plan it points back to step 02 instead of sitting empty.
// wave11: the plan may come from another browser (the approver's inbox); it then says
// who proposed it and when. A role that may not approve waits for one that may.
export function PlanningApproval({ plan, planLoading, approved, approvePlan, role, canApprove, fromInbox }) {
  const { lang, t } = useLanguage();
  const locale = localeFor(lang);
  const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 2 });
  const roleName = ROLE_KEYS.includes(role) ? t(`pln6_profile_role_${role}`) : t("pln6_profile_role_unknown");
  // R7: a quota or gate shortfall is a fact of the day, not an error the
  // dispatcher can resolve, so it does not block approval of the feasible
  // trips; it is stated next to the button instead. A plan with no trips, or
  // one the solver could not build, still cannot be approved.
  const blocked =
    !plan?.assignments?.length ||
    (plan?.unmet_reasons || []).some((code) => code.startsWith("no_") && !code.includes(":"));
  const shortfall = plan?.feasible === false && plan?.unassigned_tons > 0 ? plan.unassigned_tons : 0;
  const compliant = (plan?.assignments || []).filter((a) => a.evidence?.permit_compliant).length;
  const proposer = ROLE_KEYS.includes(plan?.proposed_by)
    ? t(`pln6_profile_role_${plan.proposed_by}`)
    : t("pln6_profile_role_unknown");
  const proposedAt = plan?.created_at
    ? new Date(plan.created_at).toLocaleString(locale, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const goToAllocation = () => {
    const stage = document.getElementById("planning-stage-02")?.closest("section");
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    stage?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    stage?.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
  };

  return (
    <div className="planning-approval-body">
      <div className="planning-approval-head">
        <h3 id="planning-approval-title">{t("pa_title")}</h3>
        <p className="planning-approval-role">
          {t("pa_role")}: <b>{roleName}</b>
        </p>
      </div>
      {!plan && (
        <>
          <p className="planning-approval-note">{t("pa_no_plan")}</p>
          <button type="button" className="ghost-button planning-approval-goto" onClick={goToAllocation}>
            {t("pa_go_step2")} <ArrowUp size={15} aria-hidden="true" />
          </button>
        </>
      )}
      {plan && (
        <div className="planning-approval-plan" data-testid={fromInbox ? "pending-plan" : undefined}>
          {fromInbox && (
            <p className="planning-approval-from" data-testid="approval-proposed-by">
              {t("w11plan_proposed_by")
                .replace("{role}", proposer)
                .replace("{time}", proposedAt || "—")}
            </p>
          )}
          <dl className="approval-evidence-list" data-testid="approval-plan" data-plan-id={plan.plan_id}>
            <div>
              <dt>{t("pa_plan")}</dt>
              <dd>{plan.plan_id}</dd>
            </div>
            {plan.plan_date && (
              // The approver must see which day the trips are for, not only the page's date.
              <div>
                <dt>{t("pln6_plan_date")}</dt>
                <dd data-testid="approval-plan-date">{plan.plan_date}</dd>
              </div>
            )}
            <div>
              <dt>{t("pa_assigned")}</dt>
              <dd>
                {t("pa_tons")
                  .replace("{a}", number(plan.total_assigned_tons))
                  .replace("{b}", number(plan.total_demand_tons))}
              </dd>
            </div>
            <div>
              <dt>{t("pa_permit")}</dt>
              <dd>{t("pa_compliant").replace("{n}", number(compliant))}</dd>
            </div>
          </dl>
        </div>
      )}
      {plan?.status === "proposed" && !blocked && shortfall > 0 && (
        <p className="planning-approval-note" data-testid="approval-shortfall-note">
          {t("pln6_shortfall_approve_note").replace("{t}", number(shortfall))}
        </p>
      )}
      {plan?.status === "proposed" && !blocked && canApprove && (
        <button
          type="button"
          className="primary-button approve-dispatch-btn"
          data-testid="approve-plan"
          onClick={approvePlan}
          disabled={planLoading}
        >
          {planLoading ? t("pa_approving") : t("pa_approve")}
        </button>
      )}
      {plan?.status === "proposed" && !blocked && !canApprove && (
        <p className="planning-approval-waiting" role="status" data-testid="plan-awaiting-approval">
          <Clock size={16} aria-hidden="true" />
          <span>
            <b>{t("w11plan_awaiting_approval")}</b> {t("w11plan_awaiting_note")}
          </span>
        </p>
      )}
      {plan?.status === "proposed" && blocked && (
        <p className="planning-approval-note planning-approval-blocked">{t("pa_blocked")}</p>
      )}
      {approved && (
        <p className="planning-approval-done" role="status" data-testid="approval-done">
          <Check size={16} aria-hidden="true" /> {t("pa_approved")}
        </p>
      )}
    </div>
  );
}
