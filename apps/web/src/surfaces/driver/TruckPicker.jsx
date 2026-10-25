import { useMemo, useState } from "react";
import { Search, Truck } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";

const MAX_RESULTS = 6;
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
    return String(d.name || "")
      .toLowerCase()
      .includes(raw)
      ? 3
      : -1;
  };
  return drivers
    .map((d) => ({ d, r: rank(d) }))
    .filter((m) => m.r >= 0)
    .sort((a, b) => a.r - b.r || a.d.code.localeCompare(b.d.code))
    .map((m) => m.d);
}

// L2: the shared demo account types its truck code (or searches by name)
// instead of scrolling a 59-row roster. A personal account never sees this:
// its truck comes from the session.
export function TruckPicker({ drivers, onPick }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const recent = useMemo(() => {
    const known = new Map(drivers.map((d) => [d.code, d]));
    return readRecentTrucks().map((d) => known.get(d.code) || d);
  }, [drivers]);
  const matches = useMemo(() => matchTrucks(drivers, query), [drivers, query]);
  const shown = matches.slice(0, MAX_RESULTS);
  const typed = query.trim().toUpperCase();
  // Offline before the roster ever loaded: a typed code is still usable.
  const offlineCode = drivers.length === 0 && /^[A-Z]{1,3}-?\d{1,4}$/.test(typed) ? typed : null;

  const pickButton = (d) => (
    <li key={d.code} data-testid={`pick-${d.code}`}>
      <button type="button" className="driver-pick" onClick={() => onPick(d)}>
        <span>
          <strong>{d.code}</strong>
          <small>{d.name}</small>
        </span>
        <Truck size={18} />
      </button>
    </li>
  );

  return (
    <div className="driver-truck-picker">
      <label className="driver-label" htmlFor="driver-truck-search">
        {t("drv10_pick_label")}
      </label>
      <div className="driver-search">
        <Search size={18} aria-hidden="true" />
        <input
          id="driver-truck-search"
          className="driver-input"
          data-testid="driver-truck-search"
          type="search"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("drv10_pick_placeholder")}
        />
      </div>
      <p className="driver-muted">{t("drv10_pick_hint")}</p>

      {query.trim() ? (
        <>
          <ul className="driver-pick-list" aria-label={t("drv10_pick_results_label")}>
            {shown.map(pickButton)}
          </ul>
          {matches.length > shown.length && (
            <p className="driver-muted" data-testid="driver-pick-more">
              {t("drv10_pick_more").replace("{n}", matches.length - shown.length)}
            </p>
          )}
          {drivers.length > 0 && matches.length === 0 && (
            <p className="driver-muted" role="status" data-testid="driver-pick-none">
              {t("drv10_pick_none")}
            </p>
          )}
          {offlineCode && (
            <div className="driver-actions">
              <button
                type="button"
                className="driver-btn ghost"
                data-testid="driver-pick-typed"
                onClick={() => onPick({ code: offlineCode, name: offlineCode })}
              >
                {t("drv10_pick_offline_use").replace("{code}", offlineCode)}
              </button>
            </div>
          )}
        </>
      ) : (
        recent.length > 0 && (
          <>
            <p className="driver-label">{t("drv10_pick_recent")}</p>
            <ul className="driver-pick-list" data-testid="driver-pick-recent">
              {recent.map(pickButton)}
            </ul>
          </>
        )
      )}
      {drivers.length === 0 && !offlineCode && <p className="driver-muted">{t("drv_gate_loading")}</p>}
    </div>
  );
}
