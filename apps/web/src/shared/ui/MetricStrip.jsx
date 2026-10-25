import { Provenance } from "./Provenance.jsx";

// One joined strip: label, a large tabular number, then the provenance label that
// keeps the number honest. `bleed` runs it edge to edge under the top bar.
export function MetricStrip({ metrics, bleed = false, label }) {
  return (
    <section
      className={`metric-strip${bleed ? " is-bleed" : ""}`}
      data-testid="metric-strip"
      aria-label={label}
    >
      {metrics.map(
        ({ label: cellLabel, value, unit, source, sourceKind = "proxy", helper, tone, testId }) => (
          <article
            className={`metric-cell${tone ? ` metric-${tone}` : ""}`}
            data-testid={testId || "metric-cell"}
            key={cellLabel}
          >
            <span className="metric-label">{cellLabel}</span>
            <strong className="metric-value">
              {value}
              {unit && <em className="metric-unit">{unit}</em>}
            </strong>
            {source && (
              <Provenance kind={sourceKind} bare>
                {source}
              </Provenance>
            )}
            {helper && <small className="metric-helper">{helper}</small>}
          </article>
        ),
      )}
    </section>
  );
}
