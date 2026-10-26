import { useEffect, useRef } from "react";
import { LogIn } from "lucide-react";
import { useLanguage } from "../i18n/index.jsx";
import { Button } from "./Button.jsx";

/**
 * Session-ended modal over a grey veil: "You've been signed out" + Sign in again.
 * @param {{ open: boolean, onSignIn: () => void, body?: any }} props
 *   body overrides the default text (12-hour sessions, you land back on this page).
 */
export function SessionEnded({ open, onSignIn, body }) {
  const { t } = useLanguage();
  const buttonRef = useRef(null);
  useEffect(() => {
    if (open) buttonRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="ui-session-veil" role="presentation">
      <div
        className="ui-session-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ui-session-title"
        aria-describedby="ui-session-body"
        data-testid="session-ended"
      >
        <span className="ui-sev ui-sev-neutral" aria-hidden="true">
          <LogIn size={16} />
        </span>
        <h2 id="ui-session-title" className="ui-session-title">
          {t("f_session_title")}
        </h2>
        <p id="ui-session-body" className="ui-session-body">
          {body || t("f_session_body")}
        </p>
        <Button ref={buttonRef} variant="primary" className="ui-session-action" onClick={onSignIn}>
          {t("f_session_sign_in")}
        </Button>
      </div>
    </div>
  );
}
