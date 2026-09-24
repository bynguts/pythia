import React, { useState } from "react";
import { ArrowRight, Building2, CheckCircle2, Eye, EyeOff, LockKeyhole, Radio, Route, UserRound } from "lucide-react";
import { API_URL } from "../config.js";
import { useLanguage } from "../i18n.jsx";

export function LoginPage({ onLogin }) {
  const { lang, setLang, t } = useLanguage();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error("bad creds");
      const principal = await res.json();
      localStorage.setItem("jwis_auth", "true");
      localStorage.setItem("jwis_role", principal.role);
      localStorage.setItem("jwis_token", principal.token);
      onLogin();
    } catch {
      setError(t("login_error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-surface" aria-labelledby="login-title">
        <aside className="login-story">
          <div className="login-story-brand"><span>J</span><div><strong>JWIS</strong><small>Jakarta Waste Intelligence System</small></div></div>
          <div className="login-story-copy">
            <span className="login-story-kicker"><Radio size={14} /> {t("login_story_kicker")}</span>
            <h1>{t("login_story_headline_1")}<br />{t("login_story_headline_2")}</h1>
            <p>{t("login_story_copy")}</p>
          </div>
          <div className="login-proof-list">
            <div><CheckCircle2 size={17} /><span><strong>{t("login_proof1_title")}</strong><small>{t("login_proof1_sub")}</small></span></div>
            <div><CheckCircle2 size={17} /><span><strong>{t("login_proof2_title")}</strong><small>{t("login_proof2_sub")}</small></span></div>
            <div><CheckCircle2 size={17} /><span><strong>{t("login_proof3_title")}</strong><small>{t("login_proof3_sub")}</small></span></div>
          </div>
          <div className="login-story-footer"><Building2 size={16} /> {t("login_story_footer")}</div>
        </aside>

        <div className="login-card">
          <div className="login-language">
            <button type="button" className={lang === "id" ? "active" : ""} onClick={() => setLang("id")}>ID</button>
            <button type="button" className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>EN</button>
          </div>
          <div className="login-mobile-brand"><span><Route size={20} /></span><strong>JWIS</strong></div>
          <header>
            <span className="login-eyebrow">{t("login_eyebrow")}</span>
            <h2 id="login-title">{t("login_card_title")}</h2>
            <p>{t("login_card_sub")}</p>
          </header>
          <form className="login-form" onSubmit={submit}>
            <label>
              <span>{t("login_username")}</span>
              <div className="login-input"><UserRound size={18} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("login_username_placeholder")} required /></div>
            </label>
            <label>
              <span>{t("login_password")}</span>
              <div className="login-input"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("login_password_placeholder")} required /><button type="button" aria-label={showPassword ? t("login_hide_password") : t("login_show_password")} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
            </label>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="primary-button login-submit" type="submit" disabled={submitting}>{submitting ? t("login_submitting") : t("login_submit")}<ArrowRight size={18} /></button>
          </form>
          <p className="login-help">{t("login_help")}</p>
        </div>
      </section>
    </main>
  );
}
