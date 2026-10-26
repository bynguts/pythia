import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, Database, Languages, Plug, ScrollText, User, Users } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Segmented } from "../../shared/ui/Segmented.jsx";
import { StatusDot } from "../../shared/ui/StatusDot.jsx";
import { useConsole } from "../../app/console/useConsole.js";
import { DataAuditWorkspace } from "../audit/DataAuditWorkspace.jsx";
import { MonthlyIntakeStrip } from "../forecast/MonthlyIntakeStrip.jsx";
import { AuditLogPanel } from "./AuditLogPanel.jsx";
import { IntegrationsPanel } from "./IntegrationsPanel.jsx";
import { ProvenancePanel } from "./ProvenancePanel.jsx";
import { ROLE_PERMISSIONS } from "./roles.js";
import { TeamAccess } from "./TeamAccess.jsx";
import "./settings.css";
import "./settings-console.css";

// wave13 Settings (T6NMuR): a section list on the left, one column on the right. The section
// lives in ?tab=; /audit redirects to ?tab=data and the old ?tab=whatsapp opens the
// integrations with WhatsApp expanded.
const TABS = [
  { id: "account", icon: User },
  { id: "team", icon: Users },
  { id: "notifications", icon: Bell },
  { id: "integrations", icon: Plug },
  { id: "data", icon: Database },
  { id: "audit", icon: ScrollText },
  { id: "language", icon: Languages },
];

function storedRole() {
  try {
    return localStorage.getItem("pythia_role");
  } catch {
    return null;
  }
}

function AccountPanel({ role, permissions }) {
  const { t } = useLanguage();
  return (
    <div className="st-group" data-testid="settings-account">
      <header className="st-head">
        <h2>{t("s5_set_account_title")}</h2>
        <p>{t("s5_set_account_sub")}</p>
      </header>
      <dl className="st-facts">
        <div>
          <dt>{t("s5_set_account_role")}</dt>
          <dd data-testid="settings-account-role">{t(`pln6_profile_role_${role || "unknown"}`)}</dd>
        </div>
        <div>
          <dt>{t("s5_set_account_access")}</dt>
          <dd>
            <ul className="st-perms">
              {permissions.map((permission) => (
                <li key={permission}>{t(`set_perm_${permission.replace(":", "_")}`)}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>{t("s5_set_account_session")}</dt>
          <dd>{t("s5_set_account_session_note")}</dd>
        </div>
      </dl>
    </div>
  );
}

function NotificationsPanel({ onOpenIntegrations }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState(undefined);
  useEffect(() => {
    const controller = new AbortController();
    apiGet("/whatsapp/status", { signal: controller.signal })
      .then(setStatus)
      .catch((error) => error?.name !== "AbortError" && setStatus(null));
    return () => controller.abort();
  }, []);
  const groupSet = status?.alert_group?.source && status.alert_group.source !== "placeholder";
  return (
    <div className="st-group" data-testid="settings-notifications">
      <header className="st-head">
        <h2>{t("s5_set_notif_title")}</h2>
        <p>{t("s5_set_notif_sub")}</p>
      </header>
      <ul className="st-list">
        <li className="st-int">
          <span className="st-int-text">
            <strong>{t("s5_set_notif_group")}</strong>
            <small>{t("s5_set_notif_group_desc")}</small>
          </span>
          <StatusDot tone={status === undefined ? "idle" : !status ? "idle" : groupSet ? "ok" : "warn"}>
            {status === undefined
              ? t("s5_set_checking")
              : !status
                ? t("s5_set_unreadable")
                : groupSet
                  ? t("s5_set_notif_group_set")
                  : t("s5_set_notif_group_none")}
          </StatusDot>
          <button type="button" className="st-link" onClick={onOpenIntegrations}>
            {t("s5_set_notif_open")}
          </button>
        </li>
      </ul>
      <p className="st-note">{t("s5_set_notif_note")}</p>
    </div>
  );
}

function LanguagePanel() {
  const { t, lang, setLang } = useLanguage();
  return (
    <div className="st-group" data-testid="settings-language">
      <header className="st-head">
        <h2>{t("s5_set_lang_title")}</h2>
        <p>{t("s5_set_lang_sub")}</p>
      </header>
      <Segmented
        label={t("s5_set_lang_title")}
        value={lang}
        onChange={setLang}
        options={[
          { value: "en", label: t("f_lang_en"), testId: "lang-switch-en" },
          { value: "id", label: t("f_lang_id"), testId: "lang-switch-id" },
        ]}
      />
    </div>
  );
}

export function ConsoleSettings() {
  const { t } = useLanguage();
  const { setSubtitle } = useConsole();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const legacyWhatsApp = requested === "whatsapp";
  const tab = TABS.some((entry) => entry.id === requested) ? requested : "integrations";
  const [whatsappOpen, setWhatsappOpen] = useState(legacyWhatsApp);
  // The server's view of this session decides who may change settings; the stored role is
  // only the label while that answer is pending or unreachable.
  const [session, setSession] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet("/auth/session", { signal: controller.signal })
      .then(setSession)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setSubtitle(t(tab === "integrations" ? "s5_set_crumb_integrations" : `s5_set_tab_${tab}`));
    return () => setSubtitle(null);
  }, [tab, t, setSubtitle]);

  const role = session?.role || storedRole();
  const permissions = session?.permissions || ROLE_PERMISSIONS[role] || [];
  // WhatsApp pairing is for the dispatcher and the administrator (the API gates it on
  // admin:manage or operations:plan; the supervisor also holds dispatch:create).
  const canManage = permissions.includes("admin:manage") || permissions.includes("operations:plan");

  function select(id) {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    setParams(next, { replace: true });
  }

  return (
    <div className="st" data-testid="settings-workspace">
      <header className="st-title">
        <h1>{t("s5_set_title")}</h1>
        <p>{t("s5_set_sub")}</p>
      </header>

      <div className="st-layout">
        <nav className="st-nav" aria-label={t("s5_set_nav_label")} data-testid="settings-nav">
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "is-active" : ""}
              aria-current={tab === id ? "page" : undefined}
              data-testid={`settings-tab-${id}`}
              onClick={() => select(id)}
            >
              <Icon size={16} aria-hidden="true" />
              {t(`s5_set_tab_${id}`)}
            </button>
          ))}
        </nav>

        <div className="st-main">
          {tab === "account" && <AccountPanel role={role} permissions={permissions} />}
          {tab === "team" && <TeamAccess role={role} />}
          {tab === "notifications" && (
            <NotificationsPanel onOpenIntegrations={() => select("integrations")} />
          )}
          {/* T6NMuR: the source table and the audit export continue on the same scroll. */}
          {tab === "integrations" && (
            <>
              <IntegrationsPanel
                canManage={canManage}
                openWhatsApp={whatsappOpen}
                onToggleWhatsApp={() => setWhatsappOpen((open) => !open)}
                onOpenData={() => select("data")}
              />
              <ProvenancePanel />
            </>
          )}
          {tab === "data" && (
            <>
              <ProvenancePanel />
              <MonthlyIntakeStrip />
              <DataAuditWorkspace />
            </>
          )}
          {tab === "audit" && <AuditLogPanel />}
          {tab === "language" && <LanguagePanel />}
        </div>
      </div>
    </div>
  );
}
