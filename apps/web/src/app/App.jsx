import { lazy, Suspense, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
// The driver app comes first: its stylesheet precedes the global styles in
// the cascade (main.jsx imports styles/index.css after this module). The lazy
// surfaces below keep their stylesheets here, in the order they had when they
// were static imports, so moving their code out of the main chunk does not
// reorder the cascade.
import DriverApp from "../surfaces/driver/DriverApp.jsx";
import "../features/fleet/safety.css";
import "../features/assistant/assistant.css";
import "../features/audit/audit.css";
import "../features/forecast/monthlyIntake.css";
import { LoginPage } from "../surfaces/login/LoginPage.jsx";
import { RoleGate } from "../surfaces/login/RoleGate.jsx";
import { useLanguage } from "../shared/i18n/index.jsx";
import { isWorkspace, landingPath, movedWorkspacePath } from "./workspaces.js";

// /driver must not download the command centre: everything else is a lazy chunk.
const SupervisorView = lazy(() =>
  import("../surfaces/supervisor/SupervisorView.jsx").then((m) => ({ default: m.SupervisorView })),
);
const CommandCenter = lazy(() => import("./CommandCenter.jsx").then((m) => ({ default: m.CommandCenter })));

function SurfaceBoot({ children }) {
  const { t } = useLanguage();
  return (
    <Suspense
      fallback={
        <main className="map-loading-fallback" role="status">
          {t("sv_loading")}
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

// read-only XR tabletop twin, no login; three.js stays in this lazy chunk.
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

// wave10 L3: /field merged into /driver; its instructions are the Instruksi tab.
function FieldRedirect() {
  const params = new URLSearchParams(useLocation().search);
  params.set("tab", "instruksi");
  return <Navigate to={`/driver?${params}`} replace />;
}

function Landing() {
  const { search } = useLocation();
  return <Navigate to={landingPath(search)} replace />;
}

function WorkspaceRoute({ onLogout }) {
  const { workspace } = useParams();
  const { search } = useLocation();
  const moved = movedWorkspacePath(workspace, search);
  if (moved) return <Navigate to={moved} replace />;
  if (!isWorkspace(workspace)) return <Landing />;
  return (
    <SurfaceBoot>
      <CommandCenter workspace={workspace} onLogout={onLogout} />
    </SurfaceBoot>
  );
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
      {/* gsc P0-2: the driver app asks for a driver sign-in in place before any write. */}
      <Route path="/field/*" element={<FieldRedirect />} />
      <Route
        path="/driver/*"
        element={
          <RoleGate>
            <DriverApp />
          </RoleGate>
        }
      />
      <Route element={<LoginGate authenticated={authenticated} onLogin={() => setAuthenticated(true)} />}>
        <Route
          path="/pengawas/*"
          element={
            <SurfaceBoot>
              <SupervisorView />
            </SurfaceBoot>
          }
        />
        <Route path="/:workspace" element={<WorkspaceRoute onLogout={logout} />} />
        <Route path="*" element={<Landing />} />
      </Route>
    </Routes>
  );
}
