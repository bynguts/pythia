import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
// The driver app comes first: its stylesheet precedes the global styles in
// the cascade (main.jsx imports styles/index.css after this module). The lazy
// surfaces below keep their stylesheets here, in the order they had when they
// were static imports, so moving their code out of the main chunk does not
// reorder the cascade.
import DriverApp from "../surfaces/driver/DriverApp.jsx";
import "../features/assistant/assistant.css";
import "../features/audit/audit.css";
import "../features/forecast/monthlyIntake.css";
import { LoginPage } from "../surfaces/login/LoginPage.jsx";
import { RoleGate } from "../surfaces/login/RoleGate.jsx";
import { apiFetch, COMMAND_TOKEN_KEY } from "../shared/api/client.js";
import { useLanguage } from "../shared/i18n/index.jsx";
import { ErrorBoundary } from "../shared/ui/ErrorBoundary.jsx";
import { SessionEnded } from "../shared/ui/SessionEnded.jsx";
import { consoleHome, isWorkspace, MOVED_PATHS, movedPath, twinRedirect } from "./workspaces.js";

// /driver must not download the console: everything else is a lazy chunk.
const LandingPage = lazy(() =>
  import("../surfaces/landing/LandingPage.jsx").then((m) => ({ default: m.LandingPage })),
);
const ConsoleShell = lazy(() =>
  import("./console/ConsoleShell.jsx").then((m) => ({ default: m.ConsoleShell })),
);
// deck.gl + the twin stay in their own lazy chunk, off the startup path.
const TwinWorkspace = lazy(() =>
  import("../features/twin/TwinWorkspace.jsx").then((m) => ({ default: m.TwinWorkspace })),
);

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
// link reloads into the right place once the operator signs in. A session that
// ends mid-visit keeps the page on screen under the session-ended modal; "Sign in
// again" then shows the sign-in in place, on the same URL.
function LoginGate({ authenticated, expired, onLogin, onSignInAgain }) {
  const { t } = useLanguage();
  if (!authenticated)
    return <LoginPage onLogin={onLogin} notice={expired ? t("login_session_expired") : ""} />;
  return (
    <>
      <Outlet />
      <SessionEnded open={expired} onSignIn={onSignInAgain} />
    </>
  );
}

// Tokens live in the backend's memory, so a restart invalidates every stored
// session. Check the stored token when the app opens and whenever the tab comes
// back into view; a 401 signs out instead of leaving every panel empty. A
// network failure or a service-worker cache copy says nothing about the token.
function useSessionCheck(authenticated, onExpired) {
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;
  useEffect(() => {
    if (!authenticated) return undefined;
    let controller = null;
    const check = () => {
      if (document.visibilityState === "hidden" || !localStorage.getItem(COMMAND_TOKEN_KEY)) return;
      controller?.abort();
      controller = new AbortController();
      apiFetch("/auth/session", { signal: controller.signal })
        .then((res) => {
          if (res.status === 401 && !res.headers.get("X-Pythia-Stale")) expiredRef.current();
        })
        .catch(() => {});
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => {
      controller?.abort();
      document.removeEventListener("visibilitychange", check);
    };
  }, [authenticated]);
}

// wave10 L3: /field merged into /driver; its instructions are the Instruksi tab.
function FieldRedirect() {
  const params = new URLSearchParams(useLocation().search);
  params.set("tab", "instruksi");
  return <Navigate to={`/driver?${params}`} replace />;
}

// "/" is the public landing; ?present=1 / ?workspace=twin keep opening the twin.
function Home() {
  const { search } = useLocation();
  const twin = twinRedirect(search);
  if (twin) return <Navigate to={twin} replace />;
  return (
    <SurfaceBoot>
      <LandingPage />
    </SurfaceBoot>
  );
}

// Wave 13: pre-console paths redirect to their /app home, query kept.
function MovedRoute({ from }) {
  const { search } = useLocation();
  return <Navigate to={movedPath(from, search)} replace />;
}

function ConsoleHome() {
  const { search } = useLocation();
  return <Navigate to={consoleHome(search)} replace />;
}

function ConsoleRoute({ onLogout }) {
  const { page } = useParams();
  if (!isWorkspace(page)) return <ConsoleHome />;
  return (
    <SurfaceBoot>
      <ConsoleShell page={page} onLogout={onLogout} />
    </SurfaceBoot>
  );
}

// The briefing room: the twin full screen, outside the console frame.
function TwinRoute() {
  const { t } = useLanguage();
  return (
    <main className="twin-route">
      <ErrorBoundary name="twin">
        <Suspense
          fallback={
            <div className="map-loading-fallback" role="status">
              {t("twin_loading")}
            </div>
          }
        >
          <TwinWorkspace />
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

export function App() {
  const [authenticated, setAuthenticated] = useState(() => localStorage.getItem("pythia_auth") === "true");
  const [expired, setExpired] = useState(false);
  function clearSession() {
    localStorage.removeItem("pythia_auth");
    localStorage.removeItem("pythia_token");
    localStorage.removeItem("pythia_role");
  }
  function logout() {
    clearSession();
    setAuthenticated(false);
  }
  // A token the backend no longer knows: the stored session goes at once; the page
  // stays under the session-ended modal until the operator chooses to sign in.
  useSessionCheck(authenticated && !expired, () => {
    clearSession();
    setExpired(true);
  });
  function login() {
    setExpired(false);
    setAuthenticated(true);
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
      <Route path="/" element={<Home />} />
      {Object.keys(MOVED_PATHS).map((from) => (
        <Route key={from} path={`/${from}/*`} element={<MovedRoute from={from} />} />
      ))}
      <Route
        element={
          <LoginGate
            authenticated={authenticated}
            expired={expired}
            onLogin={login}
            onSignInAgain={() => setAuthenticated(false)}
          />
        }
      >
        <Route path="/app" element={<ConsoleHome />} />
        <Route path="/app/:page" element={<ConsoleRoute onLogout={logout} />} />
        <Route path="/twin" element={<TwinRoute />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
