import { useMemo, useState } from "react";
import { Plus, Wrench } from "lucide-react";
import { useConsole } from "../../app/console/useConsole.js";
import { apiPost } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Card } from "../../shared/ui/Card.jsx";
import { DataTable } from "../../shared/ui/DataTable.jsx";
import { EmptyState } from "../../shared/ui/EmptyState.jsx";
import { ErrorState } from "../../shared/ui/ErrorState.jsx";
import { OfflineBanner } from "../../shared/ui/OfflineBanner.jsx";
import { Kpi, KpiStrip } from "../../shared/ui/KpiStrip.jsx";
import { Segmented } from "../../shared/ui/Segmented.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { StatusDot } from "../../shared/ui/StatusDot.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";
import { formatDriverName } from "../../shared/format/driverName.js";
import { driverTag, formatDuty } from "../readiness/clock.js";
import { PRETRIP_ITEM_KEYS } from "../readiness/readinessModel.js";
import { BookServiceDrawer, LogDamageDrawer } from "./FleetForms.jsx";
import {
  ON_TIME_OK_PCT,
  PROOF_OK_PCT,
  bookedByTruck,
  damageStats,
  dueLabel,
  dutyRows,
  isMajor,
  sinceLabel,
  weekdayLabel,
} from "./fleetModel.js";
import { useApi } from "./useApi.js";
import "./fleet.css";

const fill = (text, values) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value ?? ""), text);

const SOURCE_KEYS = {
  pretrip: "s2_src_pretrip",
  driver_pwa: "s2_src_driver",
  dispatcher: "s2_src_dispatcher",
};

function DriverChip({ name }) {
  const { t } = useLanguage();
  const driver = formatDriverName(name, t);
  return (
    <span
      className="flt-driver"
      data-provenance={driver.simulated ? "simulated" : undefined}
      title={driver.title}
    >
      <span className="flt-chip" aria-hidden="true">
        {driver.number ?? driverTag(name)}
      </span>
      {driver.label}
    </span>
  );
}

function Bar({ value, max = 100, tone = "ok", children }) {
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <span className="flt-track" aria-hidden="true">
      <span className={`flt-fill is-${tone}`} style={{ transform: `scaleX(${share})` }} />
      {children}
    </span>
  );
}

