import { CircleCheck } from "lucide-react";

/**
 * Step progress (Forecast / Field facts / Allocation / Approval).
 * @param {{
 *   steps: { key: string, label: any, note?: any }[],  // note: small muted text ("Model · 05:00")
 *   current: number,   // index of the active step; earlier steps show done, later ones pending
 *   allDone?: boolean, // every bar filled (e.g. submitted, waiting for approval)
 *   compact?: boolean, // the States variant: bars + labels only, active label bold
 *   label?: string, className?: string
 * }} props
 */
export function Progress4({ steps, current, allDone = false, compact = false, label, className = "" }) {
  return (
    <ol className={`ui-progress4${compact ? " is-compact" : ""} ${className}`.trim()} aria-label={label}>
      {steps.map((step, index) => {
        const done = allDone || index < current;
        const active = index === current;
        const state = active ? "active" : done ? "done" : "todo";
        return (
          <li
            key={step.key}
            className={`ui-progress4-step is-${state}${done ? " is-filled" : ""}`}
            aria-current={active ? "step" : undefined}
          >
            <span className="ui-progress4-bar" aria-hidden="true" />
            <span className="ui-progress4-row">
              {!compact && done && !active && (
                <CircleCheck className="ui-progress4-check" size={14} aria-hidden="true" />
              )}
              <span className="ui-progress4-label">{step.label}</span>
              {!compact && step.note && <span className="ui-progress4-note">{step.note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
