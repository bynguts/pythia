import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { DataTable } from "../../shared/ui/DataTable.jsx";
import { ErrorState } from "../../shared/ui/ErrorState.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";
import { exportAuditLog } from "./auditExport.js";

const STEM = (name) => name.replace(/\.[^.]+$/, "");
const LABEL = {
  real: { tone: "real", key: "s5_set_label_real" },
  proxy: { tone: "warn", key: "s5_set_label_proxy" },
  derived: { tone: "model", key: "s5_set_label_model" },
  modeled_from_real_baseline: { tone: "model", key: "s5_set_label_model" },
  calibrated_synthetic: { tone: "neutral", key: "s5_set_label_simulated" },
};

// wave13 Settings, Data and provenance (T6NMuR): one row per source, with the label it
// earns. Rows come from GET /data/provenance; the three systems below them are Pythia's own
// model and the live inputs that the registry does not list.
export function ProvenancePanel() {
  const { t } = useLanguage();
  const [records, setRecords] = useState(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    apiGet("/data/provenance", { signal: controller.signal })
      .then((body) => setRecords(Array.isArray(body.records) ? body.records : []))
      .catch((error) => error?.name !== "AbortError" && setFailed(true));
    return () => controller.abort();
  }, [reload]);

  async function runExport() {
    setExporting("busy");
    try {
      await exportAuditLog();
      setExporting(null);
    } catch (error) {
      setExporting(error?.status === 403 ? "forbidden" : "failed");
    }
  }

  // A source without a friendly name keeps its file name and its granularity.
  const named = (key, original) => {
    const text = t(key);
    return text === key ? original : text;
  };
  const rows = [
    ...(records || []).map((record) => ({
      key: record.name,
      source: named(`s5_src_${STEM(record.name)}`, record.name),
      feeds: named(`s5_src_${STEM(record.name)}_feeds`, record.granularity),
      label: LABEL[record.classification] || { tone: "neutral", key: "s5_set_label_unknown" },
      fresh: `${record.as_of} · ${t(`s5_set_fresh_${record.freshness}`)}`,
    })),
    {
      key: "prophet",
      source: t("s5_set_sys_model"),
      feeds: t("s5_set_sys_model_feeds"),
      label: LABEL.derived,
      fresh: "—",
    },
    {
      key: "open-meteo",
      source: t("s5_set_sys_weather"),
      feeds: t("s5_set_sys_weather_feeds"),
      label: { tone: "live", key: "s5_set_label_live" },
      fresh: t("s5_set_sys_weather_fresh"),
    },
    {
      key: "driver-app",
      source: t("s5_set_sys_driver"),
      feeds: t("s5_set_sys_driver_feeds"),
      label: { tone: "field", key: "s5_set_label_field" },
      fresh: t("s5_set_sys_driver_fresh"),
    },
  ];
  const columns = [
    {
      key: "source",
      label: t("s5_set_col_source"),
      width: 260,
      render: (row) => <span className="st-strong">{row.source}</span>,
    },
    {
      key: "feeds",
      label: t("s5_set_col_feeds"),
      width: 240,
      render: (row) => <span className="st-mid">{row.feeds}</span>,
    },
    {
      key: "label",
      label: t("s5_set_col_label"),
      width: 130,
      render: (row) => <Tag tone={row.label.tone}>{t(row.label.key)}</Tag>,
    },
    {
      key: "fresh",
      label: t("s5_set_col_fresh"),
      render: (row) => <span className="st-dim">{row.fresh}</span>,
    },
  ];

  return (
    <div className="st-group" data-testid="settings-provenance">
      <header className="st-head st-head-row">
        <div>
          <h2>{t("s5_set_prov_title")}</h2>
          <p>{t("s5_set_prov_sub")}</p>
        </div>
        <Button
          size="sm"
          icon={Download}
          disabled={exporting === "busy"}
          onClick={runExport}
          data-testid="export-audit-log"
        >
          {t("s5_set_export")}
        </Button>
      </header>
      {exporting === "forbidden" && (
        <p className="st-note" role="status">
          {t("s5_set_export_forbidden")}
        </p>
      )}
      {exporting === "failed" && (
        <p className="st-note" role="alert">
          {t("s5_set_export_failed")}
        </p>
      )}
      {failed ? (
        <ErrorState
          title={t("s5_set_prov_failed")}
          reason={t("s5_set_failed_reason")}
          onRetry={() => setReload((count) => count + 1)}
        />
      ) : !records ? (
        <Skeleton rows={4} />
      ) : (
        <div className="st-table">
          <DataTable
            caption={t("s5_set_prov_title")}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.key}
          />
        </div>
      )}
    </div>
  );
}
