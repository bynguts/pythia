import { CheckCircle2, CircleDot, Workflow } from "lucide-react";
import { StatusBadge } from "../../shared/ui/StatusBadge.jsx";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";

export function IntegratedPlanning({ summary, scenario, evidence, unmetCount, planStatus }) {
  const { t, lang } = useLanguage();
  const stages = [
    {
      number: "01",
      title: t("w10num_stage1_title"),
      description: t("w10num_stage1_sub"),
      key: "inputs",
    },
    {
      number: "02",
      title: t("w10num_stage2_title"),
      description: t("w10num_stage2_sub"),
      key: "recommendation",
    },
  ];

  return (
    <section className="planning-workspace workspace-page" data-testid="planning-workspace">
      <header className="workspace-heading">
        <div>
          <span className="workspace-kicker">
            <Workflow size={14} /> {t("w10num_plan_kicker")}
          </span>
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
        <li className="active">
          <CircleDot size={17} />
          <span>
            <b>01</b>
            {t("w10num_step_forecast")}
          </span>
        </li>
        <li>
          <span className="progress-line" />
          <CircleDot size={17} />
          <span>
            <b>02</b>
            {t("w10num_step_allocation")}
          </span>
        </li>
        <li>
          <span className="progress-line" />
          <CheckCircle2 size={17} />
          <span>
            <b>03</b>
            {t("w10num_step_approval")}
          </span>
        </li>
      </ol>

      <div className="planning-decision-grid">
        {stages.map((stage) => (
          <section
            className={`planning-stage-card stage-${stage.number}`}
            key={stage.key}
            aria-labelledby={`planning-stage-${stage.number}`}
          >
            <header className="planning-stage-heading">
              <span>{stage.number}</span>
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
            <span>03</span>
            <div>
              <h2 id="planning-stage-03">{t("w10num_stage3_title")}</h2>
              <p>{t("w10num_stage3_sub")}</p>
            </div>
          </header>
          {/* Teardown v4 R3: two columns only once a plan gives the approval column content. */}
          <div className={`planning-review-grid${planStatus ? "" : " is-single"}`}>
            <div className="planning-summary">{summary}</div>
            <div className="planning-approval">{evidence}</div>
          </div>
        </section>
      </div>
    </section>
  );
}
