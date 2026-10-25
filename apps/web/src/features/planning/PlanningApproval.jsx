import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { ArrowUp, Check } from "lucide-react";

const ROLE_KEYS = ["administrator", "supervisor", "dispatcher", "executive", "auditor", "driver"];

export function ScenarioPanel({ mode, children }) {
  return <div className={`scenario-panel scenario-${mode}`}>{children}</div>;
}

// Step 03's authority column: who may decide, what the plan holds, and the one
// next action. Without a plan it points back to step 02 instead of sitting empty.
export function PlanningApproval({ plan, planLoading, approved, approvePlan, role }) {
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
        <span className="role-badge">
          {t("pa_role")}: <b>{roleName}</b>
        </span>
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
        <dl className="approval-evidence-list">
          <div>
            <dt>{t("pa_plan")}</dt>
            <dd>{plan.plan_id}</dd>
          </div>
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
      )}
      {plan?.status === "proposed" && !blocked && shortfall > 0 && (
        <p className="planning-approval-note" data-testid="approval-shortfall-note">
          {t("pln6_shortfall_approve_note").replace("{t}", number(shortfall))}
        </p>
      )}
      {plan?.status === "proposed" && !blocked && (
        <button className="primary-button approve-dispatch-btn" onClick={approvePlan} disabled={planLoading}>
          {planLoading ? t("pa_approving") : t("pa_approve")}
        </button>
      )}
      {plan?.status === "proposed" && blocked && (
        <p className="planning-approval-note planning-approval-blocked">{t("pa_blocked")}</p>
      )}
      {approved && (
        <div className="optimizer-success">
          <Check size={16} /> {t("pa_approved")}
        </div>
      )}
    </div>
  );
}
