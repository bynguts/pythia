import { LegacyWorkspace } from "../app/LegacyWorkspace.jsx";

// Wave 13 stub (lane F wiring): lane S2 replaces this with the Fleet & drivers (KsF6w) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function FleetPage() {
  return <LegacyWorkspace workspace="drivers" />;
}
