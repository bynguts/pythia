import { DailyRecapList } from "../features/fleet/DailyRecapList.jsx";

// Wave 13 stub (lane F wiring): lane S5 replaces this with the Reports (y3BicK) screen. Until
// then it shows the closest pre-redesign workspace inside the console shell.
export function ReportsPage() {
  return (
    <section className="main-grid">
      <div className="grid-col-12">
        <DailyRecapList />
      </div>
    </section>
  );
}
