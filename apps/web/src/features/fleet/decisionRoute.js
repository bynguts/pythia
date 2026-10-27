import { localeFor } from "../../shared/i18n/index.jsx";

// Teardown v4 M3: a decision has one route (one name, one ETA, one source). The decision
// card, the map line and the truck drawer all read it through these helpers.

// Metres → "850 m" / "25,6 km" in the active locale (V4: never raw metres in EN).
export function formatDistance(meters, lang) {
  const value = Number(meters) || 0;
  if (value >= 1000) {
    return `${(value / 1000).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 })} km`;
  }
  return `${Math.round(value)} m`;
}

export function decisionRoute(alert) {
  return alert?.recommended_routes?.[0] || null;
}

// Only a computed route has a road line worth drawing; a scenario route is numbers only.
export function drawableRoute(route) {
  return route && route.source !== "scenario" && (route.path?.length || 0) >= 2 ? route : null;
}

export function routeName(t, route) {
  if (!route) return "";
  const key = `w10fleet_route_${route.code}`;
  return route.code && t(key) !== key ? t(key) : route.name;
}

export function routeSource(t, route) {
  const key = `w10fleet_route_source_${route?.source}`;
  return t("w10fleet_route_source").replace("{s}", t(key) !== key ? t(key) : route?.source || "—");
}

// What an ETA is (OSRM road duration, a fixed-speed fallback, or simulated), by
// the backend's eta_source key. No key, no label.
const ETA_SOURCE_KEYS = {
  osrm_duration: "w12_eta_osrm",
  fallback_estimate: "w12_eta_fallback",
  simulated: "w12_eta_sim",
};

export function etaSourceLabel(t, source) {
  return ETA_SOURCE_KEYS[source] ? t(ETA_SOURCE_KEYS[source]) : null;
}

export function routeMeta(t, route, lang) {
  const etaSource = etaSourceLabel(t, route?.eta_source);
  const meta =
    route?.distance_km == null
      ? t("w10fleet_route_meta_eta").replace("{eta}", route?.eta_minutes)
      : t("w10fleet_route_meta")
          .replace("{eta}", route.eta_minutes)
          .replace(
            "{km}",
            Number(route.distance_km).toLocaleString(localeFor(lang), { maximumFractionDigits: 1 }),
          );
  return etaSource ? `${meta} · ${etaSource}` : meta;
}

// Backend alert prose ("T-047 deviated from assigned corridor") becomes locale copy.
// Unknown alert types keep the backend's own title and description.
export function alertTitle(t, alert) {
  if (alert?.type === "fleet_damage") return t("w10fleet_alert_damage");
  if (alert?.type === "route_deviation") return t("w10fleet_alert_deviation");
  if (alert?.type === "driver_exception") return t(`drv10_exc_${alert.kind}`);
  return alert?.title || "";
}

export function alertDetail(t, alert, lang) {
  if (alert?.type === "fleet_damage") return t("w10fleet_alert_damage_detail");
  if (alert?.type === "driver_exception") return alert.note || t("w10fleet_exc_badge");
  if (alert?.type !== "route_deviation") return alert?.description || "";
  if (alert.sustained) return t("w10fleet_alert_sustained_detail");
  if (alert.distance_meters != null) {
    return t("w10fleet_alert_deviation_detail").replace("{d}", formatDistance(alert.distance_meters, lang));
  }
  return alert.description || "";
}
