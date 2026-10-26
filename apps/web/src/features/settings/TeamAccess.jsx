import { useLanguage } from "../../shared/i18n/index.jsx";
import { ROLE_PERMISSIONS } from "./roles.js";

// Read-only: roles and what each can do. Accounts are managed on the server.
// wave11 settings: one table, a row per role; on phones each row stacks.
export function TeamAccess({ role }) {
  const { t } = useLanguage();
  return (
    <section className="settings-panel" aria-labelledby="settings-team-title" data-testid="settings-team">
      <header className="settings-panel-head">
        <h2 id="settings-team-title">{t("set_tab_team")}</h2>
        <p>{t("set_team_intro")}</p>
      </header>
      <div className="settings-box">
        <table className="settings-roles">
          <caption className="sr-only">{t("set_tab_team")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("set11_team_th_role")}</th>
              <th scope="col">{t("set11_team_th_access")}</th>
              <th scope="col" className="settings-num">
                {t("set11_team_th_count")}
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(ROLE_PERMISSIONS).map(([name, permissions]) => (
              <tr key={name} className={name === role ? "is-you" : ""} data-testid={`settings-role-${name}`}>
                <th scope="row">
                  <span className="settings-role-name">{t(`pln6_profile_role_${name}`)}</span>
                  {name === role && <span className="prov prov-real settings-you">{t("set_team_you")}</span>}
                </th>
                <td>
                  <ul className="settings-perms">
                    {permissions.map((permission) => (
                      <li key={permission}>{t(`set_perm_${permission.replace(":", "_")}`)}</li>
                    ))}
                  </ul>
                </td>
                <td className="settings-num">{permissions.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
