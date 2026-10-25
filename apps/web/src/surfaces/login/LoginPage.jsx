import { useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, Radio, Truck, UserRound } from "lucide-react";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import "./login.css";

// The Pythia mark (same drawing as the command-centre top bar).
function BrandMark({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-3.1-6.33" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}

// A drawn route network behind the story: a street grid, two quiet routes and
// one planned route that draws itself in. Decoration only; no data.
function RouteArt() {
  return (
    <svg className="login-story-art" viewBox="0 0 600 600" aria-hidden="true" focusable="false">
      <path
        className="grid"
        d="M0 100H600M0 220H600M0 340H600M0 460H600M100 0V600M220 0V600M340 0V600M460 0V600"
      />
      <path className="street" d="M0 280H160Q180 280 180 260V80Q180 60 200 60H420" />
      <path className="street" d="M120 600V480Q120 460 140 460H400Q420 460 420 440V260Q420 240 440 240H600" />
      <path
        className="planned"
        pathLength="1"
        d="M40 560V400Q40 380 60 380H260Q280 380 280 360V180Q280 160 300 160H540"
      />
      <circle className="depot-ring" cx="540" cy="160" r="24" />
      <circle className="depot" cx="540" cy="160" r="9" />
      <circle className="stop done" cx="40" cy="400" r="7" />
      <circle className="stop done" cx="280" cy="380" r="7" />
      <circle className="stop" cx="280" cy="220" r="7" />
      <circle className="stop" cx="420" cy="460" r="6" />
      <circle className="stop" cx="180" cy="120" r="6" />
    </svg>
  );
}

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
            <RouteArt />
            <div className="login-story-brand">
              <span>
                <BrandMark />
              </span>
              <strong>Pythia</strong>
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
            <span>{driver ? <Truck size={20} /> : <BrandMark size={20} />}</span>
            <strong>Pythia</strong>
          </div>
          <header>
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
            <button className="login-submit" type="submit" disabled={submitting}>
              {submitting ? t("login_submitting") : t("login_submit")}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>
          <p className="login-help">{t("login_help")}</p>
        </div>
      </section>
    </main>
  );
}
