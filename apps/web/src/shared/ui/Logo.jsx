import { Mascot } from "./Mascot.jsx";

/**
 * Mascot mark plus the "Pythia" wordmark (Archivo 700, 19 px).
 * @param {{ wordmark?: boolean, className?: string }} props wordmark=false shows the mark alone.
 */
export function Logo({ wordmark = true, className = "" }) {
  return (
    <span className={`ui-logo ${className}`.trim()}>
      <Mascot size={24} />
      {wordmark && <span className="ui-logo-word">Pythia</span>}
    </span>
  );
}
