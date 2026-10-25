import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleUserRound, LogOut, Sparkles } from "lucide-react";
import { useLanguage } from "../shared/i18n/index.jsx";
import { WORKSPACES as items } from "./workspaces.js";

export function AppShell({
  activeWorkspace,
  onWorkspaceChange,
  online,
  onLogout,
  assistant,
  children,
  contextKey = "shell_context_eyebrow",
}) {
  const { lang, setLang, t } = useLanguage();
  const current = items.find((item) => item.id === activeWorkspace) || items[0];
  // H12: the profile names the signed-in role. Accounts are shared per role in
  // this prototype (the username is the role), so that is the display name too.
  let signedInRole = null;
  try {
    signedInRole = localStorage.getItem("pythia_role");
  } catch {
    signedInRole = null;
  }
  const roleKey = `pln6_profile_role_${signedInRole}`;
  const roleLabel = signedInRole && t(roleKey) !== roleKey ? t(roleKey) : t("pln6_profile_role_unknown");
  const accountLabel = signedInRole ? t("pln6_profile_account").replace("{u}", signedInRole) : roleLabel;
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);
  const profileTriggerRef = useRef(null);
  const assistantTriggerRef = useRef(null);
  const assistantDialogRef = useRef(null);
  const shellRef = useRef(null);

  useLayoutEffect(() => {
    if (!assistantOpen) return;

    const dialog = assistantDialogRef.current;
    const main = dialog.parentElement.parentElement;
    const background = [
      ...Array.from(shellRef.current.children).filter((element) => element !== main),
      ...Array.from(main.children).filter((element) => !element.contains(dialog)),
    ];
    const previousInert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });

    const focusable = () =>
      Array.from(
        dialog.querySelectorAll(
          'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest("[inert]") &&
          element.getClientRects().length > 0,
      );
    const initial = dialog.querySelector("#assistant-question");
    (initial && !initial.disabled ? initial : focusable()[0] || dialog).focus();

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        setAssistantOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !controls.includes(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !controls.includes(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    function onFocusIn(event) {
      if (!dialog.contains(event.target)) (focusable()[0] || dialog).focus();
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      background.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      assistantTriggerRef.current?.focus();
    };
  }, [assistantOpen]);

  // Teardown v4 S3/S4: the profile is a menu (role, language, settings, log out), so a
  // shared phone can sign out. It closes on Escape, outside clicks and any choice.
  useEffect(() => {
    if (!profileOpen) return;
    profileRef.current?.querySelector("[role=menuitemradio], [role=menuitem]")?.focus();
    function onPointerDown(event) {
      if (!profileRef.current?.contains(event.target)) setProfileOpen(false);
    }
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      setProfileOpen(false);
      profileTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [profileOpen]);

  function selectWorkspace(id) {
    setProfileOpen(false);
    onWorkspaceChange(id);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  const operational = items.filter((item) => !item.separated);
  const pinned = items.filter((item) => item.separated);
  const navButton = ({ id, key, icon: Icon }) => (
    <button
      key={id}
      type="button"
      className={`command-nav-item ${activeWorkspace === id ? "active" : ""}`}
      aria-current={activeWorkspace === id ? "page" : undefined}
      onClick={() => selectWorkspace(id)}
    >
      <Icon size={19} strokeWidth={1.8} />
      <span>{t(key)}</span>
    </button>
  );

  return (
    <div className="command-shell" ref={shellRef}>
      <aside className="command-sidebar" aria-label={t("shell_sidebar_label")}>
        <div className="command-brand">
          <span className="command-brand-mark" aria-hidden="true">
            P
          </span>
          <div>
            <strong>Pythia</strong>
            <small>{t("shell_brand_sub")}</small>
          </div>
        </div>

        <div className="command-nav-label">{t("shell_workspaces")}</div>
        <nav className="command-nav" id="workspace-navigation" data-testid="workspace-navigation">
          {operational.map(navButton)}
          {pinned.length > 0 && (
            <div className="command-nav-separator" role="separator" data-testid="nav-separator" />
          )}
          {pinned.map(navButton)}
        </nav>

        <div className="command-sidebar-footer">
          <div className="system-connection">
            <span className={`connection-dot ${online ? "online" : "offline"}`} />
            <div>
              <strong>{online ? t("shell_connected_title") : t("shell_offline_title")}</strong>
              <small>{online ? t("shell_connected_sub") : t("shell_offline_sub")}</small>
            </div>
          </div>
          <button className="command-logout" type="button" onClick={onLogout}>
            <LogOut size={18} />
            <span>{t("shell_logout")}</span>
          </button>
        </div>
      </aside>

      <main className="command-main" id="overview">
        <header className="command-topbar">
          <div className="command-context">
            <span className="command-eyebrow">{t(contextKey)}</span>
            <div className="command-title-row">
              <strong>{t(current.key)}</strong>
              <span>{t(current.descKey)}</span>
            </div>
          </div>

          <div className="command-top-actions">
            <div className="command-language" aria-label={t("shell_lang_label")}>
              <button
                type="button"
                data-testid="lang-switch-id"
                className={lang === "id" ? "active" : ""}
                onClick={() => setLang("id")}
              >
                ID
              </button>
              <button
                type="button"
                data-testid="lang-switch-en"
                className={lang === "en" ? "active" : ""}
                onClick={() => setLang("en")}
              >
                EN
              </button>
            </div>
            <button
              className="command-assistant"
              type="button"
              ref={assistantTriggerRef}
              aria-label={t("shell_assistant_label")}
              onClick={() => setAssistantOpen(true)}
            >
              <Sparkles size={17} />
              <span>{t("shell_assistant")}</span>
            </button>
            <div className="command-profile-wrap" ref={profileRef}>
              <button
                className="command-profile"
                type="button"
                ref={profileTriggerRef}
                aria-label={t("shell_profile_label")}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                aria-controls="profile-menu"
                data-testid="profile-button"
                onClick={() => setProfileOpen((open) => !open)}
              >
                <span className="command-avatar">
                  <CircleUserRound size={19} />
                </span>
                <span className="command-profile-copy">
                  <strong data-testid="profile-role">{roleLabel}</strong>
                  <small data-testid="profile-account">{accountLabel}</small>
                </span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="command-profile-menu" data-testid="profile-menu">
                  <div className="command-profile-menu-head">
                    <b>{roleLabel}</b>
                    <span>{accountLabel}</span>
                  </div>
                  <div id="profile-menu" role="menu" aria-label={t("shell_profile_label")}>
                    <div
                      className="command-profile-menu-group"
                      role="group"
                      aria-label={t("shell_lang_label")}
                    >
                      {[
                        ["id", "w10fleet_lang_id"],
                        ["en", "w10fleet_lang_en"],
                      ].map(([code, key]) => (
                        <button
                          key={code}
                          type="button"
                          role="menuitemradio"
                          aria-checked={lang === code}
                          data-testid={`profile-lang-${code}`}
                          onClick={() => {
                            setLang(code);
                            setProfileOpen(false);
                          }}
                        >
                          <span>{t(key)}</span>
                          {lang === code && <Check size={16} aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                    {pinned.map(({ id, key, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="menuitem"
                        aria-current={activeWorkspace === id ? "page" : undefined}
                        data-testid={`profile-menu-${id}`}
                        onClick={() => selectWorkspace(id)}
                      >
                        <Icon size={17} aria-hidden="true" />
                        <span>{t(key)}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="profile-logout"
                      onClick={() => {
                        setProfileOpen(false);
                        onLogout();
                      }}
                    >
                      <LogOut size={17} aria-hidden="true" />
                      <span>{t("shell_logout")}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="command-canvas">{children}</div>

        <nav className="command-mobile-nav" aria-label={t("shell_mobile_nav_label")}>
          {/* Settings sits in the profile menu on phones: five thumb slots, not six. */}
          {operational.map(({ id, key, shortKey, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={activeWorkspace === id ? "active" : ""}
              aria-current={activeWorkspace === id ? "page" : undefined}
              onClick={() => selectWorkspace(id)}
            >
              <Icon size={20} />
              <span>{t(shortKey || key)}</span>
            </button>
          ))}
        </nav>

        {assistantOpen && (
          <div
            className="assistant-modal-backdrop"
            role="presentation"
            onMouseDown={() => setAssistantOpen(false)}
          >
            <section
              className="assistant-modal"
              ref={assistantDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={t("shell_assistant_label")}
              tabIndex={-1}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                className="assistant-close"
                type="button"
                aria-label={t("shell_close_assistant")}
                onClick={() => setAssistantOpen(false)}
              >
                ×
              </button>
              {assistant}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
