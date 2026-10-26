import { apiGet } from "../../shared/api/client.js";

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

// The operational log (GET /history, history:read) as a CSV download. Phone numbers are
// masked by the server, so the export carries the same masked payloads the log shows.
export async function exportAuditLog() {
  const events = await apiGet("/history");
  const rows = ["created_at,event_type,payload"];
  for (const event of events) {
    rows.push(
      [event.created_at, event.event_type, JSON.stringify(event.payload ?? {})].map(csvCell).join(","),
    );
  }
  const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `pythia-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  return events.length;
}
