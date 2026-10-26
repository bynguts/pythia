import { ReadinessList } from "../features/fleet/ReadinessList.jsx";

// Wave 13 stub (lane F wiring): lane S2 replaces this with the Morning readiness (AfFy7) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function ReadinessPage() {
  return (
    <section className="main-grid">
      <div className="grid-col-12">
        <ReadinessList />
      </div>
    </section>
  );
}
