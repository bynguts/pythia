import { CircleX, RotateCcw } from "lucide-react";
import { useLanguage } from "../i18n/index.jsx";
import { Button } from "./Button.jsx";

/**
 * Failure: red icon, title, reason, optional suggestions, retry plus secondary actions.
 * @param {{
 *   title: any, reason?: any,
 *   suggestions?: any[],   // "Try one of these" bullets
 *   onRetry?: () => void,  // shows the green "Try again" button
 *   actions?: any,         // extra buttons after Try again
 *   testId?: string, className?: string
 * }} props
 */
export function ErrorState({ title, reason, suggestions = [], onRetry, actions, testId, className = "" }) {
  const { t } = useLanguage();
  return (
    <div className={`ui-error ${className}`.trim()} role="alert" data-testid={testId}>
      <div className="ui-error-head">
        <span className="ui-sev ui-sev-danger" aria-hidden="true">
          <CircleX size={15} />
        </span>
        <div>
          <h3 className="ui-error-title">{title}</h3>
          {reason && <p className="ui-error-reason">{reason}</p>}
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="ui-error-fix">
          <span className="ui-error-fix-title">{t("f_error_try")}</span>
          <ul>
            {suggestions.map((suggestion, index) => (
              <li key={index}>{suggestion}</li>
            ))}
          </ul>
        </div>
      )}
      {(onRetry || actions) && (
        <div className="ui-error-actions">
          {onRetry && (
            <Button variant="primary" size="sm" icon={RotateCcw} onClick={onRetry}>
              {t("f_try_again")}
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
