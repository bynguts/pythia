import { lazy, Suspense, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
// Field and driver come first: their stylesheets precede the global styles in
// the cascade (main.jsx imports styles/index.css after this module).
import FieldApp from "../surfaces/field/FieldApp.jsx";
import DriverApp from "../surfaces/driver/DriverApp.jsx";
import { LoginPage } from "../surfaces/login/LoginPage.jsx";
import { SupervisorView } from "../surfaces/supervisor/SupervisorView.jsx";
import { useLanguage } from "../shared/i18n/index.jsx";
import { CommandCenter } from "./CommandCenter.jsx";
import { isWorkspace, landingPath } from "./workspaces.js";

// GSC-2026 WS-B: read-only XR tabletop twin, no login; three.js stays in this lazy chunk.
const XrTabletop = lazy(() =>
  import("../surfaces/xr/XrTabletop.jsx").then((m) => ({ default: m.XrTabletop })),
);

function XrRoute() {
  const { t } = useLanguage();
  return (
    <Suspense
      fallback={
        <main className="xr-boot" role="status">
          {t("xr_boot")}
        </main>
      }
    >
      <XrTabletop />
    </Suspense>
  );
}

// Everything behind the login gate keeps its URL while signed out, so a deep
// link reloads into the right place once the operator signs in.
function LoginGate({ authenticated, onLogin }) {
  if (!authenticated) return <LoginPage onLogin={onLogin} />;
  return <Outlet />;
}

function Landing() {
  const { search } = useLocation();
  return <Navigate to={landingPath(search)} replace />;
}

function WorkspaceRoute({ onLogout }) {
  const { workspace } = useParams();
  if (!isWorkspace(workspace)) return <Landing />;
  return <CommandCenter workspace={workspace} onLogout={onLogout} />;
}

export function App() {
  const [authenticated, setAuthenticated] = useState(() => localStorage.getItem("pythia_auth") === "true");
  function logout() {
    localStorage.removeItem("pythia_auth");
    localStorage.removeItem("pythia_token");
    localStorage.removeItem("pythia_role");
    setAuthenticated(false);
  }
  return (
    <Routes>
      <Route path="/xr/*" element={<XrRoute />} />
      <Route path="/field/*" element={<FieldApp />} />
      <Route path="/driver/*" element={<DriverApp />} />
      <Route element={<LoginGate authenticated={authenticated} onLogin={() => setAuthenticated(true)} />}>
        <Route path="/pengawas/*" element={<SupervisorView />} />
        <Route path="/:workspace" element={<WorkspaceRoute onLogout={logout} />} />
        <Route path="*" element={<Landing />} />
      </Route>
    </Routes>
  );
}
