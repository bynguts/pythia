import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { ArrowUp, Check, Copy, Lock, Mic, MicOff, Paperclip, Sparkles, X } from "lucide-react";
import { ScenarioCard, providerLabel } from "./ScenarioCard.jsx";
import { useSpeechInput } from "./useSpeechInput.js";
import "./assistant.css";

const PROMPTS = ["asst_prompt1_q", "asst_prompt2_q", "asst_prompt3_q"];

// #76: every interface string rides the locale catalog, the file-only
// fallback question is localized, and the chosen language is sent on the
// wire so the answer language is requested explicitly and preserved for
// the conversation.
// wave13 (fgZyf): rendered inside the console's Ask Ana drawer, which owns the header.
// An answer names the tools it ran and who produced it; nothing here invents options.
export function AssistantPanel() {
  const { t, lang } = useLanguage();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState(() => [{ role: "assistant", text: null }]);
  const [loading, setLoading] = useState(false);
  const [attachedFile, setAttachedFile] = useState(null);
  const [copied, setCopied] = useState(null);
  const logRef = useRef(null);
  const fileInputRef = useRef(null);
  const questionRef = useRef(null);
  const {
    supported: voiceSupported,
    listening,
    toggle: toggleVoice,
  } = useSpeechInput(lang, (transcript) => {
    setQuestion(transcript);
    questionRef.current?.focus();
  });

  // Resolve the greeting lazily so it follows live locale switches.
  const greeting =
    messages[0]?.role === "assistant" && messages[0].text === null ? t("asst_greeting") : messages[0]?.text;
  const visibleMessages = [{ ...messages[0], text: greeting }, ...messages.slice(1)];

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, loading]);

  function toolLabel(id) {
    const label = t(`s5_ana_tool_${id}`);
    return label === `s5_ana_tool_${id}` ? id.replace(/^get_/, "").replaceAll("_", " ") : label;
  }

  async function copyAnswer(index, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied((current) => (current === index ? null : current)), 2000);
    } catch {
      setCopied(null);
    }
  }

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
    setMessages((current) => [
      ...current,
      { role: "user", text: (prompt || t("asst_file_question")) + fileMeta },
    ]);
    const currentFile = attachedFile;
    setQuestion("");
    setAttachedFile(null);
    setLoading(true);
    try {
      const body = {
        question: prompt || t("asst_file_question"),
        language: lang,
        history: messages
          .slice(1)
          .filter((m) => m.provider !== "error" && m.provider !== "offline")
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.text })),
      };
      if (currentFile) {
        body.file_data = currentFile.data;
        body.file_type = currentFile.type;
      }
      const response = await apiFetch("/assistant/query", {
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
          source: { mode: data.mode, providerName: data.provider_name, fallbackReason: data.fallback_reason },
          toolsUsed: data.tools_used || [],
          scenario: data.scenario?.links ? data.scenario : null,
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
    <section className="assistant-panel assistant-chat-shell ana" data-testid="assistant-panel">
      <div className="ana-log" ref={logRef} role="log" aria-live="polite">
        {visibleMessages.map((message, index) => {
          const isUser = message.role === "user";
          const answered =
            !isUser && index > 0 && message.provider !== "error" && message.provider !== "offline";
          const source = answered
            ? providerLabel(message.provider, message.model, t, {
                mode: message.source?.mode,
                providerName: message.source?.providerName,
                fallbackReason: message.source?.fallbackReason,
              })
            : null;
          return (
            <article
              className={`ana-msg ${isUser ? "is-user" : "is-ana"}${message.provider === "error" ? " is-error" : ""}`}
              data-testid="assistant-message"
              data-role={message.role}
              key={`${message.role}-${index}`}
            >
              {isUser ? (
                <div className="ana-bubble">{message.text}</div>
              ) : (
                <>
                  <div
                    className="ana-text assistant-formatted-answer"
                    dangerouslySetInnerHTML={{ __html: renderAssistantText(message.text) }}
                  />
                  {message.scenario && (
                    <ScenarioCard
                      scenario={message.scenario}
                      provider={message.provider}
                      model={message.model}
                      source={message.source}
                    />
                  )}
                  {answered && (
                    <div className="ana-used" data-testid="assistant-used">
                      <span className="ana-used-k">{t("s5_ana_used")}</span>
                      {message.toolsUsed?.map((id) => (
                        <span className="ana-chip" key={id}>
                          {toolLabel(id)}
                        </span>
                      ))}
                      {source && <span className="ana-chip is-source">{source}</span>}
                    </div>
                  )}
                  {answered && (
                    <div className="ana-actions">
                      <Button
                        size="sm"
                        icon={copied === index ? Check : Copy}
                        onClick={() => copyAnswer(index, message.text)}
                      >
                        {copied === index ? t("s5_ana_copied") : t("s5_ana_copy")}
                      </Button>
                    </div>
                  )}
                  {message.scenario && (
                    <p className="ana-note">
                      <Lock size={12} aria-hidden="true" />
                      {t("s5_ana_note")}
                    </p>
                  )}
                </>
              )}
            </article>
          );
        })}
        {loading && (
          <article className="ana-msg is-ana" aria-label={t("s5_ana_thinking")}>
            <div className="ana-thinking" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </article>
        )}
      </div>

      <div className="ana-try" role="group" aria-label={t("asst_prompts_label")}>
        <span className="ana-try-k">{t("s5_ana_try")}</span>
        {PROMPTS.map((key) => (
          <button
            type="button"
            key={key}
            className="ana-prompt"
            data-testid={key === "asst_prompt3_q" ? "assistant-prompt-scenario" : "assistant-prompt"}
            disabled={loading}
            onClick={() => askAssistant(t(key))}
          >
            <Sparkles size={14} aria-hidden="true" />
            {t(key)}
          </button>
        ))}
      </div>

      <form
        className="ana-composer"
        onSubmit={(event) => {
          event.preventDefault();
          askAssistant();
        }}
      >
        {attachedFile && (
          <div className="ana-file">
            <Paperclip size={14} aria-hidden="true" />
            <span>{attachedFile.name}</span>
            <button type="button" aria-label={t("asst_remove_file")} onClick={() => setAttachedFile(null)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="ana-box">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <label className="sr-only" htmlFor="assistant-question">
            {t("asst_input_label")}
          </label>
          <input
            ref={questionRef}
            id="assistant-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={
              listening
                ? t("asst_voice_listening")
                : attachedFile
                  ? t("asst_placeholder_file")
                  : t("asst_placeholder")
            }
            autoComplete="off"
          />
          <button
            type="button"
            className="ana-icon assistant-upload-button"
            title={t("asst_upload_label")}
            aria-label={t("asst_upload_label")}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={16} aria-hidden="true" />
          </button>
          {voiceSupported && (
            <button
              type="button"
              className="ana-icon"
              data-testid="assistant-voice"
              aria-pressed={listening}
              aria-label={listening ? t("asst_voice_stop") : t("asst_voice_start")}
              title={listening ? t("asst_voice_stop") : t("asst_voice_start")}
              onClick={toggleVoice}
            >
              {listening ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            </button>
          )}
          <button
            className="ana-send"
            type="submit"
            data-testid="assistant-send"
            aria-label={t("asst_send")}
            disabled={loading || (!question.trim() && !attachedFile)}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </section>
  );
}
