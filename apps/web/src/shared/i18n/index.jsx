import { createContext, useContext, useState } from "react";
import { en } from "./locales/en.js";
import { id } from "./locales/id.js";

const translations = { en, id };

// gsc n30: the one BCP-47 locale per UI language for numbers, dates and speech.
export function localeFor(lang) {
  return lang === "en" ? "en-GB" : "id-ID";
}

// Catalog lookup for one locale, falling back to English and then to the key.
export function translate(lang, key) {
  return translations[lang]?.[key] || translations.en?.[key] || key;
}

const LanguageContext = createContext({
  lang: "id",
  setLang: () => {},
  t: (key) => key,
});

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => (document.documentElement.lang === "en" ? "en" : "id"));

  function setLang(newLang) {
    if (newLang !== "id" && newLang !== "en") return;
    document.documentElement.lang = newLang;
    setLangState(newLang);
    try {
      localStorage.setItem("pythia_lang", newLang);
    } catch {
      // The selected language still applies when browser storage is unavailable.
    }
    // #84: locale-aware surfaces outside React (the SW update banner) re-render.
    window.dispatchEvent(new Event("pythia-lang-change"));
  }

  function t(key) {
    return translate(lang, key);
  }

  return <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
