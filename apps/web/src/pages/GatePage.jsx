import { StaggerSimulatorPanel } from "../features/fleet/StaggerSimulatorPanel.jsx";
import { TpaQueuePanel } from "../features/fleet/TpaQueuePanel.jsx";

// Wave 13 stub (lane F wiring): lane S4 replaces this with the TPA gate (WDyPY) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function GatePage() {
  return (
    <section className="main-grid">
      <div className="grid-col-12 fleet-queue-stack">
        <TpaQueuePanel />
        <StaggerSimulatorPanel />
      </div>
    </section>
  );
}
