// HTML body of the Tomorrow page's PDF export: the forecast, its drivers and the plan as
// the page shows it. Pure, so it can be checked without rendering a PDF.

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export function buildTomorrowReportHtml({ t, number, title, subtitle, forecast, facts, plan, rows }) {
  const drivers = (forecast?.drivers || [])
    .map((d) => {
      const name =
        d.kind === "weather"
          ? `${d.detail?.rainfall_mm ?? 0} mm`
          : d.kind === "event" || d.kind === "holiday"
            ? d.detail?.name
            : d.detail?.weekend
              ? t("s3_why_weekend")
              : t("s3_why_workday");
      const effect =
        d.effect_tons == null ? "—" : `${d.effect_tons > 0 ? "+" : ""}${number(d.effect_tons)} t`;
      return `<li>${escape(name)}: ${escape(effect)}</li>`;
    })
    .join("");
  const factItems = (facts || [])
    .map(
      (f) =>
        `<li>${escape(f.text)} (${escape(t(`s3_src_${f.source}`))} · ${escape(
          t(f.applied ? "s3_fact_applied" : "s3_fact_not_modelled"),
        )})</li>`,
    )
    .join("");
  const planRows = (rows || [])
    .map(
      (r) =>
        `<tr><td>${escape(r.truck)}</td><td>${escape(r.districts.join(", "))}</td><td>${r.trips}</td><td>${escape(
          r.slot?.start || "—",
        )}</td><td>${number(r.tons)} t</td></tr>`,
    )
    .join("");
  return `
    <h1>${escape(title)}</h1>
    <p>${escape(subtitle)}</p>
    ${
      forecast
        ? `<h2>${escape(t("s3_fc_title"))} (MODEL OUTPUT)</h2>
    <p><b>${number(forecast.total_tonnage_t)} t</b> · ${escape(
      t("s3_fc_districts").replace("{n}", forecast.kecamatan_count),
    )}</p>
    <h3>${escape(t("s3_why"))}</h3><ul>${drivers}</ul>`
        : ""
    }
    <h2>${escape(t("s3_facts_title"))}</h2>
    ${factItems ? `<ul>${factItems}</ul>` : `<p>${escape(t("s3_facts_empty"))}</p>`}
    ${
      plan
        ? `<h2>${escape(t("s3_alloc_title"))} (CP-SAT · SIMULATED fleet)</h2>
    <p>${escape(plan.plan_id)} · ${escape(plan.status)} · ${number(plan.total_assigned_tons)} t</p>
    <table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:11px;">
      <thead><tr><th>${escape(t("s3_th_truck"))}</th><th>${escape(t("s3_th_districts"))}</th><th>${escape(
        t("s3_th_trips"),
      )}</th><th>${escape(t("s3_th_gate"))}</th><th>${escape(t("s3_th_load"))}</th></tr></thead>
      <tbody>${planRows}</tbody>
    </table>`
        : ""
    }
  `;
}