export function FleetScreen() {
  const { t, lang } = useLanguage();
  const { permissions } = useConsole();
  const locale = localeFor(lang);
  const canDispatch = permissions.includes("dispatch:create");
  const canHistory = permissions.includes("history:read");

  const overview = useApi("/fleet/status-overview", { pollMs: 60000 });
  const analytics = useApi("/fleet/driver-analytics", { pollMs: 60000 });
  const damage = useApi("/damage-reports", { pollMs: 15000 });
  const due = useApi("/service-records/due-soon?days=7");
  const records = useApi("/service-records");
  const safety = useApi("/safety/overview");
  const week = useApi("/fleet/drivers-week?days=7", { enabled: canHistory, pollMs: 120000 });

  const [tab, setTab] = useState("open");
  const [form, setForm] = useState(null); // "damage" | "service" | null
  const [notice, setNotice] = useState("");

  const trucks = useMemo(() => analytics.data?.drivers || [], [analytics.data]);
  const driverByTruck = useMemo(
    () => Object.fromEntries(trucks.map((truck) => [truck.truck_code, truck.driver_name])),
    [trucks],
  );
  const driverCount = new Set(trucks.map((truck) => truck.driver_name).filter(Boolean)).size;

  const total = overview.data?.total_trucks ?? null;
  const hold = overview.data?.by_activity?.maintenance_hold ?? null;
  const stats = damageStats(damage.data?.reports || [], total);
  const booked = useMemo(() => bookedByTruck(records.data?.records || []), [records.data]);
  const duty = useMemo(() => dutyRows(safety.data, driverByTruck), [safety.data, driverByTruck]);
  const counts = safety.data?.counts;
  const dutyAlerts = counts ? counts.duty_warn + counts.duty_blocked : null;
  const warnMin = safety.data?.warn_at_minutes;
  const blockMin = safety.data?.block_at_minutes;
  const scaleMax = blockMin ? blockMin + 60 : null;
  const dutySimulated = safety.data?.classification === "SIMULATED";

  const subParts = [];
  if (total != null) subParts.push(fill(t("s2_flt_trucks"), { n: total }));
  if (total != null && hold != null) {
    subParts.push(fill(t("s2_flt_on_shift"), { n: total - hold }));
    subParts.push(fill(t("s2_flt_workshop"), { n: hold }));
  }
  if (trucks.length) subParts.push(fill(t("s2_flt_drivers"), { n: driverCount }));

  const refresh = () => {
    damage.reload();
    due.reload();
    records.reload();
    overview.reload();
  };
  const saved = (text) => {
    setForm(null);
    setNotice(text);
    refresh();
  };
  async function resolve(report) {
    try {
      await apiPost(`/damage-reports/${report.report_id}/resolve`, {});
      setNotice(fill(t("s2_dmg_fixed"), { truck: report.truck_code }));
      refresh();
    } catch {
      setNotice(t("s2_form_failed"));
    }
  }

  const rows = tab === "open" ? stats.open : stats.fixedThisWeek;
  const issueText = (report) => {
    const key = PRETRIP_ITEM_KEYS[report.component];
    const part = key ? t(key) : report.component;
    return report.note || part;
  };
  const damageColumns = [
    {
      key: "truck",
      label: t("s2_col_truck"),
      width: "12%",
      render: (r) => <strong className="ui-code">{r.truck_code}</strong>,
    },
    {
      key: "issue",
      label: t("s2_col_issue"),
      width: "28%",
      render: (r) => (
        <span className="flt-clip" title={issueText(r)}>
          {issueText(r)}
        </span>
      ),
    },
    {
      key: "severity",
      label: t("s2_col_severity"),
      width: "13%",
      render: (r) => (
        <StatusDot tone={isMajor(r) ? "danger" : "warn"}>
          {t(isMajor(r) ? "s2_sev_major" : "s2_sev_minor")}
        </StatusDot>
      ),
    },
    {
      key: "by",
      label: t("s2_col_reported_by"),
      width: "20%",
      render: (r) => {
        const source = SOURCE_KEYS[r.source] ? t(SOURCE_KEYS[r.source]) : r.source;
        return (
          <span className="flt-muted flt-clip">
            {r.source === "pretrip" && r.driver_name
              ? `${source} · ${formatDriverName(r.driver_name, t).label}`
              : source}
          </span>
        );
      },
    },
    {
      key: "since",
      label: t("s2_col_since"),
      width: "9%",
      render: (r) => (
        <span className="flt-muted">{sinceLabel(tab === "open" ? r.created_at : r.resolved_at, locale)}</span>
      ),
    },
    {
      key: "status",
      label: t("s2_col_status"),
      render: (r) => {
        if (r.status === "selesai") return t("s2_status_fixed");
        return booked[r.truck_code]
          ? fill(t("s2_status_booked"), { day: weekdayLabel(booked[r.truck_code], locale) })
          : t("s2_status_open");
      },
    },
    {
      key: "action",
      label: <span className="sr-only">{t("s2_col_action")}</span>,
      align: "right",
      render: (r) =>
        r.status === "baru" && canDispatch ? (
          <Button size="sm" onClick={() => resolve(r)} data-testid="damage-resolve">
            {t("s2_dmg_mark_fixed")}
          </Button>
        ) : null,
    },
  ];

  const weekRows = week.data?.drivers || [];
  const pct = (value) => (value == null ? "—" : `${Math.round(value)}%`);
  const weekColumns = [
    {
      key: "driver",
      label: t("s2_col_driver"),
      width: "26%",
      render: (d) => <DriverChip name={d.driver_name} />,
    },
    { key: "trips", label: t("s2_col_trips"), width: "12%", render: (d) => d.trips },
    {
      key: "ontime",
      label: t("s2_col_on_time"),
      width: "26%",
      render: (d) =>
        d.on_time_pct == null ? (
          <span className="flt-muted">—</span>
        ) : (
          <span className="flt-ontime">
            <Bar value={d.on_time_pct} tone={d.on_time_pct >= ON_TIME_OK_PCT ? "ok" : "warn"} />
            {pct(d.on_time_pct)}
          </span>
        ),
    },
    {
      key: "proof",
      label: t("s2_col_proof"),
      width: "18%",
      render: (d) => (
        <span
          className={
            d.proof_complete_pct != null && d.proof_complete_pct < PROOF_OK_PCT ? "flt-amber" : undefined
          }
        >
          {pct(d.proof_complete_pct)}
        </span>
      ),
    },
    {
      key: "duty",
      label: t("s2_col_avg_duty"),
      render: (d) => (
        <span className={warnMin && d.avg_duty_min >= warnMin ? "flt-amber" : undefined}>
          {formatDuty(d.avg_duty_min)}
        </span>
      ),
    },
  ];

  const dueList = due.data?.due || [];
  const sources = [overview, damage, due, safety];
  const noData = sources.every((source) => source.failed && !source.data);
  const stale = !noData && sources.some((source) => source.failed && source.data);
  const booting = sources.every((source) => !source.loaded);

  return (
    <div className="flt" data-testid="fleet-page">
      <div className="flt-titlerow">
        <div className="flt-titles">
          <h1>{t("s2_flt_title")}</h1>
          <p data-provenance="simulated" title={t("s2_prov_fleet")}>
            {subParts.join(" · ") || "—"}
          </p>
        </div>
        <div className="flt-actions">
          <Button
            icon={Wrench}
            disabled={!canDispatch}
            onClick={() => setForm("damage")}
            data-testid="log-damage"
          >
            {t("s2_log_damage")}
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            disabled={!canDispatch}
            onClick={() => setForm("service")}
            data-testid="book-service"
          >
            {t("s2_book_service")}
          </Button>
        </div>
      </div>

      {stale && <OfflineBanner />}
      <p className="flt-notice" role="status" aria-live="polite" data-testid="fleet-notice">
        {notice}
      </p>

      {noData ? (
        <ErrorState
          title={t("s2_flt_error_title")}
          reason={t("s2_error_reason")}
          onRetry={refresh}
          testId="fleet-error"
        />
      ) : booting ? (
        <Skeleton rows={5} />
      ) : (
        <>
          <KpiStrip label={t("s2_flt_kpis")} variant="surface" className="flt-kpis">
            <Kpi
              label={t("s2_kpi_roadworthy")}
              value={stats.roadworthy == null ? "—" : `${stats.roadworthy} / ${total}`}
              sub={damage.loaded ? fill(t("s2_kpi_roadworthy_sub"), { n: stats.openTruckCount }) : null}
              testId="fleet-kpi-roadworthy"
            />
            <Kpi
              label={t("s2_kpi_major")}
              value={damage.loaded ? stats.majorCount : "—"}
              sub={t("s2_kpi_major_sub")}
              testId="fleet-kpi-major"
            />
            <Kpi
              label={t("s2_kpi_service")}
              value={due.data ? due.data.count : "—"}
              sub={t("s2_kpi_service_sub")}
              testId="fleet-kpi-service"
            />
            <Kpi
              className={dutyAlerts ? "is-alert" : undefined}
              label={t("s2_kpi_duty")}
              value={dutyAlerts ?? "—"}
              sub={
                counts
                  ? fill(t("s2_kpi_duty_sub"), { n: counts.duty_blocked, h: Math.round(blockMin / 60) })
                  : null
              }
              testId="fleet-kpi-duty"
            />
          </KpiStrip>

          <div className="flt-grid">
            <div className="flt-col">
              <Card
                title={t("s2_dmg_title")}
                titleId="flt-dmg-title"
                flush
                actions={
                  <Segmented
                    label={t("s2_dmg_filter")}
                    value={tab}
                    onChange={setTab}
                    options={[
                      {
                        value: "open",
                        label: t("s2_tab_open"),
                        count: stats.open.length,
                        testId: "damage-tab-open",
                      },
                      {
                        value: "fixed",
                        label: t("s2_tab_fixed"),
                        count: stats.fixedThisWeek.length,
                        testId: "damage-tab-fixed",
                      },
                    ]}
                  />
                }
              >
                {!damage.loaded ? (
                  <Skeleton rows={3} />
                ) : (
                  <DataTable
                    testId="damage-table"
                    caption={t("s2_dmg_title")}
                    columns={damageColumns}
                    rows={rows}
                    rowKey={(r) => r.report_id}
                    empty={
                      <EmptyState
                        title={t(tab === "open" ? "s2_dmg_empty_title" : "s2_dmg_none_title")}
                        body={t("s2_dmg_empty_body")}
                      />
                    }
                  />
                )}
              </Card>

              <Card title={t("s2_week_title")} titleId="flt-week-title" aside={t("s2_week_aside")} flush>
                {!canHistory ? (
                  <p className="flt-empty">{t("s2_week_forbidden")}</p>
                ) : !week.loaded ? (
                  <Skeleton rows={3} />
                ) : week.failed && !week.data ? (
                  <p className="flt-empty">{t("s2_week_failed")}</p>
                ) : (
                  <div className="flt-scroll">
                    <DataTable
                      testId="drivers-week"
                      caption={t("s2_week_title")}
                      columns={weekColumns}
                      rows={weekRows}
                      rowKey={(d) => d.driver_name}
                      sticky
                      empty={<EmptyState title={t("s2_week_empty_title")} body={t("s2_week_empty_body")} />}
                    />
                  </div>
                )}
              </Card>
            </div>

            <div className="flt-col">
              <Card
                title={t("s2_duty_title")}
                titleId="flt-duty-title"
                aside={
                  warnMin
                    ? fill(t("s2_duty_aside"), {
                        warn: Math.round(warnMin / 60),
                        stop: Math.round(blockMin / 60),
                      })
                    : null
                }
                flush
              >
                <ul
                  className="flt-duty"
                  data-testid="duty-hours"
                  data-provenance={dutySimulated ? "simulated" : undefined}
                  title={dutySimulated ? t("s2_prov_duty") : undefined}
                >
                  {duty.length === 0 && (
                    <li className="flt-empty">{safety.loaded ? t("s2_duty_empty") : t("s2_loading")}</li>
                  )}
                  {duty.map((row) => {
                    const tone = row.state === "blocked" ? "danger" : row.state === "warn" ? "warn" : "ok";
                    return (
                      <li key={row.truck_code}>
                        <div className="flt-duty-line">
                          <span className="flt-duty-name">{formatDriverName(row.name, t).label}</span>
                          {row.state === "blocked" && (
                            <Tag tone="danger">
                              {t(row.override ? "s2_duty_override_tag" : "s2_duty_blocked_tag")}
                            </Tag>
                          )}
                          {row.state === "warn" && <Tag tone="warn">{t("s2_duty_relief")}</Tag>}
                          <span className={`flt-duty-time is-${tone}`}>{formatDuty(row.minutes)}</span>
                        </div>
                        <Bar value={row.minutes} max={scaleMax} tone={tone}>
                          <span
                            className="flt-mark"
                            style={{ left: `${(warnMin / scaleMax) * 100}%` }}
                            aria-hidden="true"
                          />
                          <span
                            className="flt-mark is-stop"
                            style={{ left: `${(blockMin / scaleMax) * 100}%` }}
                            aria-hidden="true"
                          />
                        </Bar>
                      </li>
                    );
                  })}
                </ul>
              </Card>

              <Card title={t("s2_due_title")} titleId="flt-due-title" aside={t("s2_due_aside")} flush>
                <ul className="flt-due" data-testid="service-due">
                  {dueList.length === 0 && (
                    <li className="flt-empty">{due.loaded ? t("s2_due_empty") : t("s2_loading")}</li>
                  )}
                  {dueList.map((item) => {
                    const tone = item.days_left < 0 ? "danger" : item.days_left <= 1 ? "warn" : "idle";
                    const label =
                      item.days_left < 0
                        ? t("s2_due_overdue")
                        : item.days_left === 0
                          ? t("s2_due_today")
                          : item.days_left === 1
                            ? t("s2_due_tomorrow")
                            : dueLabel(item.next_due_date, locale);
                    return (
                      <li key={`${item.truck_code}-${item.component}`}>
                        <strong>{item.truck_code}</strong>
                        <span className="flt-clip" title={item.component}>
                          {item.component}
                        </span>
                        <StatusDot tone={tone}>{label}</StatusDot>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}

      <LogDamageDrawer
        open={form === "damage"}
        onClose={() => setForm(null)}
        trucks={trucks}
        onSaved={saved}
      />
      <BookServiceDrawer
        open={form === "service"}
        onClose={() => setForm(null)}
        trucks={trucks}
        onSaved={saved}
      />
    </div>
  );
}
