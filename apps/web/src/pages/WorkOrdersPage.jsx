import { SpjPanel } from "../features/fleet/SpjPanel.jsx";

// Wave 13 stub (lane F wiring): lane S4 replaces this with the Work orders (GKQWY) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function WorkOrdersPage() {
  return (
    <section className="main-grid">
      <div className="grid-col-12">
        <SpjPanel />
      </div>
    </section>
  );
}
