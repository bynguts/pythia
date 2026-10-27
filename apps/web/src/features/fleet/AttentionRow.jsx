import { ArrowRight } from "lucide-react";

// One row anatomy for everything in "Perlu tindakan", in the shared flat-row
// markup (.ui-row): a tinted icon square, a one-line title, a one-line meta, green action
// links and a small mono aside (time, status or provenance). Hand-rolled instead of
// <ListRow> because the rail rows carry their own classes and data attributes.
export function AttentionRow({
  tone = "neutral",
  icon: Icon,
  title,
  meta,
  aside,
  className = "",
  children,
  ...rest
}) {
  return (
    <li className={`ui-row action-row ${className}`.trim()} data-tone={tone} {...rest}>
      <span className="ui-row-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={1.9} />
      </span>
      <div className="ui-row-body">
        <div className="ui-row-title">{title}</div>
        {meta && <p className="ui-row-meta">{meta}</p>}
        {children}
      </div>
      {aside}
    </li>
  );
}

// A row's action: the green link with an arrow; `quiet` draws it in ink for the second one.
export function AttentionAction({ children, quiet = false, ...rest }) {
  return (
    <button type="button" className={`ui-row-action${quiet ? " is-quiet" : ""}`} {...rest}>
      {children}
      {!quiet && <ArrowRight size={15} aria-hidden="true" />}
    </button>
  );
}
