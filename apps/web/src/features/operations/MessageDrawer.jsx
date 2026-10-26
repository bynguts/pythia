import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Send } from "lucide-react";
import { apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Drawer } from "../../shared/ui/Drawer.jsx";

/**
 * "Message drivers": free text to the WhatsApp alert group (POST /api/whatsapp/summary).
 * 409 = no group chosen yet (links to the WhatsApp settings), 503 = gateway offline.
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function MessageDrawer({ open, onClose }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [status, setStatus] = useState({ busy: false, sent: false, error: null });

  async function submit(event) {
    event.preventDefault();
    if (!text.trim() || status.busy) return;
    setStatus({ busy: true, sent: false, error: null });
    try {
      await apiPost("/whatsapp/summary", { text: text.trim(), lang });
      setText("");
      setStatus({ busy: false, sent: true, error: null });
    } catch (error) {
      const code = error?.status;
      setStatus({
        busy: false,
        sent: false,
        error: code === 409 ? "no_group" : code === 503 ? "offline" : code === 403 ? "denied" : "failed",
      });
    }
  }

  const errorText = {
    no_group: t("s1_msg_no_group"),
    offline: t("s1_msg_offline"),
    denied: t("s1_err_denied"),
    failed: t("s1_err_failed"),
  }[status.error];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("s1_message_drivers")}
      subtitle={t("s1_msg_sub")}
      initialFocus="#ops-message-text"
      testId="message-drawer"
    >
      <form className="ops-form" onSubmit={submit}>
        <label className="ops-field">
          <span>{t("s1_msg_text")}</span>
          <textarea
            id="ops-message-text"
            rows={5}
            maxLength={2000}
            value={text}
            placeholder={t("s1_msg_placeholder")}
            onChange={(event) => setText(event.target.value)}
            data-testid="message-text"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          icon={Send}
          disabled={status.busy || !text.trim()}
          data-testid="message-send"
        >
          {t("s1_msg_send")}
        </Button>
        {status.sent && (
          <p className="ops-form-note" role="status">
            {t("s1_msg_sent")}
          </p>
        )}
        {errorText && (
          <p className="ops-form-note is-error" role="alert" data-testid="message-error">
            {errorText}
          </p>
        )}
        {status.error === "no_group" && (
          <Button
            variant="secondary"
            data-testid="message-settings"
            onClick={() => navigate("/app/settings?tab=whatsapp")}
          >
            {t("s1_msg_settings")}
          </Button>
        )}
      </form>
    </Drawer>
  );
}
