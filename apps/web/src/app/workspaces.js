// Command-center workspace registry: nav order, catalog keys and URL paths.
import { BarChart3, Building2, Settings, Truck, Users, Workflow } from "lucide-react";

// #15: descriptions are catalog keys, resolved per active locale at render time.
// wave10 nav: operational items in daily-use order (Armada is the landing page); the
// twin is a briefing room, so it comes last. Settings is pinned below a separator.
export const WORKSPACES = [
  { id: "fleet", key: "nav_armada", descKey: "desc_fleet", icon: Truck },
  { id: "planning", key: "nav_rencana", descKey: "desc_planning", icon: Workflow },
  { id: "forecast", key: "nav_prediksi", descKey: "desc_forecast", icon: BarChart3 },
  { id: "drivers", key: "nav_sopir", descKey: "desc_drivers", icon: Users },
  { id: "twin", key: "w10fleet_nav_twin", descKey: "desc_twin", icon: Building2 },
  {
    id: "settings",
    key: "nav_settings",
    descKey: "desc_settings",
    icon: Settings,
    separated: true,
  },
];

// Workspaces that moved: old deep links land on their new home, query kept.
const MOVED = { audit: { id: "settings", tab: "data" } };

export const DEFAULT_WORKSPACE = "fleet";

export function isWorkspace(id) {
  return WORKSPACES.some((workspace) => workspace.id === id);
}

export function workspacePath(id) {
  return `/${id}`;
}

export function movedWorkspacePath(id, search) {
  if (!Object.hasOwn(MOVED, id)) return null;
  const query = new URLSearchParams(search);
  query.set("tab", MOVED[id].tab);
  return `${workspacePath(MOVED[id].id)}?${query}`;
}

// Where "/" (and any unknown command-center path) lands. ?workspace=twin and
// ?present=1 (footage mode) keep opening the twin; the rest of the query
// (present, city, basemap, motion, …) is carried over for the twin to read.
export function landingPath(search) {
  const query = new URLSearchParams(search);
  const id = query.get("workspace") === "twin" || query.get("present") === "1" ? "twin" : DEFAULT_WORKSPACE;
  query.delete("workspace");
  const rest = query.toString();
  return `${workspacePath(id)}${rest ? `?${rest}` : ""}`;
}
