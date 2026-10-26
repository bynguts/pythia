import { Timer } from "lucide-react";
import { useLanguage } from "../i18n/index.jsx";

/**
 * Actions waiting to send (offline outbox).
 * @param {{ items: { id: string, label: any, status?: any }[], title?: any, note?: any, className?: string }} props
 *   title defaults to "{n} actions waiting to send"; status defaults to "Queued";
 *   note defaults to "They send on their own when the connection is back.". Renders nothing when empty.
 */
export function QueuedList({ items, title, note, className = "" }) {
  const { t } = useLanguage();
  if (!items.length) return null;
  return (
    <section className={`ui-queued ${className}`.trim()} data-testid="queued-list">
      <h3 className="ui-queued-title">
        {title ||
          t(items.length === 1 ? "f_queued_title_one" : "f_queued_title").replace("{n}", items.length)}
      </h3>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Timer size={14} aria-hidden="true" />
            <span className="ui-queued-label">{item.label}</span>
            <span className="ui-queued-status">{item.status || t("f_queued")}</span>
          </li>
        ))}
      </ul>
      <p className="ui-queued-note">{note || t("f_queued_note")}</p>
    </section>
  );
}
