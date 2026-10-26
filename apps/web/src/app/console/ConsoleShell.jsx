import { Suspense, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../AppShell.jsx";
import { workspacePath } from "../workspaces.js";
import { AssistantPanel } from "../../features/assistant/AssistantPanel.jsx";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { ErrorBoundary } from "../../shared/ui/ErrorBoundary.jsx";
import { PAGES } from "./pages.js";

// The console frame around every /app/<page>. It stays mounted while the page
// changes, so the sidebar and the assistant keep their state.
export function ConsoleShell({ page, onLogout }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const Page = PAGES[page];
  return (
    <AppShell
      activeWorkspace={page}
      onWorkspaceChange={(id) => id !== page && navigate(workspacePath(id))}
      online={online}
      onLogout={onLogout}
      assistant={<AssistantPanel />}
    >
      <ErrorBoundary name={page} key={page}>
        <Suspense
          fallback={
            <div className="map-loading-fallback" role="status">
              {t("f_page_loading")}
            </div>
          }
        >
          <Page />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}
