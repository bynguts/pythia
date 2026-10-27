import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { StatusDot } from "../../shared/ui/StatusDot.jsx";
import "./sendPreview.css";

const ANSWER_POLL_MS = 5000;

function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function fill(text, values) {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text);
}

/** Channel names as one phrase: "driver app · private WhatsApp", or "… · no WhatsApp contact". */
export function channelPhrase(t, channels) {
  if (!channels) return t("ea_ch_checking");
  const names = channels.map((channel) => t(`ea_ch_${channel}`));
  if (channels.includes("in_app") && !channels.includes("whatsapp_private"))
    names.push(t("ea_ch_no_whatsapp"));
  return names.join(" · ");
}

/** Where a message to one truck's driver goes (GET /driver/messages/channels/{truck}); null while unknown. */
export function useDriverChannels(truckCodes) {
  const key = truckCodes.filter(Boolean).join(",");
  const [channels, setChannels] = useState({});
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    for (const code of key.split(",")) {
      apiGet(`/driver/messages/channels/${encodeURIComponent(code)}`, { signal: controller.signal })
        .then((body) => setChannels((current) => ({ ...current, [code]: body?.channels || ["in_app"] })))
        .catch((error) => {
          // Unknown: the app inbox is always the first channel, so say only that.
          if (error?.name !== "AbortError") setChannels((current) => ({ ...current, [code]: ["in_app"] }));
        });
    }
    return () => controller.abort();
  }, [key]);
  return channels;
}

/** The driver's answer to one sent message (GET /dispatch/{id}/status), polled until it lands. */
export function DriverAnswer({ dispatchId }) {
  const { t } = useLanguage();
  const [answer, setAnswer] = useState({ status: "PENDING", note: "" });
  useEffect(() => {
    if (!dispatchId || answer.status !== "PENDING") return undefined;
    const poll = () =>
      apiGet(`/dispatch/${encodeURIComponent(dispatchId)}/status`)
        .then((dispatch) => {
          const status = String(dispatch?.field_status || "PENDING").toUpperCase();
          if (status !== "PENDING") setAnswer({ status, note: dispatch.confirmed_note || "" });
        })
        .catch(() => {}); // keep "not read yet" until a poll reads an answer
    poll();
    const timer = setInterval(poll, ANSWER_POLL_MS);
    return () => clearInterval(timer);
  }, [dispatchId, answer.status]);
  const ready = answer.status === "READY" || answer.status === "SIAP" || answer.status === "DONE";
  const label = ready
    ? t("ea_driver_read")
    : answer.status === "PENDING"
      ? t("ea_driver_waiting")
      : answer.note
        ? fill(t("ea_driver_issue"), { reason: answer.note })
        : t("ea_driver_issue_plain");
  return (
    <StatusDot
      tone={ready ? "ok" : answer.status === "PENDING" ? "idle" : "warn"}
      data-testid="send-driver-answer"
      data-status={answer.status}
    >
      {label}
    </StatusDot>
  );
}

/**
 * "Send to the driver of T-047?": who gets it, on which channels, and the full text, which the
 * operator may edit; then Send, Edit or Dismiss. Nothing is sent before Send. The text is shown
 * and sent as plain characters (never rendered as links or markdown).
 * @param {{
 *   title: string,
 *   kicker?: string,
 *   note?: string,
 *   messages: { key: string, to: string, channels: string[]|null, text: string, lang?: string }[],
 *     // lang: the language the driver reads it in (the WhatsApp message language setting)
 *   onSend: (texts: Record<string, string>, operationId: string) => Promise<void>,
 *     // throws (with .status) on failure; operationId (X-Operation-Id) is one per preview,
 *     // so pressing Send again after a lost answer never messages the driver twice
 *   onDismiss: () => void,
 *   testId?: string,
 * }} props
 */
export function SendPreview({ title, kicker, note, messages, onSend, onDismiss, testId = "send-preview" }) {
  const { t, lang } = useLanguage();
  const [texts, setTexts] = useState(() => Object.fromEntries(messages.map((m) => [m.key, m.text])));
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState({ busy: false, error: null });
  // A double tap lands before the busy state renders; the ref keeps it to one send.
  const sending = useRef(false);
  const operationId = useRef(null);

  async function send() {
    if (sending.current) return;
    const trimmed = Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, value.trim()]));
    if (Object.values(trimmed).some((value) => !value)) {
      setEditing(true);
      setState({ busy: false, error: t("ea_err_empty") });
      return;
    }
    sending.current = true;
    setState({ busy: true, error: null });
    try {
      operationId.current ||= newOperationId();
      await onSend(trimmed, operationId.current);
      setState({ busy: false, error: null });
    } catch (error) {
      setState({ busy: false, error: t(error?.status === 403 ? "ea_err_denied" : "ea_err_failed") });
    } finally {
      sending.current = false;
    }
  }

  return (
    <div className="send-preview" role="group" aria-label={title} data-testid={testId}>
      {kicker && <span className="send-preview-kicker">{kicker}</span>}
      <p className="send-preview-title">{title}</p>
      {messages.map((message) => (
        <div className="send-preview-msg" key={message.key} data-testid="send-preview-message">
          <p className="send-preview-to" data-testid="send-preview-to">
            <strong>{message.to}</strong> · {channelPhrase(t, message.channels)}
          </p>
          {/* A text in another language than the console's says which, so the screen never
              mixes languages unlabelled: "Message to driver · Bahasa Indonesia". */}
          {message.lang && message.lang !== lang && (
            <p className="send-preview-lang" data-testid="send-preview-lang">
              {fill(t("ea_msg_lang"), { language: t(`ea_lang_${message.lang}`) })}
            </p>
          )}
          {editing ? (
            <textarea
              className="send-preview-input"
              rows={3}
              maxLength={500}
              lang={message.lang}
              value={texts[message.key]}
              aria-label={fill(t("ea_text_label"), { who: message.to })}
              onChange={(event) => setTexts((current) => ({ ...current, [message.key]: event.target.value }))}
              data-testid="send-preview-input"
            />
          ) : (
            <p className="send-preview-text" lang={message.lang} data-testid="send-preview-text">
              {texts[message.key]}
            </p>
          )}
        </div>
      ))}
      {note && <p className="send-preview-note">{note}</p>}
      <div className="send-preview-actions">
        <Button
          size="sm"
          variant="primary"
          icon={Send}
          disabled={state.busy}
          aria-busy={state.busy || undefined}
          onClick={send}
          data-testid="send-preview-send"
        >
          {t("ea_send")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-pressed={editing}
          disabled={state.busy}
          onClick={() => setEditing((value) => !value)}
          data-testid="send-preview-edit"
        >
          {editing ? t("ea_done_editing") : t("ea_edit")}
        </Button>
        <button
          type="button"
          className="send-preview-dismiss"
          disabled={state.busy}
          onClick={onDismiss}
          data-testid="send-preview-dismiss"
        >
          {t("ea_dismiss")}
        </button>
      </div>
      {state.error && (
        <p className="send-preview-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
