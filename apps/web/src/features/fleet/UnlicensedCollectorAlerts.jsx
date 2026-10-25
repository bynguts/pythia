import { useState, useEffect } from "react";
import { ScanSearch } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { AttentionAction, AttentionRow } from "./AttentionRow.jsx";

export function getDistrictFromCoords(lat, lng) {
  if (lat > -6.18 && lng < 106.78) return "Cengkareng, Jakbar";
  if (lat > -6.18 && lng >= 106.78 && lng < 106.86) return "Kemayoran, Jakpus";
  if (lat > -6.18 && lng >= 106.86) return "Tanjung Priok, Jakut";
  if (lat <= -6.18 && lat > -6.23 && lng < 106.82) return "Kebon Jeruk, Jakbar";
  if (lat <= -6.18 && lat > -6.23 && lng >= 106.82) return "Jatinegara, Jaktim";
  if (lat <= -6.23 && lng >= 106.85) return "Pasar Rebo, Jaktim";
  if (lat <= -6.23 && lng < 106.85) return "Pasar Minggu, Jaksel";
  return "DKI Jakarta Area";
}

// Teardown v4 F12: unlicensed collectors are an alert type in "Perlu tindakan", one row
// per flag with one primary action. Nothing flagged: nothing rendered.
export function UnlicensedCollectorAlerts() {
  const { t } = useLanguage();
  const [flags, setFlags] = useState([]);
  const [resolved, setResolved] = useState({});

  useEffect(() => {
    const load = () =>
      apiFetch("/ai/unlicensed-flags")
        .then((r) => r.json())
        .then((body) => setFlags(body.flags || []))
        .catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, []);

  if (flags.length === 0) return null;
  const mark = (id, value) => setResolved((prev) => ({ ...prev, [id]: value }));

  return (
    <ul className="ui-list action-list unlicensed-list" data-testid="unlicensed-alerts">
      {flags.map((f) => {
        const state = resolved[f.collector_id];
        return (
          <AttentionRow
            key={f.collector_id}
            className="unlicensed-row"
            data-testid="unlicensed-row"
            tone={state === "verified" ? "success" : "warning"}
            icon={ScanSearch}
            title={t("w10fleet_unlicensed_title")}
            meta={`${getDistrictFromCoords(f.lat, f.lng)} · ${t("w10fleet_unlicensed_detail")
              .replace("{min}", Math.round(f.duration_min))
              .replace("{m}", Math.round(f.nearest_site_m))
              .replace("{p}", Math.round(f.confidence * 100))}`}
          >
            <span className="prov prov-sim prov-bare">{t("w10fleet_unlicensed_badge")}</span>
            <div className="attn-actions">
              {state ? (
                <span className="action-row-resolved">
                  {t(state === "verified" ? "w10fleet_verified" : "w10fleet_marked_safe")}
                </span>
              ) : (
                <>
                  <AttentionAction onClick={() => mark(f.collector_id, "verified")}>
                    {t("w10fleet_verify")}
                  </AttentionAction>
                  <AttentionAction quiet onClick={() => mark(f.collector_id, "safe")}>
                    {t("w10fleet_mark_safe")}
                  </AttentionAction>
                </>
              )}
            </div>
          </AttentionRow>
        );
      })}
    </ul>
  );
}
