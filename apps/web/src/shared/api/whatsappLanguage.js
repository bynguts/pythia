import { useEffect, useState } from "react";
import { apiGet } from "./client.js";

// The language every WhatsApp message is written in (Settings → WhatsApp, default Indonesian).
// Senders compose their text in it, so a message is one language whatever the console shows.
const TTL_MS = 30000;
let cached = null;
let cachedAt = 0;

export function whatsappLanguage() {
  if (!cached || Date.now() - cachedAt > TTL_MS) {
    cachedAt = Date.now();
    cached = apiGet("/whatsapp/language").then(
      (body) => (body?.lang === "en" ? "en" : "id"),
      () => {
        cached = null;
        return "id";
      },
    );
  }
  return cached;
}

export function rememberWhatsappLanguage(lang) {
  cached = Promise.resolve(lang);
  cachedAt = Date.now();
}

export function useWhatsappLanguage() {
  const [lang, setLang] = useState("id");
  useEffect(() => {
    let live = true;
    whatsappLanguage().then((next) => live && setLang(next));
    return () => {
      live = false;
    };
  }, []);
  return lang;
}
