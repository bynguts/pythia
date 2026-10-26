import { lazy } from "react";

// One lazy chunk per console page, so a screen's heavy pieces load only there.
const page = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));

export const PAGES = {
  operations: page(() => import("../../pages/OperationsPage.jsx"), "OperationsPage"),
  readiness: page(() => import("../../pages/ReadinessPage.jsx"), "ReadinessPage"),
  gate: page(() => import("../../pages/GatePage.jsx"), "GatePage"),
  "work-orders": page(() => import("../../pages/WorkOrdersPage.jsx"), "WorkOrdersPage"),
  tomorrow: page(() => import("../../pages/TomorrowPage.jsx"), "TomorrowPage"),
  fleet: page(() => import("../../pages/FleetPage.jsx"), "FleetPage"),
  reports: page(() => import("../../pages/ReportsPage.jsx"), "ReportsPage"),
  settings: page(() => import("../../pages/SettingsPage.jsx"), "SettingsPage"),
};
