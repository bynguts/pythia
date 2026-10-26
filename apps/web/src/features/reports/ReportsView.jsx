import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, Camera, Download, FileText, MessageCircle, Send, Wrench } from "lucide-react";
import { apiPost } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Card } from "../../shared/ui/Card.jsx";
import { DataTable } from "../../shared/ui/DataTable.jsx";
import { ErrorState } from "../../shared/ui/ErrorState.jsx";
import { OfflineBanner } from "../../shared/ui/OfflineBanner.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";
import { useConsole } from "../../app/console/useConsole.js";
import { clockTime, loadReports } from "./reportsData.js";
import "./reports.css";

const POLL_MS = 60000;

function fill(template, values) {
  return Object.entries(values).reduce((text, [key, v]) => text.replaceAll(`{${key}}`, v), template);
}

// wave13 Reports (y3BicK): the day's close. Every figure is a record on this server or a
// stored plan; a figure the day has not produced reads "—", never zero.
export function ReportsView() {
  const { t, lang } = useLanguage();
  const { setSubtitle } = useConsole();
  const locale = localeFor(lang);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loadedAt, setLoadedAt] = useState(null);
  const [sent, setSent] = useState(false);

  const load = useCallback(() => {
    loadReports()
      .then((next) => {
        setData(next);
        setLoadedAt(clockTime(new Date().toISOString()));
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const today = data?.today;
  const shortDate = (iso, options) => new Date(`${iso}T12:00:00+07:00`).toLocaleDateString(locale, options);
  useEffect(() => {
    if (!today) return undefined;
    setSubtitle(
      fill(t("s5_rp_crumb"), {
        date: new Date(`${today}T12:00:00+07:00`).toLocaleDateString(locale, {
          weekday: "short",
          day: "numeric",
          month: "short",
        }),
      }),
    );
    return () => setSubtitle(null);
  }, [today, lang, locale, t, setSubtitle]);

  if (!data) {
    return (
      <div className="rp" data-testid="reports-page">
        <header className="rp-title">
          <div>
            <h1>{t("s5_rp_title")}</h1>
            <p>{t("s5_rp_sub")}</p>
          </div>
        </header>
        {failed ? (
          <ErrorState
            title={t("s5_rp_load_failed")}
            reason={t("s5_rp_load_reason")}
            onRetry={load}
            testId="reports-error"
          />
        ) : (
          <Skeleton rows={5} label={t("s5_rp_loading")} />
        )}
      </div>
    );
  }

  const { recap, days, exceptions, carried, backtest } = data;
  const number = (value, digits = 0) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: digits });
  const tons = (value) => (value == null ? "—" : `${number(value, value >= 100 ? 0 : 1)} t`);
  const plannedTrips = recap.forecast.planned_trips;
  const trips = recap.actual.ritasi;
  const planPct = plannedTrips && trips != null ? Math.round((trips / plannedTrips) * 100) : null;
  const gate = recap.gate_wait;
  const handled = exceptions.filter((row) => row.state === "handled").length;
  const open = exceptions.length - handled;
  const lines = recap.summary_lines?.[lang] || recap.summary_lines?.en || [];
  const tomorrowPlan = carried.plan;
  const tomorrowName = shortDate(data.tomorrow, { weekday: "short" });
  const tomorrowLine = tomorrowPlan
    ? fill(t("s5_rp_sum_tomorrow"), {
        t: data.tomorrowTons == null ? "—" : number(data.tomorrowTons),
        time: clockTime(tomorrowPlan.approved_at) || "—",
      })
    : t("s5_rp_sum_tomorrow_pending");
  const bullets = [...lines, tomorrowLine];
  const longDate = shortDate(today, { weekday: "long", day: "numeric", month: "short" });
  const shareText = [
    fill(t("s5_rp_share_head"), { date: longDate }),
    ...bullets.map((line) => `- ${line}`),
  ].join("\n");

  // The summary goes to the alert group through the gateway. When that cannot deliver (no
  // group chosen, gateway down, a role without dispatch:create), WhatsApp opens with the text
  // ready and the operator picks the chat.
  async function shareWhatsApp() {
    try {
      await apiPost("/whatsapp/summary", { text: shareText, lang });
      setSent(true);
    } catch {
      window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank", "noopener,noreferrer");
    }
  }

  async function downloadPdf() {
    const node = document.createElement("section");
    const title = document.createElement("h1");
    title.textContent = fill(t("s5_rp_share_head"), { date: longDate });
    const list = document.createElement("ul");
    for (const line of bullets) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    node.append(title, list);
    try {
      const { default: html2pdf } = await import("html2pdf.js");
      await html2pdf()
        .set({
          margin: 14,
          filename: `pythia-day-close-${today}.pdf`,
          html2canvas: { scale: 2 },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(node)
        .save();
    } catch {
      const url = URL.createObjectURL(new Blob([shareText], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `pythia-day-close-${today}.txt`;
      link.click();
      URL.revokeObjectURL(url);
    }
  }

  // Chart: pilot fleet, planned vs weighed, last 7 days. A side with no value draws no bar.
  const peak = Math.max(
    1,
    ...days.flatMap(({ recap: day }) => [day?.forecast.planned_tons || 0, day?.actual.receipt_tons || 0]),
  );
  const barHeight = (value) => (value ? `${Math.max(2, Math.round((value / peak) * 100))}%` : "0");
  const plannedToday = recap.forecast.planned_tons;
  const weighedToday = recap.actual.receipt_tons;
  const partial = recap.delta.delta_basis === "partial_receipts";
  let chartNote = t("s5_rp_chart_note_none");
  if (plannedToday != null && weighedToday != null) {
    const exact = !partial && recap.delta.pct != null;
    chartNote = fill(t(exact ? "s5_rp_chart_note_both" : "s5_rp_chart_note_partial"), {
      p: number(plannedToday, 1),
      w: number(weighedToday, 1),
      d: exact ? `${recap.delta.pct > 0 ? "+" : ""}${number(recap.delta.pct, 1)}` : "",
    });
  } else if (plannedToday != null || weighedToday != null) {
    chartNote = fill(t("s5_rp_chart_note_one"), { p: tons(plannedToday), w: tons(weighedToday) });
  }

  const resolution = (row) => {
    if (row.note) return row.note;
    if (row.kind === "damage")
      return t(row.state === "handled" ? "s5_rp_state_resolved" : "s5_rp_state_open");
    return t(`s5_rp_state_${row.state}`);
  };

  const columns = [
    {
      key: "at",
      label: t("s5_rp_ex_time"),
      width: 84,
      render: (row) => <span className="rp-dim">{clockTime(row.at)}</span>,
    },
    {
      key: "what",
      label: t("s5_rp_ex_what"),
      width: 270,
      render: (row) => (
        <span className="rp-strong">
          {t(`s5_rp_kind_${row.kind}`)}
          {row.kind === "damage" && row.detail ? `: ${row.detail}` : ""}
        </span>
      ),
    },
    { key: "truck", label: t("s5_rp_ex_truck"), width: 96, render: (row) => row.truck || "—" },
    {
      key: "resolution",
      label: t("s5_rp_ex_resolution"),
      render: (row) => <span className="rp-res">{resolution(row)}</span>,
    },
  ];

  const missing = recap.evidence.stops_missing_evidence;

  return (
    <div className="rp" data-testid="reports-page" data-date={recap.date}>
      {failed && <OfflineBanner since={loadedAt} />}
      {sent && (
        <p className="rp-sent" role="status" data-testid="reports-sent">
          {t("s5_rp_sent")}
        </p>
      )}
      <header className="rp-title">
        <div>
          <h1>{t("s5_rp_title")}</h1>
          <p>{t("s5_rp_sub")}</p>
        </div>
        <div className="rp-title-actions">
          <Button
            variant="primary"
            icon={Send}
            onClick={shareWhatsApp}
            title={t("s5_rp_wa_title")}
            data-testid="reports-send"
          >
            {t("s5_rp_send")}
          </Button>
        </div>
      </header>

      <section className="rp-stats" aria-label={t("s5_rp_kpis_label")} data-testid="recap-list">
        <div className="rp-stat" data-testid="recap-trips">
          <span className="rp-stat-k">{t("s5_rp_trips")}</span>
          <strong className="rp-stat-v">
            {trips
              ? plannedTrips
                ? fill(t("s5_rp_trips_value"), { n: number(trips), m: number(plannedTrips) })
                : number(trips)
              : "—"}
          </strong>
          <span className="rp-stat-n">
            {!trips
              ? t("s5_rp_trips_none")
              : planPct != null
                ? fill(t("s5_rp_trips_plan"), { p: number(planPct) })
                : t("s5_rp_trips_noplan")}
          </span>
        </div>
        <div className="rp-stat" data-testid="recap-actual">
          <span className="rp-stat-k">{t("s5_rp_tonnes")}</span>
          <strong className="rp-stat-v">{tons(weighedToday)}</strong>
          <span className="rp-stat-n">
            {weighedToday == null
              ? t("s5_rp_tonnes_none")
              : plannedToday == null
                ? t("s5_rp_tonnes_noplan")
                : fill(t(partial ? "s5_rp_tonnes_partial" : "s5_rp_tonnes_plan"), {
                    n: number(plannedToday, 1),
                  })}
          </span>
        </div>
        <div className="rp-stat" data-testid="recap-gate-wait">
          <span className="rp-stat-k">{t("s5_rp_gate")}</span>
          <strong className="rp-stat-v">
            {gate.mean_min == null ? "—" : `${number(gate.mean_min)} ${t("s5_rp_min")}`}
          </strong>
          <span className="rp-stat-n">
            {gate.mean_min == null
              ? t("s5_rp_gate_none")
              : fill(t("s5_rp_gate_sub"), { n: number(gate.max_min) })}
          </span>
        </div>
        <div className="rp-stat" data-testid="recap-error">
          <span className="rp-stat-top">
            <span className="rp-stat-k">{t("s5_rp_error")}</span>
            <Tag
              tone="model"
              title={backtest ? fill(t("s5_rp_error_hint"), { period: backtest.period }) : undefined}
            >
              {t("s5_rp_error_model")}
            </Tag>
          </span>
          <strong className="rp-stat-v" data-provenance="model">
            {backtest?.mape_model_pct == null ? "—" : `${number(backtest.mape_model_pct, 1)}%`}
          </strong>
          <span className="rp-stat-n">
            {backtest?.period && backtest.period !== "unavailable"
              ? fill(t("s5_rp_error_sub_period"), { period: backtest.period.replace("..", "–") })
              : t("s5_rp_error_sub")}
          </span>
        </div>
      </section>

      <div className="rp-body">
        <div className="rp-left">
          <section className="rp-chart" aria-labelledby="rp-chart-title" data-testid="reports-chart">
            <header>
              <h2 id="rp-chart-title">{t("s5_rp_chart_title")}</h2>
              <span className="rp-key">
                <i className="is-planned" />
                {t("s5_rp_chart_planned")}
              </span>
              <span className="rp-key">
                <i className="is-weighed" />
                {t("s5_rp_chart_weighed")}
              </span>
            </header>
            <div className="rp-bars" role="img" aria-label={t("s5_rp_chart_label")}>
              {days.map(({ date, recap: day }, index) => {
                const planned = day?.forecast.planned_tons;
                const weighed = day?.actual.receipt_tons;
                return (
                  <div className="rp-bar-day" key={date} title={`${tons(planned)} / ${tons(weighed)}`}>
                    <div className="rp-bar-pair">
                      <span
                        className="rp-bar is-planned"
                        data-provenance="model"
                        style={{ height: barHeight(planned) }}
                      />
                      <span
                        className="rp-bar is-weighed"
                        data-provenance="field"
                        style={{ height: barHeight(weighed) }}
                      />
                    </div>
                    <span className={`rp-bar-name${index === days.length - 1 ? " is-today" : ""}`}>
                      {shortDate(date, { weekday: "short" })}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="rp-note">{chartNote}</p>
          </section>

          <Card
            title={t("s5_rp_ex_title")}
            titleId="rp-ex-title"
            aside={fill(t("s5_rp_ex_count"), { h: number(handled), o: number(open) })}
            flush
            data-testid="reports-exceptions"
          >
            <DataTable
              className="rp-table"
              caption={t("s5_rp_ex_title")}
              columns={columns}
              rows={exceptions}
              rowKey={(row) => row.key}
              empty={<p className="rp-empty">{t("s5_rp_ex_empty")}</p>}
            />
          </Card>
        </div>

        <div className="rp-right">
          <section className="rp-summary" aria-labelledby="rp-sum-title" data-testid="recap-summary">
            <header>
              <FileText size={15} className="rp-summary-icon" aria-hidden="true" />
              <h2 id="rp-sum-title">{t("s5_rp_sum_title")}</h2>
              <Tag>{t("s5_rp_sum_draft")}</Tag>
            </header>
            <div className="rp-summary-body">
              <h3>{longDate}</h3>
              <ul>
                {bullets.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
            <footer>
              <Button
                variant="primary"
                size="sm"
                icon={MessageCircle}
                onClick={shareWhatsApp}
                title={t("s5_rp_wa_title")}
              >
                {t("s5_rp_whatsapp")}
              </Button>
              <Button size="sm" icon={Download} onClick={downloadPdf} data-testid="reports-pdf">
                {t("s5_rp_pdf")}
              </Button>
            </footer>
          </section>

          <Card title={t("s5_rp_carry_title")} titleId="rp-carry-title" flush data-testid="reports-carried">
            <ul className="rp-carry">
              {carried.workshop.map((item) => (
                <li key={item.key}>
                  <span className="rp-carry-icon" aria-hidden="true">
                    <Wrench size={16} />
                  </span>
                  <span>
                    <strong>{fill(t("s5_rp_carry_workshop"), { truck: item.truck })}</strong>
                    <small>{fill(t("s5_rp_carry_workshop_sub"), { component: item.component })}</small>
                  </span>
                </li>
              ))}
              {missing > 0 && (
                <li>
                  <span className="rp-carry-icon" aria-hidden="true">
                    <Camera size={16} />
                  </span>
                  <span>
                    <strong>
                      {fill(t(missing === 1 ? "s5_rp_carry_proof_one" : "s5_rp_carry_proof"), {
                        n: number(missing),
                      })}
                    </strong>
                    <small>{t("s5_rp_carry_proof_sub")}</small>
                  </span>
                </li>
              )}
              <li>
                <span className="rp-carry-icon" aria-hidden="true">
                  <CalendarCheck size={16} />
                </span>
                <span>
                  <strong>
                    {fill(t(tomorrowPlan ? "s5_rp_carry_plan" : "s5_rp_carry_plan_pending"), {
                      day: tomorrowName,
                    })}
                  </strong>
                  <small>
                    {tomorrowPlan
                      ? fill(t("s5_rp_carry_plan_sub"), { time: clockTime(tomorrowPlan.approved_at) || "—" })
                      : t("s5_rp_carry_plan_pending_sub")}
                  </small>
                </span>
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
