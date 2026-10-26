import { LegacyWorkspace } from "../app/LegacyWorkspace.jsx";

// Wave 13 stub (lane F wiring): lane S5 replaces this with the Settings (T6NMuR) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function SettingsPage() {
  return <LegacyWorkspace workspace="settings" />;
}
