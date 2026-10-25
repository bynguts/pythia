import { ArrowRight } from "lucide-react";

// A flat work-rail row: tinted icon square, title, one-line meta, a green action
// link and a mono timestamp. Rows sit in a <ul className="ui-list">, split by hairlines.
export function ListRow({
  icon: Icon,
  tone = "neutral",
  title,
  meta,
  time,
  action,
  selected,
  testId,
  children,
}) {
  return (
    <li
      className={`ui-row${selected ? " is-selected" : ""}`}
      data-tone={tone}
      data-testid={testId}
      aria-current={selected ? "true" : undefined}
    >
      {Icon && (
        <span className="ui-row-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.9} />
        </span>
      )}
      <div className="ui-row-body">
        <p className="ui-row-title">{title}</p>
        {meta && <p className="ui-row-meta">{meta}</p>}
        {children}
        {action &&
          (action.href ? (
            <a className="ui-row-action" href={action.href}>
              {action.label}
              <ArrowRight size={15} aria-hidden="true" />
            </a>
          ) : (
            <button
              className="ui-row-action"
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              data-testid={action.testId}
            >
              {action.label}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          ))}
      </div>
      {time && <span className="ui-row-time">{time}</span>}
    </li>
  );
}
