// Twin deep-link contract:
// /twin?city=jakarta|hcmc&rain=<0..150 mm>&event=none|50k|100k&venue=<id>&day=<0..6>&scenario_day=<0..6>&present=1
// `day` is the selected day; `scenario_day` (written only when it differs) is the
// day the what-if applies to, default `day`.
// TwinWorkspace reads it on load (invalid values are ignored) and writes it back
// when the scenario changes; the assistant builds links with twinHref().
// Kept free of heavy imports: the XR chunk and the assistant import it too.

export const TWIN_CITIES = ["jakarta", "hcmc"];
// Crowd-event presets shared by the twin, the XR tabletop and the assistant card.
export const TWIN_EVENT_PRESETS = [
  { id: "none", attendance: 0 },
  { id: "50k", attendance: 50000 },
  { id: "100k", attendance: 100000 },
];
export const TWIN_EVENTS = TWIN_EVENT_PRESETS.map((preset) => preset.id);
// Event venues per city (same ids as the scene's `venues`); the first one is the default.
export const TWIN_VENUES = {
  jakarta: [
    { id: "gbk", name: "GBK", lat: -6.2183, lng: 106.8022 },
    { id: "jis", name: "JIS", lat: -6.1246, lng: 106.8584 },
    { id: "monas", name: "Monas", lat: -6.1754, lng: 106.8272 },
  ],
  hcmc: [{ id: "d1", name: "District 1", lat: 10.7769, lng: 106.7009 }],
};
const TWIN_RAIN_MAX = 150;
const TWIN_RAIN_STEP = 5;
const TWIN_DAY_MAX = 6;
const TWIN_DEFAULTS = { city: "jakarta", rain: 0, event: "none", day: 0 };

function parseRain(value) {
  if (value == null || value === "") return null;
  const rain = Number(value);
  if (!Number.isFinite(rain) || rain < 0 || rain > TWIN_RAIN_MAX) return null;
  return Math.round(rain / TWIN_RAIN_STEP) * TWIN_RAIN_STEP;
}

function parseDay(value) {
  if (value == null || value === "") return null;
  const day = Number(value);
  return Number.isInteger(day) && day >= 0 && day <= TWIN_DAY_MAX ? day : null;
}

/** Venues for a city: the scene's list when it sends one, else the built-in list. */
export function twinVenues(city, sceneVenues) {
  const valid = Array.isArray(sceneVenues)
    ? sceneVenues.filter((v) => v?.id && Number.isFinite(v.lat) && Number.isFinite(v.lng))
    : [];
  return valid.length ? valid : TWIN_VENUES[city] || TWIN_VENUES[TWIN_DEFAULTS.city];
}

/** A venue by id or name (case-insensitive) for a city, or the city's default venue. */
export function findTwinVenue(city, key, sceneVenues) {
  const venues = twinVenues(city, sceneVenues);
  const wanted = String(key || "").toLowerCase();
  return venues.find((v) => v.id === wanted || String(v.name).toLowerCase() === wanted) || venues[0];
}

function venueId(city, value) {
  return (TWIN_VENUES[city] || []).some((v) => v.id === value) ? value : null;
}

/** Scenario from a query string; any missing or invalid value falls back to the default. */
export function readTwinParams(search) {
  const query = new URLSearchParams(search);
  const city = TWIN_CITIES.includes(query.get("city")) ? query.get("city") : TWIN_DEFAULTS.city;
  const event = query.get("event");
  const day = parseDay(query.get("day")) ?? TWIN_DEFAULTS.day;
  return {
    city,
    rain: parseRain(query.get("rain")) ?? TWIN_DEFAULTS.rain,
    event: TWIN_EVENTS.includes(event) ? event : TWIN_DEFAULTS.event,
    venue: venueId(city, query.get("venue")) ?? TWIN_VENUES[city][0].id,
    day,
    scenarioDay: parseDay(query.get("scenario_day")) ?? day,
  };
}

/**
 * Write a scenario into a query string, keeping unrelated params (present,
 * lang, basemap…). Default rain/event/venue/day are left out so links stay short.
 */
