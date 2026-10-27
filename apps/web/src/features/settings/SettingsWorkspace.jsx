import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Database, MessageCircle, Users } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { DataAuditWorkspace } from "../audit/DataAuditWorkspace.jsx";
import { ROLE_PERMISSIONS } from "./roles.js";
import { TeamAccess } from "./TeamAccess.jsx";
import { WhatsAppIntegration } from "./WhatsAppIntegration.jsx";
import "./settings.css";

// Where an operator configures Pythia. The section lives in ?tab=
// (whatsapp is the default), so /audit can redirect to ?tab=data.
// A settings page in the SaaS sense: a section list on the left (a segmented
// control on phones) and one plain column of setting groups on the right.
const SECTIONS = [
  { id: "whatsapp", groupKey: "set_group_integrations", key: "set_tab_whatsapp", icon: MessageCircle },
  { id: "team", groupKey: "set_group_organisation", key: "set_tab_team", icon: Users },
  { id: "data", groupKey: "set_group_transparency", key: "set_tab_data", icon: Database },
];

function storedRole() {
  try {
    return localStorage.getItem("pythia_role");
  } catch {
    return null;
  }
}

export function SettingsWorkspace() {
  const { t } = useLanguage();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab = SECTIONS.some((section) => section.id === requested) ? requested : SECTIONS[0].id;
  // The server's view of this session decides who may change settings; the stored role
  // is only a fallback for labels while that answer is pending or unreachable.
  const [session, setSession] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet("/auth/session", { signal: controller.signal })
      .then(setSession)
      .catch(() => {});
    return () => controller.abort();
  }, []);

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
    <section className="settings-workspace workspace-page" data-testid="settings-workspace">
      <header className="settings-heading">
        <h1>{t("set_title")}</h1>
        <p>{t("set_intro")}</p>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("set_sections_label")} data-testid="settings-nav">
          {SECTIONS.map(({ id, groupKey, key, icon: Icon }) => (
            <div key={id} className="settings-nav-group">
              <span className="settings-nav-label">{t(groupKey)}</span>
              <button
                type="button"
                className={tab === id ? "active" : ""}
                aria-current={tab === id ? "page" : undefined}
                data-testid={`settings-tab-${id}`}
                onClick={() => select(id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="settings-nav-full">{t(key)}</span>
                <span className="settings-nav-short" aria-hidden="true">
                  {t(`${key}_short`)}
                </span>
              </button>
            </div>
          ))}
        </nav>

        <div className="settings-content">
          {tab === "whatsapp" && <WhatsAppIntegration canManage={canManage} />}
          {tab === "team" && <TeamAccess role={role} />}
          {tab === "data" && <DataAuditWorkspace />}
        </div>
      </div>
    </section>
  );
}
