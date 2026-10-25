import { useState } from "react";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  LockKeyhole,
  Radio,
  Route,
  Truck,
  UserRound,
} from "lucide-react";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";

// `initialUsername` / `notice` let a surface gate (RoleGate) pre-fill the role
// it needs and say why sign-in is required. `fieldSession` stores the token
// under the field surfaces' own keys and never marks the command center as
// signed in (gsc M1); the gate then receives the principal to check its role.
// `variant="driver"` is the driver app's own sign-in (L1, L6): titled for
// drivers, a driver placeholder, and no command-centre marketing panel.
export function LoginPage({
  onLogin,
  initialUsername = "",
  notice = "",
  fieldSession = false,
  variant = "command",
}) {
  const { lang, setLang, t } = useLanguage();
  const driver = variant === "driver";
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
      if (fieldSession) {
        localStorage.setItem(FIELD_TOKEN_KEY, principal.token);
        localStorage.setItem(FIELD_ROLE_KEY, principal.role);
      } else {
        localStorage.setItem("pythia_auth", "true");
        localStorage.setItem("pythia_role", principal.role);
        localStorage.setItem("pythia_token", principal.token);
      }
      onLogin(principal);
    } catch {
      setError(t("login_error_unreachable"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className={`login-surface${driver ? " is-driver" : ""}`} aria-labelledby="login-title">
        {!driver && (
          <aside className="login-story">
            <div className="login-story-brand">
              <span>P</span>
              <div>
                <strong>Pythia</strong>
              </div>
            </div>
            <div className="login-story-copy">
              <span className="login-story-kicker">
                <Radio size={14} /> {t("login_story_kicker")}
              </span>
              <h1>
                {t("login_story_headline_1")}
                <br />
                {t("login_story_headline_2")}
              </h1>
              <p>{t("login_story_copy")}</p>
            </div>
            <div className="login-proof-list" data-testid="login-proof-list">
              <div>
                <CheckCircle2 size={17} />
                <span>
                  <strong>{t("hon_login_proof1_title")}</strong>
                  <small>{t("hon_login_proof1_sub")}</small>
                </span>
              </div>
              <div>
                <CheckCircle2 size={17} />
                <span>
                  <strong>{t("hon_login_proof2_title")}</strong>
                  <small>{t("hon_login_proof2_sub")}</small>
                </span>
              </div>
              <div>
                <CheckCircle2 size={17} />
                <span>
                  <strong>{t("login_proof3_title")}</strong>
                  <small>{t("login_proof3_sub")}</small>
                </span>
              </div>
            </div>
            <div className="login-story-footer">
              <Building2 size={16} /> {t("hon_login_footer")}
            </div>
          </aside>
        )}

        <div className="login-card">
          <div className="login-language">
            <button type="button" className={lang === "id" ? "active" : ""} onClick={() => setLang("id")}>
              ID
            </button>
            <button type="button" className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
              EN
            </button>
          </div>
          <div className="login-mobile-brand">
            <span>{driver ? <Truck size={20} /> : <Route size={20} />}</span>
            <strong>Pythia</strong>
          </div>
          <header>
            <span className="login-eyebrow">{t(driver ? "drv10_login_eyebrow" : "login_eyebrow")}</span>
            <h2 id="login-title">{t(driver ? "drv10_login_title" : "login_card_title")}</h2>
            <p>{t(driver ? "drv10_login_sub" : "login_card_sub")}</p>
            {notice && (
              <p className="login-notice" data-testid="login-notice">
                {notice}
              </p>
            )}
          </header>
          <form className="login-form" onSubmit={submit}>
            <label>
              <span>{t("login_username")}</span>
              <div className="login-input">
                <UserRound size={18} />
                <input
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t(driver ? "drv10_login_username_placeholder" : "login_username_placeholder")}
                  required
                />
              </div>
            </label>
            <label>
              <span>{t("login_password")}</span>
              <div className="login-input">
                <LockKeyhole size={18} />
                <input
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
                  aria-label={showPassword ? t("login_hide_password") : t("login_show_password")}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            {error && (
              <p className="login-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button login-submit" type="submit" disabled={submitting}>
              {submitting ? t("login_submitting") : t("login_submit")}
              <ArrowRight size={18} />
            </button>
          </form>
          <p className="login-help">{t("login_help")}</p>
        </div>
      </section>
    </main>
  );
}
