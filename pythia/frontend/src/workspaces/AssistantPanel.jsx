import React, { useState, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { authenticatedRequest } from "../dispatchApi.js";
import { useLanguage } from "../i18n.jsx";
import {
  Send,
  X,
  Bot,
  Paperclip,
} from "lucide-react";

// #76: every interface string rides the locale catalog, the file-only
// fallback question is localized, and the chosen language is sent on the
// wire so the answer language is requested explicitly and preserved for
// the conversation.
export function AssistantPanel() {
  const { t, lang } = useLanguage();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState(() => [{ role: "assistant", text: null }]);
  const [loading, setLoading] = useState(false);
  const [attachedFile, setAttachedFile] = useState(null);
  const fileInputRef = useRef(null);

  // Resolve the greeting lazily so it follows live locale switches.
  const greeting = messages[0]?.role === "assistant" && messages[0].text === null
    ? t("asst_greeting") : messages[0]?.text;
  const visibleMessages = [{ ...messages[0], text: greeting }, ...messages.slice(1)];

  function handleFileSelect(event) {
    const file = event.target.files[0];
    const fileType = file.type === "application/pdf" ? "pdf" : "image";
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedFile({ data: reader.result, type: fileType, name: file.name });
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  async function askAssistant(promptOverride) {
    const prompt = (promptOverride || question).trim();
    if ((!prompt && !attachedFile) || loading) return;
    const fileMeta = attachedFile ? ` [${attachedFile.name}]` : "";
    setMessages((current) => [...current, { role: "user", text: (prompt || t("asst_file_question")) + fileMeta }]);
    const currentFile = attachedFile;
    setQuestion("");
    setAttachedFile(null);
    setLoading(true);
    try {
      const body = {
        question: prompt || t("asst_file_question"),
        language: lang,
        history: messages.slice(1).filter((m) => m.provider !== "error" && m.provider !== "offline").slice(-8).map((m) => ({ role: m.role, content: m.text })),
      };
      if (currentFile) {
        body.file_data = currentFile.data;
        body.file_type = currentFile.type;
      }
      const response = await authenticatedRequest("/assistant/query", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: `${t("asst_error_prefix")} ${data.detail || t("asst_error_detail")} ${t("asst_error_suffix")}`,
            provider: "error",
          },
        ]);
        return;
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: data.answer || t("asst_no_answer"),
          provider: data.provider || "unknown",
          model: data.model || "",
          toolsUsed: data.tools_used || [],
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: t("asst_offline"),
          provider: "offline",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function humanizeAssistantAnswer(text) {
    if (!text) return text;
    const humanPhrases = {
      is_damaged: lang === "id" ? "kerusakan truk terkonfirmasi" : "truck damage confirmed",
      off_corridor: lang === "id" ? "di luar koridor yang ditugaskan" : "off the assigned corridor",
      far_off_corridor: lang === "id" ? "jauh dari koridor yang ditugaskan" : "far off the assigned corridor",
    };
    return text
      .replace(/flags\s*:\s*([^\n]+)/gi, (match, list) => {
        const cleaned = list
          .split(",")
          .map((item) => item.trim().replace(/^`|`$/g, "").trim())
          .filter(Boolean)
          .map((key) => humanPhrases[key] || key)
          .join(", ");
        return `${t("asst_risks")}: ${cleaned}`;
      })
      .replace(/`?([a-z_]+)\s*:\s*(?:true|false|yes|no)`?/gi, (match, key) => humanPhrases[key] || match);
  }

  function renderAssistantText(text) {
    if (!text) return null;
    const rawHtml = marked.parse(humanizeAssistantAnswer(text), { gfm: true, breaks: true });
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "script", "iframe", "form", "input"],
    });
  }

  return (
    <section className="assistant-panel assistant-chat-shell">
      <header className="assistant-chat-header">
        <span className="assistant-chat-mark" aria-hidden="true">
          <Bot size={16} />
        </span>
        <div>
          <h2>Ana</h2>
          <p>{t("asst_header_sub")}</p>
        </div>
      </header>

      <div className="assistant-message-list" role="log" aria-live="polite">
        {visibleMessages.map((message, index) => (
          <article className={`assistant-message ${message.role}`} key={`${message.role}-${index}`}>
            <span className="assistant-message-avatar" aria-hidden="true">
              {message.role === "assistant" ? t("asst_avatar_ai") : t("asst_avatar_user")}
            </span>
            <div className="assistant-bubble">
              <div className="assistant-formatted-answer" dangerouslySetInnerHTML={{ __html: renderAssistantText(message.text) }} />
            </div>
          </article>
        ))}
        {loading && (
          <article className="assistant-message assistant">
            <span className="assistant-message-avatar" aria-hidden="true">{t("asst_avatar_ai")}</span>
            <div className="assistant-bubble assistant-thinking">
              <span />
              <span />
              <span />
            </div>
          </article>
        )}
      </div>

      <div className="assistant-quick-prompts" aria-label={t("asst_prompts_label")}>
        <button type="button" disabled={loading} onClick={() => askAssistant(t("asst_prompt1_q"))}>
          {t("asst_prompt1")}
        </button>
        <button type="button" disabled={loading} onClick={() => askAssistant(t("asst_prompt2_q"))}>
          {t("asst_prompt2")}
        </button>
      </div>

      <form
        className="assistant-chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          askAssistant();
        }}
      >
        {attachedFile && (
          <div className="assistant-file-chip">
            <Paperclip size={14} />
            <span>{attachedFile.name}</span>
            <button type="button" aria-label={t("asst_remove_file")} onClick={() => setAttachedFile(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          onChange={handleFileSelect}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="assistant-upload-button"
          title={t("asst_upload_label")}
          onClick={() => fileInputRef.current?.click()}
          aria-label={t("asst_upload_label")}
        >
          <Paperclip size={18} />
        </button>
        <label className="sr-only" htmlFor="assistant-question">{t("asst_input_label")}</label>
        <input
          id="assistant-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={attachedFile ? t("asst_placeholder_file") : t("asst_placeholder")}
          autoComplete="off"
        />
        <button className="primary-button" type="submit" aria-label={t("asst_send")} disabled={loading || (!question.trim() && !attachedFile)}>
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}
