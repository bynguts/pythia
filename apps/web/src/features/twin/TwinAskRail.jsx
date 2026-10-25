import { useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Mic, MicOff, PanelLeftClose, Send, Sparkles } from "lucide-react";
import { apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { providerLabel, ScenarioCard } from "../assistant/ScenarioCard.jsx";
import { useSpeechInput } from "../assistant/useSpeechInput.js";
import "../assistant/assistant.css";

/**
 * Ask Pythia inside the twin (gsc #5): a what-if question goes to Ana, and the
 * scenario her read-only `run_scenario` tool ran is applied to this twin in
 * place (`onApply`), with the tool trace, sources and provider on the card.
 * `appliedText` is the twin's own scenario line, so the rail never claims a
 * scenario the twin is not showing; `queueText` is the twin's queue headline
 * (with its sensitivity band and class) for that same scenario.
 * Any other question shows Ana's own text answer (gsc #8: no dead ends), badged
 * with who produced it: the local parser, a fallback after an LLM error, or the
 * LLM provider and model the backend says answered.
 */
function answerHtml(text) {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "form", "input"],
  });
}

export function TwinAskRail({ onApply, appliedText, queueText, collapsible = false, onCollapse }) {
  const { t, lang } = useLanguage();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("idle");
  const inputRef = useRef(null);
  const voice = useSpeechInput(lang, (transcript) => {
    setQuestion(transcript);
    ask(transcript);
  });

  async function ask(text = question) {
    const prompt = text.trim();
    if (status === "loading") return;
    // The Ask pill stays solid: with nothing typed it hands focus to the question box.
    if (!prompt) {
      inputRef.current?.focus();
      return;
    }
    setAsked(prompt);
    setQuestion("");
    setStatus("loading");
    try {
      const data = await apiPost("/assistant/query", { question: prompt, language: lang, history: [] });
      const scenario = data.scenario?.links ? data.scenario : null;
      setResult({
        scenario,
        answer: String(data.answer || "").trim(),
        provider: data.provider,
        model: data.model,
        source: { mode: data.mode, providerName: data.provider_name, fallbackReason: data.fallback_reason },
      });
      setStatus(scenario ? "applied" : "answered");
      if (scenario) onApply(scenario);
    } catch {
      setResult(null);
      setStatus("error");
    }
  }

  // After a question the example would read as an echo of it, so it changes.
  const placeholder = voice.listening
    ? t("asst_voice_listening")
    : t(asked ? "twin_ask_placeholder_next" : "twin_ask_placeholder");

  return (
    <aside className="twin-ask" data-testid="twin-ask" aria-labelledby="twin-ask-title">
      <div className="twin-ask-head">
        <h2 id="twin-ask-title" className="twin-panel-title">
          <Sparkles size={14} aria-hidden="true" /> {t("twin_ask_title")}
        </h2>
        {collapsible && (
          <button
            type="button"
            className="twin-ask-icon"
            aria-label={t("twin_ask_hide")}
            title={t("twin_ask_hide")}
            onClick={onCollapse}
          >
            <PanelLeftClose size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <form
        className="twin-ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <label className="sr-only" htmlFor="twin-ask-input">
          {t("twin_ask_label")}
        </label>
        <textarea
          ref={inputRef}
          id="twin-ask-input"
          data-testid="twin-ask-input"
          rows={2}
          value={question}
          placeholder={placeholder}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              ask();
            }
          }}
        />
        <div className="twin-ask-actions">
          {voice.supported && (
            <button
              type="button"
              className="twin-ask-icon"
              data-testid="twin-ask-voice"
              aria-pressed={voice.listening}
              aria-label={voice.listening ? t("asst_voice_stop") : t("asst_voice_start")}
              title={voice.listening ? t("asst_voice_stop") : t("asst_voice_start")}
              onClick={voice.toggle}
            >
              {voice.listening ? (
                <MicOff size={18} aria-hidden="true" />
              ) : (
                <Mic size={18} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="submit"
            className="twin-btn primary twin-ask-send"
            data-testid="twin-ask-send"
            aria-busy={status === "loading"}
            disabled={status === "loading"}
          >
            <Send size={16} aria-hidden="true" /> {t("twin_ask_send")}
          </button>
        </div>
      </form>

      {!asked && <p className="twin-note">{t("twin_ask_hint")}</p>}
      {asked && (
        <p className="twin-ask-question" data-testid="twin-ask-question">
          {asked}
        </p>
      )}
      <div
        className="twin-ask-result"
        data-testid="twin-ask-result"
        role="region"
        aria-label={t("ask_result_label")}
        aria-live="polite"
        // Long answers scroll here, so an answered region takes keyboard focus for scrolling.
        tabIndex={status === "answered" || status === "applied" ? 0 : undefined}
      >
        {status === "loading" && (
          <div className="assistant-thinking twin-ask-thinking" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
        {status === "applied" && (
          <div className="twin-ask-applied-block">
            <p className="twin-ask-applied" role="status" data-testid="twin-ask-applied">
              {t("twin_ask_applied").replace("{scenario}", appliedText)}
            </p>
            {queueText && (
              <p className="twin-ask-queue" data-testid="twin-ask-queue">
                {queueText}
              </p>
            )}
          </div>
        )}
        {status === "answered" && (
          <div className="twin-ask-answer" data-testid="twin-ask-answer">
            <span className="assistant-scenario-badge" data-testid="twin-ask-provider">
              {providerLabel(result.provider, result.model, t, result.source)}
            </span>
            <div
              className="assistant-formatted-answer"
              dangerouslySetInnerHTML={{ __html: answerHtml(result.answer || t("asst_no_answer")) }}
            />
          </div>
        )}
        {status === "error" && (
          <p className="twin-ask-error" role="alert">
            {t("twin_ask_error")}
          </p>
        )}
        {status === "applied" && result?.scenario && (
          <ScenarioCard
            scenario={result.scenario}
            provider={result.provider}
            model={result.model}
            source={result.source}
            inTwin
          />
        )}
      </div>
    </aside>
  );
}
