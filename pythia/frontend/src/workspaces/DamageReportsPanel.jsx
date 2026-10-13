import React, { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config.js";
import { useLanguage } from "../i18n.jsx";

// #83: presentation-only translations. The API enums (`berat`, `baru`,
// `selesai`, …) stay stable on the wire; they are mapped to locale copy at
// render time through the catalog.
const SEVERITY_KEYS = { berat: "dmg_severity_berat", sedang: "dmg_severity_sedang", ringan: "dmg_severity_ringan" };
const STATUS_KEYS = { baru: "dmg_status_baru", diproses: "dmg_status_diproses", selesai: "dmg_status_selesai" };

export function DamageReportsPanel() {
  const { t, lang } = useLanguage();
  const [reports, setReports] = useState([]);

  const load = useCallback(() => {
    fetch(`${API_URL}/damage-reports`).then((r) => r.json())
      .then((body) => setReports(body.reports || [])).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const resolve = (id) => fetch(`${API_URL}/damage-reports/${id}/resolve`,
    { method: "POST" }).then(load).catch(() => {});

  const locale = lang === "id" ? "id-ID" : "en-US";
  const severityLabel = (value) => SEVERITY_KEYS[value] ? t(SEVERITY_KEYS[value]) : value;
  const statusLabel = (value) => STATUS_KEYS[value] ? t(STATUS_KEYS[value]) : value;

  return (
    <div className="panel-card damage-panel">
      <div className="panel-head">
        <h3>{t("dmg_title")}</h3>
        <span className="pill">{reports.length} {reports.length === 1 ? t("dmg_count") : t("dmg_count_plural")}</span>
      </div>
      {reports.length === 0 ? (
        <div className="ai-feed-empty">{t("dmg_empty")}</div>
      ) : (
        <div className="table-wrap" role="region" aria-label={t("dmg_region")} tabIndex={0}>
        <table className="spj-table">
          <thead>
            <tr>
              <th>{t("dmg_col_time")}</th><th>{t("dmg_col_truck")}</th><th>{t("dmg_col_driver")}</th><th>{t("dmg_col_component")}</th>
              <th>{t("dmg_col_severity")}</th><th>{t("dmg_col_note")}</th><th>{t("dmg_col_status")}</th><th>{t("dmg_col_action")}</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.report_id}>
                <td>{new Date(r.created_at).toLocaleString(locale)}</td>
                <td>{r.truck_code}</td>
                <td>{r.driver_name}</td>
                <td>{r.component}</td>
                <td>
                  <span className={`pill ${r.severity === "berat" ? "danger" : ""}`}>
                    {severityLabel(r.severity)}
                  </span>
                  {r.severity === "berat" && r.status !== "selesai" && (
                    <span className="pill danger">{t("dmg_non_operational")}</span>
                  )}
                </td>
                <td>{r.note}</td>
                <td>{statusLabel(r.status)}</td>
                <td>
                  {r.status !== "selesai" && (
                    <button className="compact-enforce-btn"
                      onClick={() => resolve(r.report_id)}>
                      {t("dmg_action_resolve")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
