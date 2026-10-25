import { useLanguage } from "../../shared/i18n/index.jsx";
import { ROLE_PERMISSIONS } from "./roles.js";

// Read-only: roles and what each can do. Accounts are managed on the server.
export function TeamAccess({ role }) {
  const { t } = useLanguage();
  return (
    <section className="settings-panel" aria-labelledby="settings-team-title" data-testid="settings-team">
      <header className="settings-panel-head">
        <h2 id="settings-team-title">{t("set_tab_team")}</h2>
        <p>{t("set_team_intro")}</p>
      </header>
      <ul className="settings-roles">
        {Object.entries(ROLE_PERMISSIONS).map(([name, permissions]) => (
          <li key={name} data-testid={`settings-role-${name}`}>
            <div className="settings-role-head">
              <strong>{t(`pln6_profile_role_${name}`)}</strong>
              {name === role && <span className="settings-you">{t("set_team_you")}</span>}
            </div>
            <p>
              {permissions.map((permission) => t(`set_perm_${permission.replace(":", "_")}`)).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      <p className="settings-note">{t("set_team_accounts_note")}</p>
    </section>
  );
}
