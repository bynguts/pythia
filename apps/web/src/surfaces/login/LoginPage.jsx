import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  CircleCheck,
  Eye,
  EyeOff,
  LockKeyhole,
  Route,
  Smartphone,
  UserRound,
} from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Logo } from "../../shared/ui/Logo.jsx";
import { Mascot } from "../../shared/ui/Mascot.jsx";
import { PixelBand } from "../../shared/ui/PixelBand.jsx";
import "./signin.css";

// The command-centre sign-in (Q3EJb). `initialUsername` / `notice` let a gate pre-fill the
// role it needs and say why sign-in is required. The driver app has its own sign-in
// (surfaces/driver/DriverLogin.jsx), reached through RoleGate.
export function LoginPage({ onLogin, initialUsername = "", notice = "" }) {
  const { t } = useLanguage();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      // Only a 401 means the credentials are wrong. A proxy 502/504 or any other
      // failure says the server was not reached, so a phone on a weak signal is
      // not told its password is wrong.
      if (res.status === 401) {
        setError(t("login_error"));
        return;
      }
      if (!res.ok) throw new Error(`login HTTP ${res.status}`);
      const principal = await res.json();
      localStorage.setItem("pythia_auth", "true");
      localStorage.setItem("pythia_role", principal.role);
      localStorage.setItem("pythia_token", principal.token);
      onLogin(principal);
    } catch {
      setError(t("login_error_unreachable"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CommandSignIn
      form={{
        username,
        setUsername,
        password,
        setPassword,
        showPassword,
        setShowPassword,
        error,
        submitting,
        submit,
      }}
      notice={notice}
    />
  );
}

// The designed sign-in (Q3EJb): form on the left, statement and pixel band on the right.
function CommandSignIn({ form, notice }) {
  const { lang, setLang, t } = useLanguage();
  const { username, setUsername, password, setPassword, showPassword, setShowPassword } = form;
  const [forgot, setForgot] = useState(false);
  const facts = [
    [BarChart3, "l_si_fact1"],
    [Route, "l_si_fact2"],
    [CircleCheck, "l_si_fact3"],
  ];
  return (
    <main className="si-shell">
      <section className="si-form-side" aria-labelledby="si-title">
        <Link className="si-logo" to="/" aria-label="Pythia">
          <Logo />
        </Link>
        <div className="si-form">
          <header>
            <h1 id="si-title">{t("l_si_title")}</h1>
            <p>{t("l_si_sub")}</p>
            {notice && (
              <p className="si-notice" data-testid="login-notice">
                {notice}
              </p>
            )}
          </header>
          <form onSubmit={form.submit} noValidate={false}>
            <div className="si-field">
              <label htmlFor="si-username">{t("login_username")}</label>
              <div className="si-input">
                <UserRound size={16} aria-hidden="true" />
                <input
                  id="si-username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t("login_username_placeholder")}
                  required
                />
              </div>
            </div>
            <div className="si-field">
              <div className="si-field-row">
                <label htmlFor="si-password">{t("login_password")}</label>
                <button
                  type="button"
                  className="si-link"
                  aria-expanded={forgot}
                  onClick={() => setForgot((v) => !v)}
                >
                  {t("l_si_forgot")}
                </button>
              </div>
              <div className="si-input">
                <LockKeyhole size={16} aria-hidden="true" />
                <input
                  id="si-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("login_password_placeholder")}
                  required
                />
                <button
                  type="button"
                  className="si-eye"
                  aria-label={showPassword ? t("login_hide_password") : t("login_show_password")}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {forgot && <p className="si-help">{t("l_si_forgot_help")}</p>}
            </div>
            {form.error && (
              <p className="si-error" role="alert">
                {form.error}
              </p>
            )}
            <button className="si-submit" type="submit" disabled={form.submitting}>
              <ArrowRight size={16} aria-hidden="true" />
              {form.submitting ? t("login_submitting") : t("login_submit")}
            </button>
          </form>
          <div className="si-or">
            <span />
            <p>{t("l_si_or")}</p>
            <span />
          </div>
          <Link className="si-driver" to="/driver">
            <Smartphone size={16} aria-hidden="true" />
            {t("l_si_driver")}
          </Link>
        </div>
        <nav className="si-foot" aria-label={t("l_si_foot_label")}>
          <a href="/#honesty">{t("l_foot_sources")}</a>
          <a href="/#faq">{t("l_foot_privacy")}</a>
          <button
            type="button"
            onClick={() => setLang(lang === "en" ? "id" : "en")}
            data-testid="login-lang-switch"
          >
            {t(lang === "en" ? "l_lang_to_id" : "l_lang_to_en")}
          </button>
        </nav>
      </section>
      <aside className="si-art">
        <div className="si-statement">
          <p>{t("l_si_statement")}</p>
          <ul data-testid="login-proof-list">
            {facts.map(([Icon, key]) => (
              <li key={key}>
                <Icon size={16} aria-hidden="true" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>
        <PixelBand className="si-band" />
        <Mascot className="si-mascot" size={128} tone="green" />
      </aside>
    </main>
  );
}
