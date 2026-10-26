const PHASES = ["plan", "ready", "run", "close"];

/**
 * The sidebar day card: title + time, four segments, four labels.
 * @param {{
 *   phase: "plan"|"ready"|"run"|"close",
 *   title: any,                 // phase name, e.g. "Operations"
 *   time?: any,                 // "09:12"
 *   labels: { plan: any, ready: any, run: any, close: any },
 *   label?: string,  // aria-label of the card
 *   hint?: string,   // tooltip: how the phase is derived
 *   className?: string
 * }} props
 */
export function DayCycle({ phase, title, time, labels, label, hint, className = "" }) {
  const current = PHASES.indexOf(phase);
  return (
    <section
      className={`ui-daycycle ${className}`.trim()}
      aria-label={label}
      title={hint}
      data-phase={phase}
      data-testid="day-cycle"
    >
      <div className="ui-daycycle-head">
        <strong>{title}</strong>
        {time && <time>{time}</time>}
      </div>
      <div className="ui-daycycle-segs" aria-hidden="true">
        {PHASES.map((id, index) => (
          <span
            key={id}
            className={index < current ? "is-done" : index === current ? "is-active" : undefined}
          />
        ))}
      </div>
      <ol className="ui-daycycle-labels">
        {PHASES.map((id) => (
          <li key={id} aria-current={id === phase ? "step" : undefined}>
            {labels[id]}
          </li>
        ))}
      </ol>
    </section>
  );
}
