import { useEffect, useRef, useState } from "react";
import { localeFor } from "../../shared/i18n/index.jsx";

// gsc-2026 P1-9: voice input through the browser's own Web Speech API — no
// Pythia or third-party service; callers hide the mic where the API is missing.
function speechRecognitionApi() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** One-shot dictation in the UI language; `onTranscript` gets the final text. */
export function useSpeechInput(lang, onTranscript) {
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);
  const SpeechRecognition = speechRecognitionApi();

  useEffect(() => () => recognitionRef.current?.abort(), []);

  function toggle() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = localeFor(lang);
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join(" ")
        .trim();
      if (transcript) onTranscript(transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  return { supported: Boolean(SpeechRecognition), listening, toggle };
}
