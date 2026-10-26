import { Mascot } from "./Mascot.jsx";

/**
 * Empty state: 64 px pixel mascot, Archivo title, body and an optional action.
 * @param {{ title: any, body?: any, action?: any, tone?: string, testId?: string, className?: string }} props
 *   action: usually a <Button size="sm">; tone: mascot colour (see Mascot).
 */
export function EmptyState({ title, body, action, tone = "green", testId, className = "" }) {
  return (
    <div className={`ui-empty ${className}`.trim()} data-testid={testId}>
      <Mascot size={64} tone={tone} />
      <h3 className="ui-empty-title">{title}</h3>
      {body && <p className="ui-empty-body">{body}</p>}
      {action}
    </div>
  );
}
