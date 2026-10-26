import { createContext, useContext } from "react";

export const SUPERVISOR_MODE_KEY = "pythia_supervisor_mode";

/**
 * What a console page can read from (and tell) the shell.
 * - role, permissions: the signed-in role and its permission list (from /api/auth/session).
 * - canSupervise: the role has `operations:approve`.
 * - supervisorMode / setSupervisorMode(bool): the sidebar toggle, persisted in
 *   localStorage `pythia_supervisor_mode`; always false when canSupervise is false.
 * - setNavCount(pageId, count, tone?): the sidebar count tag for a page
 *   (tone "danger" | "warn"; count null/0 hides it). Readiness is filled by the shell.
 * - setSubtitle(text|null): replaces the top bar's date after the crumb.
 * - openAna(): opens the Ask Ana drawer.
 */
export const ConsoleContext = createContext({
  role: null,
  permissions: [],
  canSupervise: false,
  supervisorMode: false,
  setSupervisorMode: () => {},
  setNavCount: () => {},
  setSubtitle: () => {},
  openAna: () => {},
});

export function useConsole() {
  return useContext(ConsoleContext);
}

// Day phases by the clock in Jakarta: readiness before the 06:00 roll-out, the run
// until 15:00, close of day until 19:00, then planning for tomorrow.
export function dayPhase(hour) {
  if (hour >= 4 && hour < 6) return "ready";
  if (hour >= 6 && hour < 15) return "run";
  if (hour >= 15 && hour < 19) return "close";
  return "plan";
}
