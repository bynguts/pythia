import { useLanguage } from "../../shared/i18n/index.jsx";
import { Provenance } from "../../shared/ui/Provenance.jsx";

// R7/R8: the quotas and facility rules the day plan treated as hard limits,
// each with its source and how sure we are of it (reported, example, assumption).

function useNumber() {
  const { lang } = useLanguage();
  const locale = lang === "id" ? "id-ID" : "en-US";
  return (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
}

function ClassChip({ classification }) {
  const { t } = useLanguage();
  if (!classification) return null;
  const key = `pln6_class_${classification}`;
  const label = t(key);
  return (
    <Provenance kind="proxy" className="plan-rule-class">
      {label === key ? classification : label}
    </Provenance>
  );
}

function SourceLink({ url }) {
  const { t } = useLanguage();
  if (!url) return null;
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // keep the raw URL as the label
  }
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {t("pln6_source")}: {host}
    </a>
  );
}

export function PlanQuotaUsage({ plan }) {
  const { t } = useLanguage();
  const number = useNumber();
  const rows = plan?.quota_usage || [];
  if (!rows.length) return null;
  return (
    <div className="plan-quota-usage" data-testid="quota-usage">
      <h4>{t("pln6_quota_title")}</h4>
      <div className="ui-table-wrap">
        <table className="ui-table plan-table">
          <thead>
            <tr>
              <th scope="col">{t("pln6_quota_district")}</th>
              <th scope="col" className="num">
                {t("pln6_quota_used")}
              </th>
              <th scope="col" className="num">
                {t("pln6_quota_needed")}
              </th>
              <th scope="col" className="num">
                {t("pln6_quota_unassigned")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.area} data-testid={`quota-row-${row.area}`}>
                <td>
                  {row.label}
                  {row.binding_limit && (
                    <small className="plan-table-sub text-danger">
                      {t(`pln6_binding_${row.binding_limit}`)}
                    </small>
                  )}
                </td>
                <td className="num">
                  {row.quota_rit_per_day == null
                    ? `${number(row.rit_used)} / ${t("pln6_quota_none")}`
                    : `${number(row.rit_used)} / ${number(row.quota_rit_per_day)}`}
                  {row.quota_source?.classification && (
                    <small className="plan-table-sub">
                      <ClassChip classification={row.quota_source.classification} />
                    </small>
                  )}
                </td>
                <td className="num">{number(row.rit_needed)}</td>
                <td className={row.unassigned_tons > 0 ? "num text-danger" : "num"}>
                  {number(row.unassigned_tons)} t
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="kec-note">
        {t("pln6_quota_note")}{" "}
        <SourceLink url={rows.find((r) => r.quota_source?.source_url)?.quota_source.source_url} />
      </p>
    </div>
  );
}

function ruleText(t, number, rule, facility) {
  const key = `pln6_rule_${rule.rule}`;
  const value = Array.isArray(rule.value)
    ? rule.value.join(", ")
    : rule.rule.endsWith("_share")
      ? number(Number(rule.value) * 100)
      : number(rule.value);
  if (rule.rule === "accepts")
    return t(facility.compactor_only ? "pln6_rule_accepts_compactor" : "pln6_rule_accepts_all");
  return t(key).replace("{v}", value);
}

export function PlanRules({ plan }) {
  const { t } = useLanguage();
  const number = useNumber();
  const facilities = plan?.rules?.facilities || [];
  if (!facilities.length) return null;
  const usage = Object.fromEntries((plan.facility_usage || []).map((f) => [f.facility, f]));
  return (
    <details className="plan-disclosure plan-rules" data-testid="plan-rules">
      <summary>{t("pln6_rules_title").replace("{date}", plan.plan_date || "")}</summary>
      <p className="kec-note">{t("pln6_rules_note")}</p>
      {facilities.map((facility) => {
        const used = usage[facility.name];
        const limits = [
          facility.daily_rit_cap != null &&
            t("pln6_limit_daily_rit")
              .replace("{used}", number(used?.trips))
              .replace("{v}", number(facility.daily_rit_cap)),
          facility.shift_rit_cap != null &&
            t("pln6_limit_shift_rit").replace("{v}", number(facility.shift_rit_cap)),
          facility.daily_tons_cap != null &&
            t("pln6_limit_daily_tons")
              .replace("{used}", number(used?.tons_capacity_sent))
              .replace("{v}", number(facility.daily_tons_cap)),
        ].filter(Boolean);
        return (
          <section
            key={facility.name}
            data-testid={`plan-rules-${facility.name.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <h4>{facility.display_name}</h4>
            {limits.length > 0 && <p>{limits.join(" · ")}</p>}
            <ul>
              {facility.rules.map((rule) => (
                <li key={`${rule.rule}-${rule.effective_from || ""}`}>
                  {ruleText(t, number, rule, facility)} <ClassChip classification={rule.classification} />
                  {rule.planner_effect_classification && (
                    <>
                      {" "}
                      {t("pln6_rule_effect")}{" "}
                      <ClassChip classification={rule.planner_effect_classification} />
                    </>
                  )}{" "}
                  <SourceLink url={rule.source_url} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </details>
  );
}
