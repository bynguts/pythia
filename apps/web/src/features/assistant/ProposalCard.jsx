import { useState } from "react";
import { apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { channelPhrase, DriverAnswer, fill, SendPreview } from "../operations/SendPreview.jsx";

/**
 * One of Ana's drafts (`proposed_actions` of /assistant/query): message_driver,
 * send_instruction or escalate_to_supervisor. Ana sent nothing; Send posts the (possibly
 * edited) text with the operator's own token, Dismiss drops it. A driver's answer to a sent
 * message shows under it.
 * @param {{ proposal: {
 *   id: string, action: string, truck_code?: string|null, kind?: string, subject?: string,
 *   text: string, channels?: string[]
 * } }} props
 */
export function ProposalCard({ proposal }) {
  const { t } = useLanguage();
  // null (draft), { kind: "dismissed" }, { kind: "supervisor" } or { kind: "driver", channels, dispatchId }
  const [result, setResult] = useState(null);
  const supervisor = proposal.action === "escalate_to_supervisor";
  const truck = proposal.truck_code || "";

  if (result?.kind === "dismissed") {
    return (
      <p className="send-preview-done is-muted" role="status" data-testid="proposal-dismissed">
        {t("ea_dismissed")}
      </p>
    );
  }
  if (result?.kind === "supervisor") {
    return (
      <p className="send-preview-done" role="status" data-testid="proposal-sent">
        {t("ea_sent_supervisor")}
      </p>
    );
  }
  if (result?.kind === "driver") {
    const delivered = result.channels
      .filter((c) => c.status === "inbox" || c.status === "sent")
      .map((c) => c.channel);
    const waFailed = result.channels.some((c) => c.channel === "whatsapp_private" && c.status === "failed");
    return (
      <div className="send-preview-done" data-testid="proposal-sent">
        <p role="status">
          {fill(t("ea_sent_driver"), { truck, channels: channelPhrase(t, delivered) })}
          {waFailed && ` ${t("ea_wa_failed")}`}
        </p>
        {result.dispatchId && <DriverAnswer dispatchId={result.dispatchId} />}
      </div>
    );
  }

  async function send(texts, operationId) {
    const text = texts[proposal.id];
    const options = { headers: { "X-Operation-Id": operationId } };
    if (supervisor) {
      await apiPost(
        "/escalations",
        {
          subject: proposal.subject || text.split("\n")[0],
          text,
          truck_code: proposal.truck_code || null,
          source: "assistant",
          proposal_id: proposal.id,
        },
        options,
      );
      setResult({ kind: "supervisor" });
      return;
    }
    const sent = await apiPost(
      "/driver/messages",
      {
        truck_code: truck,
        text,
        kind: proposal.action === "send_instruction" ? "instruction" : "message",
        instruction_kind: proposal.action === "send_instruction" ? proposal.kind || "general" : null,
        source: "assistant",
        proposal_id: proposal.id,
      },
      options,
    );
    setResult({ kind: "driver", channels: sent?.channels || [], dispatchId: sent?.dispatch?.id || null });
  }

  const kindKey = proposal.action === "send_instruction" ? proposal.kind || "general" : proposal.action;
  return (
    <SendPreview
      testId="proposal-card"
      kicker={t(`ea_kind_${kindKey}`)}
      title={supervisor ? t("ea_ask_supervisor") : fill(t("ea_ask_driver"), { truck })}
      note={t("ea_draft_note")}
      messages={[
        {
          key: proposal.id,
          to: supervisor ? t("ea_to_supervisor") : fill(t("ea_to_driver"), { truck }),
          channels: proposal.channels || (supervisor ? ["console_inbox"] : ["in_app"]),
          // The driver's message language (Settings → WhatsApp); labelled when it is not the console's.
          lang: proposal.lang,
          text: proposal.text,
        },
      ]}
      onSend={send}
      onDismiss={() => setResult({ kind: "dismissed" })}
    />
  );
}
