import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { DataTable } from "../../shared/ui/DataTable.jsx";
import { EmptyState } from "../../shared/ui/EmptyState.jsx";
import { ErrorState } from "../../shared/ui/ErrorState.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { exportAuditLog } from "./auditExport.js";

const SHOWN = 100;
// Long free text stays out of the table; the export still carries it.
const SKIP = new Set(["msg", "message", "photo_b64"]);

function detail(payload) {
  return Object.entries(payload || {})
    .filter(([key, value]) => !SKIP.has(key) && value != null && typeof value !== "object" && value !== "")
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 60)}`)
    .join(" · ");
}

// wave13 Settings, Audit log: the operational event log (GET /history, history:read).
export function AuditLogPanel() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    apiGet("/history", { signal: controller.signal })
      .then(setEvents)
      .catch(
        (cause) => cause?.name !== "AbortError" && setError(cause?.status === 403 ? "forbidden" : "failed"),
      );
    return () => controller.abort();
  }, [reload]);

  const columns = [
    {
      key: "at",
      label: t("s5_set_audit_when"),
      width: 170,
      render: (row) => (
        <span className="st-dim">
          {new Date(row.created_at).toLocaleString(locale, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Jakarta",
          })}
        </span>
      ),
    },
    {
      key: "type",
      label: t("s5_set_audit_event"),
      width: 220,
      render: (row) => <span className="st-strong">{row.event_type.replaceAll("_", " ")}</span>,
    },
    {
      key: "detail",
      label: t("s5_set_audit_detail"),
      render: (row) => <span className="st-mid">{detail(row.payload) || "—"}</span>,
    },
  ];

  let body;
  if (error === "forbidden") {
    body = <EmptyState title={t("s5_set_audit_forbidden")} body={t("s5_set_audit_forbidden_body")} />;
  } else if (error) {
    body = (
      <ErrorState
        title={t("s5_set_audit_failed")}
        reason={t("s5_set_failed_reason")}
        onRetry={() => setReload((count) => count + 1)}
      />
    );
  } else if (!events) {
    body = <Skeleton rows={4} />;
  } else if (!events.length) {
    body = <EmptyState title={t("s5_set_audit_empty")} body={t("s5_set_audit_empty_body")} />;
  } else {
    body = (
      <div className="st-table">
        <DataTable
          caption={t("s5_set_audit_title")}
          columns={columns}
          rows={events.slice(0, SHOWN)}
          rowKey={(row) => `${row.created_at}-${row.event_type}-${detail(row.payload)}`}
        />
      </div>
    );
  }

  return (
    <div className="st-group" data-testid="settings-audit">
      <header className="st-head st-head-row">
        <div>
          <h2>{t("s5_set_audit_title")}</h2>
          <p>
            {events?.length
              ? t("s5_set_audit_sub").replace("{n}", String(Math.min(SHOWN, events.length)))
              : t("s5_set_audit_sub_idle")}
          </p>
        </div>
        <Button size="sm" icon={Download} onClick={() => exportAuditLog().catch(() => setError("failed"))}>
          {t("s5_set_export")}
        </Button>
      </header>
      {body}
    </div>
  );
}
