// Clock and duration formatting shared by Morning readiness and Fleet & drivers.
const JAKARTA = "Asia/Jakarta";

// "HH:MM" in Jakarta time for an ISO timestamp, or null when it is missing or unparseable.
export function clockTime(iso) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: JAKARTA,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

// "12 h 10", "0 h", "9 h 40" from minutes ("12 j 10" with the Indonesian unit); "—" when unknown.
export function formatDuty(minutes, unit = "h") {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} ${unit} ${String(rest).padStart(2, "0")}` : `${hours} ${unit}`;
}

// The two-digit tag in the driver chip: the digits of "Driver 19", else the initials.
export function driverTag(name) {
  if (!name) return "";
  const digits = String(name).match(/\d+/);
  if (digits) return digits[0].slice(-2).padStart(2, "0");
  return String(name)
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Today's date as YYYY-MM-DD in Jakarta.
export function jakartaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: JAKARTA }).format(new Date());
}
