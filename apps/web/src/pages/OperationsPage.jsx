import { LegacyWorkspace } from "../app/LegacyWorkspace.jsx";

// Wave 13 stub (lane F wiring): lane S1 replaces this with the Operations (U0H9au) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function OperationsPage() {
  return <LegacyWorkspace workspace="fleet" />;
}
