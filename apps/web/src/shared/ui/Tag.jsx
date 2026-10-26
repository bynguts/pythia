/**
 * Small rounded label: "Model", counts, "Coming soon", statuses.
 * @param {{ tone?: "model"|"real"|"live"|"field"|"warn"|"danger"|"success"|"neutral"|"soon",
 *   title?: string, className?: string, children: any }} props
 *   title: tooltip, e.g. the provenance of a modelled number.
 */
export function Tag({ tone = "neutral", title, className = "", children, ...rest }) {
  return (
    <span className={`ui-tag ui-tag-${tone} ${className}`.trim()} title={title} {...rest}>
      {children}
    </span>
  );
}
