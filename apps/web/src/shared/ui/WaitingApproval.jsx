import { Hourglass } from "lucide-react";
import { useLanguage } from "../i18n/index.jsx";
import { Progress4 } from "./Progress4.jsx";

/**
 * The waiting-for-approval panel: banner, the four steps all filled with Approval
 * active, then the actions (e.g. Remind supervisor, Withdraw).
 * @param {{
 *   submittedAt?: string,  // "15:52"
 *   title?: any, body?: any,
 *   steps?: { key: string, label: any }[], // defaults to Forecast / Field facts / Allocation / Approval
 *   actions?: any, testId?: string, className?: string
 * }} props
 */
export function WaitingApproval({ submittedAt, title, body, steps, actions, testId, className = "" }) {
  const { t } = useLanguage();
  const defaultSteps = [
    { key: "forecast", label: t("f_step_forecast") },
    { key: "facts", label: t("f_step_facts") },
    { key: "allocation", label: t("f_step_allocation") },
    { key: "approval", label: t("f_step_approval") },
  ];
  const list = steps || defaultSteps;
  return (
    <div className={`ui-waiting ${className}`.trim()} data-testid={testId}>
      <div className="ui-waiting-banner" role="status">
        <span className="ui-sev ui-sev-info" aria-hidden="true">
          <Hourglass size={15} />
        </span>
        <div>
          <h3 className="ui-waiting-title">{title || t("f_waiting_title")}</h3>
          <p className="ui-waiting-body">
            {body ||
              (submittedAt ? t("f_waiting_body").replace("{time}", submittedAt) : t("f_waiting_body_notime"))}
          </p>
        </div>
      </div>
      <Progress4 steps={list} current={list.length - 1} allDone compact label={t("f_steps_label")} />
      {actions && <div className="ui-waiting-actions">{actions}</div>}
    </div>
  );
}
