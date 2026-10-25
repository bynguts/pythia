// Plan dates are calendar days (YYYY-MM-DD) in the operator's local time.

export function localIsoDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Saturday or Sunday for a YYYY-MM-DD string, independent of the browser time zone.
export function isWeekendDate(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}
