import React, { useLayoutEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bot,
  ChevronDown,
  CircleUserRound,
  LogOut,
  ShieldCheck,
  Sparkles,
  Truck,
  Users,
  Workflow,
} from "lucide-react";
import { useLanguage } from "../i18n.jsx";

// #15: descriptions are catalog keys, resolved per active locale at render time.
const items = [
  { id: "fleet", key: "nav_armada", descKey: "desc_fleet", icon: Truck },
  { id: "forecast", key: "nav_prediksi", descKey: "desc_forecast", icon: BarChart3 },
  { id: "planning", key: "nav_rencana", descKey: "desc_planning", icon: Workflow },
  { id: "drivers", key: "nav_sopir", descKey: "desc_drivers", icon: Users },
  { id: "audit", key: "nav_audit", descKey: "desc_audit", icon: ShieldCheck },
];

const ALIASES = {
  surveillance: "fleet",
  weighbridge: "fleet",
  wa: "drivers",
  iot: "audit",
};

export function AppShell({ activeWorkspace, onWorkspaceChange, online, onLogout, assistant, children }) {
  const { lang, setLang, t } = useLanguage();
  const resolvedWorkspace = ALIASES[activeWorkspace] || activeWorkspace;
  const current = items.find((item) => item.id === resolvedWorkspace) || items[0];
  const [assistantOpen, setAssistantOpen] = useState(false);
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
    background.forEach((element) => { element.inert = true; });

    const focusable = () => Array.from(dialog.querySelectorAll(
      'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0);
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
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
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
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      assistantTriggerRef.current?.focus();
    };
  }, [assistantOpen]);

  function selectWorkspace(id) {
    onWorkspaceChange(id);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  return (
    <div className="command-shell" ref={shellRef}>

      <aside className="command-sidebar" aria-label={t("shell_sidebar_label")}>
        <div className="command-brand">
          <span className="command-brand-mark" aria-hidden="true">J</span>
          <div>
            <strong>JWIS</strong>
            <small>{t("shell_brand_sub")}</small>
          </div>
        </div>

        <div className="command-nav-label">{t("shell_workspaces")}</div>
        <nav className="command-nav" id="workspace-navigation" data-testid="workspace-navigation">
          {items.map(({ id, key, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`command-nav-item ${resolvedWorkspace === id ? "active" : ""}`}
              aria-current={resolvedWorkspace === id ? "page" : undefined}
              onClick={() => selectWorkspace(id)}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{t(key)}</span>
            </button>
          ))}
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
            <span className="command-eyebrow">{t("shell_context_eyebrow")}</span>
            <div className="command-title-row">
              <strong>{t(current.key)}</strong>
              <span>{t(current.descKey)}</span>
            </div>
          </div>

          <div className="command-top-actions">
            <div className="command-language" aria-label={t("shell_lang_label")}>
              <button type="button" data-testid="lang-switch-id" className={lang === "id" ? "active" : ""} onClick={() => setLang("id")}>ID</button>
              <button type="button" data-testid="lang-switch-en" className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>EN</button>
            </div>
            <button className="command-assistant" type="button" ref={assistantTriggerRef} aria-label={t("shell_assistant_label")} onClick={() => setAssistantOpen(true)}>
              <Sparkles size={17} />
              <span>{t("shell_assistant")}</span>
            </button>
            <button className="command-profile" type="button" aria-label={t("shell_profile_label")}>
              <span className="command-avatar"><CircleUserRound size={19} /></span>
              <span className="command-profile-copy"><strong>{t("shell_profile_name")}</strong><small>{t("shell_profile_role")}</small></span>
              <ChevronDown size={15} />
            </button>
          </div>
        </header>

        <div className="command-canvas">{children}</div>

        <nav className="command-mobile-nav" aria-label={t("shell_mobile_nav_label")}>
          {items.map(({ id, key, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={resolvedWorkspace === id ? "active" : ""}
              aria-current={resolvedWorkspace === id ? "page" : undefined}
              onClick={() => selectWorkspace(id)}
            >
              <Icon size={20} />
              <span>{id === "audit" ? t("nav_audit") : t(key)}</span>
            </button>
          ))}
        </nav>

        {assistantOpen && (
          <div className="assistant-modal-backdrop" role="presentation" onMouseDown={() => setAssistantOpen(false)}>
            <section className="assistant-modal" ref={assistantDialogRef} role="dialog" aria-modal="true" aria-label={t("shell_assistant_label")} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
              <button className="assistant-close" type="button" aria-label={t("shell_close_assistant")} onClick={() => setAssistantOpen(false)}>×</button>
              {assistant}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
