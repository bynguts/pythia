/**
 * Pill tabs on a paper track: "Needs action · 6 / Ready · 46 / All 52".
 * @param {{
 *   label: string,                         // aria-label of the group
 *   value: string,
 *   options: { value: string, label: any, count?: number|null, testId?: string }[], // count renders " · n"
 *   onChange: (value: string) => void,
 *   className?: string
 * }} props
 */
export function Segmented({ label, value, options, onChange, className = "" }) {
  return (
    <div className={`ui-segmented ${className}`.trim()} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="ui-segmented-item"
          aria-pressed={value === option.value}
          data-testid={option.testId}
          onClick={() => onChange(option.value)}
        >
          <span className="ui-segmented-face">
            {option.label}
            {option.count != null && ` · ${option.count}`}
          </span>
        </button>
      ))}
    </div>
  );
}
