import { WifiOff } from "lucide-react";
import { useLanguage } from "../i18n/index.jsx";

/**
 * "Connection lost. Showing data from HH:MM." with a "Retrying…" note.
 * @param {{ since?: string|null, retrying?: boolean, message?: any, className?: string }} props
 *   since: the HH:MM of the data on screen (omit when unknown); message overrides the text.
 */
export function OfflineBanner({ since, retrying = true, message, className = "" }) {
  const { t } = useLanguage();
  const text = message || (since ? t("f_offline_since").replace("{time}", since) : t("f_offline"));
  return (
    <div className={`ui-offline ${className}`.trim()} role="status" data-testid="offline-banner">
      <WifiOff size={16} aria-hidden="true" />
      <span className="ui-offline-text">{text}</span>
      {retrying && <span className="ui-offline-retry">{t("f_retrying")}</span>}
    </div>
  );
}
