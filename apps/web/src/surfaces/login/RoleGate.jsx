import { useEffect, useState } from "react";
import { apiFetch, FIELD_ROLE_KEY, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { DriverLogin } from "../driver/DriverLogin.jsx";

// gsc P0-2: /driver stays a public route (/field redirects to it), but every write they make
// needs a token whose role may act on field work (the same permissions the
// backend checks: every driver/field write accepts dispatch:confirm or
// dispatch:create). Without one (a fresh phone), or when the backend no longer
// knows the stored token (it restarted), the existing login renders in place,
// pre-filled for the driver, so the deep link survives. Offline with no token
// the surface still renders its cached read-only views; queued writes wait in
// the outbox and the login appears once the connection returns.
// gsc M1: the field session lives under its own keys (FIELD_TOKEN_KEY), apart
// from the command center's, and this gate never marks the command center as
// signed in.
const FIELD_PERMISSIONS = ["dispatch:confirm", "dispatch:create"];

function storedToken() {
  try {
    return localStorage.getItem(FIELD_TOKEN_KEY);
  } catch {
    return null;
  }
}

function clearFieldSession() {
  try {
    localStorage.removeItem(FIELD_TOKEN_KEY);
    localStorage.removeItem(FIELD_ROLE_KEY);
  } catch {
    // Storage blocked: nothing stored to clear.
  }
}

function mayActOnFieldWork(permissions) {
  return FIELD_PERMISSIONS.some((permission) => (permissions || []).includes(permission));
}

export function RoleGate({ role = "driver", children }) {
  const { t } = useLanguage();
  const [signedIn, setSignedIn] = useState(() => Boolean(storedToken()) || !navigator.onLine);
  const [forbidden, setForbidden] = useState(false);

  // Validate a stored token once; a network failure or a service-worker cache
  // copy says nothing about the live backend, so the surface stays usable.
  useEffect(() => {
    if (!storedToken()) return undefined;
    const controller = new AbortController();
    apiFetch("/auth/session", { signal: controller.signal, tokenKey: FIELD_TOKEN_KEY })
      .then(async (res) => {
        if (res.headers.get("X-Pythia-Stale")) return;
        if (res.status === 401) {
          clearFieldSession();
          setSignedIn(false);
          return;
        }
        if (!res.ok) return;
        const body = await res.json();
        if (!mayActOnFieldWork(body.permissions)) {
          clearFieldSession();
          setForbidden(true);
          setSignedIn(false);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onOnline = () => {
      if (!storedToken()) setSignedIn(false);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  // n16: a fresh gate login must hold a field permission too, not only a
  // stored token on reload.
  function onLogin(principal) {
    if (!mayActOnFieldWork(principal?.permissions)) {
      clearFieldSession();
      setForbidden(true);
      return;
    }
    setForbidden(false);
    setSignedIn(true);
  }

  if (!signedIn) {
    return (
      <DriverLogin
        onLogin={onLogin}
        initialUsername={role}
        notice={forbidden ? t("role_gate_forbidden") : t("role_gate_notice")}
      />
    );
  }
  return children;
}
