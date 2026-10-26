// Console page registry: sidebar order, groups, catalog keys and URL paths.
import {
  CalendarDays,
  ChartNoAxesColumn,
  FileText,
  ListChecks,
  RadioTower,
  Settings,
  Truck,
  Warehouse,
} from "lucide-react";

// Wave 13: the console lives under /app/<id>. Groups follow the design's sidebar
// (Today, Plan); Settings is pinned below a separator.
export const WORKSPACES = [
  { id: "operations", key: "f_nav_operations", group: "today", icon: RadioTower },
  { id: "readiness", key: "f_nav_readiness", group: "today", icon: ListChecks },
  { id: "gate", key: "f_nav_gate", group: "today", icon: Warehouse },
  { id: "work-orders", key: "f_nav_work_orders", group: "today", icon: FileText },
  { id: "tomorrow", key: "f_nav_tomorrow", group: "plan", icon: CalendarDays },
  { id: "fleet", key: "f_nav_fleet", group: "plan", icon: Truck },
  { id: "reports", key: "f_nav_reports", group: "plan", icon: ChartNoAxesColumn },
  { id: "settings", key: "f_nav_settings", icon: Settings, separated: true },
];

export const DEFAULT_WORKSPACE = "operations";

export function isWorkspace(id) {
  return WORKSPACES.some((workspace) => workspace.id === id);
}

export function workspacePath(id) {
  return `/app/${id}`;
}

// Pre-wave-13 paths: old deep links land on their new home, query kept (plus
// the given tab, which wins over one already in the query).
export const MOVED_PATHS = {
  fleet: { to: "operations" },
  planning: { to: "tomorrow" },
  forecast: { to: "tomorrow" },
  drivers: { to: "fleet" },
  settings: { to: "settings" },
  audit: { to: "settings", tab: "data" },
  pengawas: { to: "tomorrow" },
};

export function movedPath(oldId, search) {
  const moved = MOVED_PATHS[oldId];
  const query = new URLSearchParams(search);
  if (moved.tab) query.set("tab", moved.tab);
  const rest = query.toString();
  return `${workspacePath(moved.to)}${rest ? `?${rest}` : ""}`;
}

// ?workspace=twin and ?present=1 (footage mode) on "/" keep opening the twin;
// the rest of the query (present, city, basemap, motion, …) is carried over.
export function twinRedirect(search) {
  const query = new URLSearchParams(search);
  if (query.get("workspace") !== "twin" && query.get("present") !== "1") return null;
  query.delete("workspace");
  const rest = query.toString();
  return `/twin${rest ? `?${rest}` : ""}`;
}

// Where /app (and an unknown /app/<id>) lands, query kept.
export function consoleHome(search) {
  return `${workspacePath(DEFAULT_WORKSPACE)}${search || ""}`;
}
