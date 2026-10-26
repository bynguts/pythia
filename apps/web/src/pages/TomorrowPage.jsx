import { LegacyWorkspace } from "../app/LegacyWorkspace.jsx";

// Wave 13 stub (lane F wiring): lane S3 replaces this with the Tomorrow (iNFo4) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function TomorrowPage() {
  return <LegacyWorkspace workspace="planning" />;
}
