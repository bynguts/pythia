import { useState } from "react";
import { ArrowRight, LockKeyhole, UserRound } from "lucide-react";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Mascot } from "../../shared/ui/Mascot.jsx";
import "./driver.css";

// Set when the driver signs in without "Stay signed in on this phone": the
// field token then ends with the browser session (DriverApp checks it).
export const FIELD_EPHEMERAL_KEY = "pythia_field_ephemeral";
export const FIELD_SESSION_MARK = "pythia_field_session_live";

// F2CI6P: the driver app's own sign-in. Same contract as the console login's
// field session: the token goes under the field keys, never the command
// centre's, and `onLogin(principal)` lets the gate check the role.
export function DriverLogin({ onLogin, initialUsername = "", notice = "" }) {
  const { lang, setLang, t } = useLanguage();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [stay, setStay] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        body: { username, password },
        auth: false,
      });
      // Only a 401 means the credentials are wrong; anything else says the
      // server was not reached, so a weak signal is not reported as a bad password.
      if (res.status === 401) {
        setError(t("login_error"));
        return;
      }
      if (!res.ok) throw new Error(`login HTTP ${res.status}`);
      const principal = await res.json();
      localStorage.setItem(FIELD_TOKEN_KEY, principal.token);
      localStorage.setItem(FIELD_ROLE_KEY, principal.role);
      try {
        if (stay) localStorage.removeItem(FIELD_EPHEMERAL_KEY);
        else localStorage.setItem(FIELD_EPHEMERAL_KEY, "1");
        sessionStorage.setItem(FIELD_SESSION_MARK, "1");
      } catch {
        // Without storage the session simply stays.
      }
      onLogin(principal);
    } catch {
      setError(t("login_error_unreachable"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="drv-login" data-testid="driver-login">
      <form className="drv-login-form" onSubmit={submit} aria-labelledby="login-title">
        <div className="drv-login-brand">
          <Mascot size={72} />
          <h1 id="login-title" className="drv-login-title">
            {t("d1_login_title")}
          </h1>
          <p className="drv-login-sub">{t("d1_login_sub")}</p>
          {notice && (
            <p className="drv-small" data-testid="login-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="drv-field">
          <label className="drv-label" htmlFor="drv-login-user">
            {t("d1_username")}
          </label>
          <div className="drv-input-wrap">
            <UserRound size={18} aria-hidden="true" />
            <input
              id="drv-login-user"
              className="drv-input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="drv-field">
          <label className="drv-label" htmlFor="drv-login-password">
            {t("d1_password")}
          </label>
          <div className="drv-input-wrap">
            <LockKeyhole size={18} aria-hidden="true" />
            <input
              id="drv-login-password"
              className="drv-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>
        <label className="drv-switch">
          <span>{t("d1_stay_signed_in")}</span>
          <input
            type="checkbox"
            role="switch"
            data-testid="driver-login-stay"
            checked={stay}
            onChange={(e) => setStay(e.target.checked)}
          />
          <span className="drv-switch-track" aria-hidden="true" />
        </label>
        {error && (
          <p className="drv-error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        <button type="submit" className="drv-btn primary" disabled={submitting}>
          <ArrowRight size={18} aria-hidden="true" />
          {submitting ? t("d1_signing_in") : t("d1_sign_in")}
        </button>
      </form>
      <nav className="drv-login-lang" aria-label={t("d1_language")}>
        <button
          type="button"
          lang="id"
          aria-pressed={lang === "id"}
          className={lang === "id" ? "is-on" : ""}
          onClick={() => setLang("id")}
        >
          Bahasa Indonesia
        </button>
        <button
          type="button"
          lang="en"
          aria-pressed={lang === "en"}
          className={lang === "en" ? "is-on" : ""}
          onClick={() => setLang("en")}
        >
          English
        </button>
      </nav>
    </main>
  );
}
