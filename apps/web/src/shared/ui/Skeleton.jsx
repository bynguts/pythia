import { useLanguage } from "../i18n/index.jsx";

const WIDTHS = [
  [180, 260],
  [140, 220],
  [200, 240],
  [120, 200],
];

/**
 * Loading rows: a 30 px block plus two bars per row, as on the States frame.
 * @param {{ rows?: number, label?: string, className?: string }} props
 *   label: screen-reader text (defaults to "Loading…").
 */
export function Skeleton({ rows = 4, label, className = "" }) {
  const { t } = useLanguage();
  return (
    <div className={`ui-skeleton ${className}`.trim()} role="status" aria-live="polite">
      <span className="sr-only">{label || t("f_loading")}</span>
      {Array.from({ length: rows }, (_, index) => {
        const [a, b] = WIDTHS[index % WIDTHS.length];
        return (
          <div className="ui-skeleton-row" key={index} aria-hidden="true">
            <span className="ui-skeleton-block" />
            <span className="ui-skeleton-lines">
              <span style={{ width: a }} />
              <span style={{ width: b }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
