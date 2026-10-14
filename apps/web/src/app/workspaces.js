// Command-center workspace registry: nav order, catalog keys and URL paths.
import { BarChart3, Building2, ShieldCheck, Truck, Users, Workflow } from "lucide-react";

// #15: descriptions are catalog keys, resolved per active locale at render time.
export const WORKSPACES = [
  { id: "twin", key: "nav_twin", shortKey: "nav_twin_short", descKey: "desc_twin", icon: Building2 },
  { id: "fleet", key: "nav_armada", descKey: "desc_fleet", icon: Truck },
  { id: "forecast", key: "nav_prediksi", descKey: "desc_forecast", icon: BarChart3 },
  { id: "planning", key: "nav_rencana", descKey: "desc_planning", icon: Workflow },
  { id: "drivers", key: "nav_sopir", descKey: "desc_drivers", icon: Users },
  { id: "audit", key: "nav_audit", shortKey: "nav_audit_short", descKey: "desc_audit", icon: ShieldCheck },
];

export const DEFAULT_WORKSPACE = "fleet";

export function isWorkspace(id) {
  return WORKSPACES.some((workspace) => workspace.id === id);
}

export function workspacePath(id) {
  return `/${id}`;
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