export function withTwinParams(search, { city, rain, event, venue, day, scenarioDay }) {
  const query = new URLSearchParams(search);
  const cityValue = TWIN_CITIES.includes(city) ? city : TWIN_DEFAULTS.city;
  query.set("city", cityValue);
  const rainValue = parseRain(rain);
  if (rainValue) query.set("rain", String(rainValue));
  else query.delete("rain");
  if (TWIN_EVENTS.includes(event) && event !== "none") query.set("event", event);
  else query.delete("event");
  const venueValue = venueId(cityValue, venue);
  if (venueValue && venueValue !== TWIN_VENUES[cityValue][0].id) query.set("venue", venueValue);
  else query.delete("venue");
  const dayValue = parseDay(day);
  if (dayValue) query.set("day", String(dayValue));
  else query.delete("day");
  // Only a what-if has a day of its own, and only when it is not the selected day.
  const whatIfDay = parseDay(scenarioDay);
  if (
    (rainValue || (TWIN_EVENTS.includes(event) && event !== "none")) &&
    whatIfDay !== null &&
    whatIfDay !== (dayValue ?? 0)
  )
    query.set("scenario_day", String(whatIfDay));
  else query.delete("scenario_day");
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Shareable link into the twin, e.g. twinHref({ rain: 80, event: "50k", venue: "jis", day: 1, present: true }). */
export function twinHref({ city, rain, event, venue, day, scenarioDay, present } = {}) {
  const search = withTwinParams("", { city, rain, event, venue, day, scenarioDay });
  const query = new URLSearchParams(search);
  if (present) query.set("present", "1");
  return `/twin?${query}`;
}

// Per-day risk of a twin scene (teardown v3 fix 6), for the twin timeline and the
// XR day scrubber: the backend's `horizon.daily_districts_at_risk` (high or
// critical vs the normal day), with the worst level any district reaches that day.
const RISK_RANK = ["normal", "elevated", "high", "critical"];
export function dailyRisk(scene) {
  const dates = scene?.horizon?.dates || [];
  const counts = scene?.horizon?.daily_districts_at_risk;
  return dates.map((_, day) => {
    const rows = (scene?.districts || []).map((d) => d.series?.[day]).filter(Boolean);
    const worst = rows.reduce((best, row) => Math.max(best, RISK_RANK.indexOf(row.risk)), 0);
    const count = Number.isFinite(counts?.[day])
      ? counts[day]
      : rows.filter((row) => row.risk === "high" || row.risk === "critical").length;
    return { count, worst: RISK_RANK[worst] };
  });
}

// The model's rain_3d is a rolling 3-day sum (engine.RAIN_3D_WINDOW_DAYS): forecast
// rain of the two previous days still counts on a dry day (scene.weather.days[i]
// .carried_rain_mm; a what-if's rain is never carried). For a day without rain of
// its own, the carried millimetres, or null.
export function carriedRainMm(weather, day) {
  const today = weather?.days?.[day];
  if (!today || today.input === "scenario" || Number(today.rainfall_mm) > 0) return null;
  const carried = Number(today.carried_rain_mm);
  return Number.isFinite(carried) && carried > 0 ? carried : null;
}

// How the scene's rain effect is formed (scene.weather.rain_response), in the UI
// language: the model's monotone response and the planning rule it was trained on,
// or the demo city's stated assumption. `t` is the i18n lookup, `fmt` formats numbers.
export function rainResponseText(t, weather, fmt = String) {
  const response = weather?.rain_response;
  if (!response) return null;
  if (response.method === "assumption_capped") return t("ufx_rain_response_demo");
  const mm = response.rule_steps_mm || [];
  const pct = response.rule_steps_percent || [];
  const steps = mm
    .map((value, i) => t("ufx_rain_step").replace("{p}", fmt(pct[i])).replace("{mm}", fmt(value)))
    .join(", ");
  const text = t("ufx_rain_response")
    .replace("{steps}", steps)
    .replace("{top}", mm.length ? fmt(mm.at(-1)) : "");
  return response.beyond_training_range && Number.isFinite(response.held_at_mm)
    ? `${text} ${t("ufx_rain_held").replace("{n}", fmt(response.held_at_mm))}`
    : text;
}

// A day whose rain is beyond the training range: the effect is held at the
// training maximum (weather.days[i].beyond_training_range), else null.
export function rainHeldText(t, weather, day, fmt = String) {
  const held = weather?.rain_response?.held_at_mm ?? weather?.rain_response?.training_max_rain_mm;
  return weather?.days?.[day]?.beyond_training_range && Number.isFinite(held)
    ? t("ufx_rain_held").replace("{n}", fmt(held))
    : null;
}
