import { Link } from "react-router-dom";
import { useLanguage } from "../../shared/i18n/index.jsx";

// Wave 13 stub (lane F wiring): lane L replaces this with the designed landing (GdhGj).
export function LandingPage() {
  const { t } = useLanguage();
  return (
    <main className="landing-stub">
      <h1>{t("f_landing_title")}</h1>
      <Link to="/app">{t("f_landing_open_console")}</Link>
    </main>
  );
}
