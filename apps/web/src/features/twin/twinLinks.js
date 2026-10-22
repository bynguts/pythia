// Twin deep-link contract:
// /twin?city=jakarta|hcmc&rain=<0..150 mm>&event=none|50k|100k&venue=<id>&day=<0..6>&present=1
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
  return {
    city,
    rain: parseRain(query.get("rain")) ?? TWIN_DEFAULTS.rain,
    event: TWIN_EVENTS.includes(event) ? event : TWIN_DEFAULTS.event,
    venue: venueId(city, query.get("venue")) ?? TWIN_VENUES[city][0].id,
    day: parseDay(query.get("day")) ?? TWIN_DEFAULTS.day,
  };
}

/**
 * Write a scenario into a query string, keeping unrelated params (present,
 * lang, basemap…). Default rain/event/venue/day are left out so links stay short.
 */
export function withTwinParams(search, { city, rain, event, venue, day }) {
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
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Shareable link into the twin, e.g. twinHref({ rain: 80, event: "50k", venue: "jis", day: 1, present: true }). */
export function twinHref({ city, rain, event, venue, day, present } = {}) {
  const search = withTwinParams("", { city, rain, event, venue, day });
  const query = new URLSearchParams(search);
  if (present) query.set("present", "1");
  return `/twin?${query}`;
}
