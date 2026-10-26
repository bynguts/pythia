/**
 * 7 px dot plus label, as in table cells and legends ("46 ready", "Brakes: NO").
 * @param {{ tone?: "ok"|"warn"|"danger"|"idle"|"info", children: any, className?: string }} props
 */
export function StatusDot({ tone = "idle", className = "", children, ...rest }) {
  return (
    <span className={`ui-status ${className}`.trim()} {...rest}>
      <span className={`ui-status-dot ui-status-${tone}`} aria-hidden="true" />
      <span className="ui-status-label">{children}</span>
    </span>
  );
}
