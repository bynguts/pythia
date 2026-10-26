// Roster helpers for the truck pick screen (TruckPickScreen in DriverScreens.jsx).
const RECENT_KEY = "pythia_driver_recent_trucks";

export function readRecentTrucks() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((d) => typeof d?.code === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecentTruck(driver) {
  const next = [driver, ...readRecentTrucks().filter((d) => d.code !== driver.code)].slice(0, 3);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // The shortcut list is a convenience only.
  }
}

// "47", "047", "t047" and "T-047" all find T-047; a name finds its driver.
// Ranked: the exact code, then codes ending or containing what was typed,
// then driver names, so the truck asked for is never pushed off the list.
export function matchTrucks(drivers, query) {
  const raw = String(query || "")
    .trim()
    .toLowerCase();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const compact = raw.replace(/[\s-]/g, "");
  const rank = (d) => {
    const code = d.code.toLowerCase();
    const codeCompact = code.replace(/[\s-]/g, "");
    const codeDigits = code.replace(/\D/g, "");
    const digitsOnly = Boolean(digits) && digits === raw;
    if (codeCompact === compact || (digitsOnly && Number(codeDigits) === Number(digits))) return 0;
    if (codeCompact.endsWith(compact) || (digitsOnly && codeDigits.endsWith(digits))) return 1;
    if (codeCompact.includes(compact) || (digitsOnly && codeDigits.includes(digits))) return 2;
    const plate = String(d.plate || "")
      .toLowerCase()
      .replace(/\s/g, "");
    if (plate && plate.includes(raw.replace(/\s/g, ""))) return 3;
    return String(d.name || "")
      .toLowerCase()
      .includes(raw)
      ? 4
      : -1;
  };
  return drivers
    .map((d) => ({ d, r: rank(d) }))
    .filter((m) => m.r >= 0)
    .sort((a, b) => a.r - b.r || a.d.code.localeCompare(b.d.code))
    .map((m) => m.d);
}
