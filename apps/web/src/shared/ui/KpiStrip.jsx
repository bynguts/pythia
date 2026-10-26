/**
 * Flat paper strip of KPIs (usually 4) divided by hairlines. Children are <Kpi>.
 * @param {{ label?: string, className?: string, children: any }} props label: aria-label of the group.
 */
export function KpiStrip({ label, className = "", children, ...rest }) {
  return (
    <section className={`ui-kpi-strip ${className}`.trim()} aria-label={label} {...rest}>
      {children}
    </section>
  );
}

/**
 * One KPI cell.
 * @param {{
 *   label: any,             // "Trucks on route"
 *   tag?: any,              // e.g. <Tag tone="model">Model</Tag>
 *   value: any,             // big Archivo figure; pass "—" when the API has no value
 *   unit?: any,             // "/ 52", "of 156", "t"
 *   sub?: any,              // small text under the bar
 *   progress?: number|null, // 0..1 draws the 4 px bar; null/undefined keeps an empty spacer
 *   testId?: string
 * }} props
 */
export function Kpi({ label, tag, value, unit, sub, progress, testId, className = "" }) {
  const pct =
    typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;
  return (
    <div className={`ui-kpi ${className}`.trim()} data-testid={testId}>
      <div className="ui-kpi-top">
        <span className="ui-kpi-label">{label}</span>
        {tag}
      </div>
      <div className="ui-kpi-value">
        <strong>{value}</strong>
        {unit != null && unit !== "" && <span className="ui-kpi-unit">{unit}</span>}
      </div>
      <div className={`ui-kpi-bar${pct === null ? " is-empty" : ""}`} aria-hidden="true">
        {pct !== null && <span style={{ transform: `scaleX(${pct})` }} />}
      </div>
      {sub != null && <div className="ui-kpi-sub">{sub}</div>}
    </div>
  );
}
