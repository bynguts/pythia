import { Check } from "lucide-react";
import { StatusBadge } from "../../shared/ui/StatusBadge.jsx";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";

const STEPS = [
  { number: "01", label: "w10num_step_forecast" },
  { number: "02", label: "w10num_step_allocation" },
  { number: "03", label: "w10num_step_approval" },
];

// Planning: three full-width stages on one surface each, read top to bottom.
// Each stage puts its input on the left and its result on the right, so no stage
// leaves a hole beside a longer neighbour. The stepper follows the real state:
// the forecast loads, a plan is built, a plan is approved.
export function IntegratedPlanning({ summary, scenario, evidence, unmetCount, planStatus, hasOutlook }) {
  const { t, lang } = useLanguage();
  const current = !hasOutlook ? 0 : planStatus === "approved" ? 3 : planStatus ? 2 : 1;
  const stepState = (index) => (index < current ? "done" : index === current ? "current" : "next");
  const stages = [
    { number: "01", title: t("w10num_stage1_title"), description: t("w10num_stage1_sub"), key: "inputs" },
    {
      number: "02",
      title: t("w10num_stage2_title"),
      description: t("w10num_stage2_sub"),
      key: "recommendation",
    },
  ];

  return (
    <section className="planning-workspace workspace-page" data-testid="planning-workspace">
      <header className="workspace-heading planning-heading">
        <div>
          <h1>{t("w10num_plan_title")}</h1>
          <p>{t("w10num_plan_sub")}</p>
        </div>
        <div className="planning-status">
          {unmetCount > 0 ? (
            <StatusBadge tone="danger">
              {t("w10num_unmet_count").replace("{n}", unmetCount.toLocaleString(localeFor(lang)))}
            </StatusBadge>
          ) : (
            <StatusBadge tone="success">
              {t(
                planStatus === "approved"
                  ? "w10num_status_badge_approved"
                  : planStatus === "proposed"
                    ? "w10num_status_badge_review"
                    : "w10num_status_badge_ready",
              )}
            </StatusBadge>
          )}
        </div>
      </header>

      <ol className="planning-progress" aria-label={t("w10num_stages_label")}>
        {STEPS.map((step, index) => {
          const state = stepState(index);
          return (
            <li
              key={step.number}
              className={`is-${state}`}
              aria-current={state === "current" ? "step" : undefined}
              data-state={state}
            >
              <span className="planning-progress-mark" aria-hidden="true">
                {state === "done" ? <Check size={14} strokeWidth={2.5} /> : step.number}
              </span>
              <span className="planning-progress-text">
                <b>{t(step.label)}</b>
                <small>{t(`w11plan_step_${state}`)}</small>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="planning-flow">
        {stages.map((stage) => (
          <section
            className={`planning-stage-card stage-${stage.number}`}
            key={stage.key}
            aria-labelledby={`planning-stage-${stage.number}`}
          >
            <header className="planning-stage-heading">
              <span className="planning-stage-number">{stage.number}</span>
              <div>
                <h2 id={`planning-stage-${stage.number}`}>{stage.title}</h2>
                <p>{stage.description}</p>
              </div>
            </header>
            <div className="planning-stage-content">{scenario[stage.key]}</div>
          </section>
        ))}

        <section className="planning-stage-card planning-approval-stage" aria-labelledby="planning-stage-03">
          <header className="planning-stage-heading">
            <span className="planning-stage-number">03</span>
            <div>
              <h2 id="planning-stage-03">{t("w10num_stage3_title")}</h2>
              <p>{t("w10num_stage3_sub")}</p>
            </div>
          </header>
          {/* The brief reads on the left; the authority column always says the next step. */}
          <div className="planning-review-grid">
            <div className="planning-summary">{summary}</div>
            <aside className="planning-approval" aria-labelledby="planning-approval-title">
              {evidence}
            </aside>
          </div>
        </section>
      </div>
    </section>
  );
}
