import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, MessageCircle, Play, Sparkles } from "lucide-react";
import { useConsole } from "../../app/console/useConsole.js";
import { ApiError, apiGet, apiPost } from "../../shared/api/client.js";
import { apiErrorText } from "../../shared/api/errorText.js";
import { whatsappLanguage } from "../../shared/api/whatsappLanguage.js";
import { localeFor, translate, useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { DataTable } from "../../shared/ui/DataTable.jsx";
import { EmptyState } from "../../shared/ui/EmptyState.jsx";
import { ErrorState } from "../../shared/ui/ErrorState.jsx";
import { OfflineBanner } from "../../shared/ui/OfflineBanner.jsx";
import { Segmented } from "../../shared/ui/Segmented.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { StatusDot } from "../../shared/ui/StatusDot.jsx";
import { formatDriverName } from "../../shared/format/driverName.js";
import { clockTime, driverTag, formatDuty } from "./clock.js";
import {
  PRETRIP_ITEM_KEYS,
  isRemindable,
  legendCounts,
  planFor,
  reminderSummary,
  reminderText,
  rowAction,
  sortTrucks,
} from "./readinessModel.js";
import "./readiness.css";

const POLL_MS = 30000;
const OVERRIDE_MIN = 10;

const fill = (text, values) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value ?? ""), text);

// Backend detail is English: coded refusals are translated, plain detail shows in English mode only.
function reasonOf(lang, error, fallback) {
  return error instanceof ApiError ? apiErrorText(lang, error, fallback) : fallback;
}

export function ReadinessScreen() {
  const { t, lang } = useLanguage();
  const { permissions } = useConsole();
  const [board, setBoard] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(null);
  const [open, setOpen] = useState(undefined); // undefined = the first swappable row, null = none
  const [plans, setPlans] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reason, setReason] = useState("");
  const alive = useRef(true);

  const can = (permission) => permissions.includes(permission);
  const canDispatch = can("dispatch:create");
  const canPlan = can("operations:plan") || can("operations:approve");
  const canGrant = can("spj:override");

  const load = useCallback(async (signal) => {
    try {
      const body = await apiGet("/readiness?scope=plan", { signal });
      if (!alive.current) return;
      setBoard(body);
      setLoadedAt(clockTime(new Date().toISOString()));
      setFailed(false);
    } catch (error) {
      if (error?.name !== "AbortError" && alive.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    load(controller.signal);
    const id = setInterval(() => load(controller.signal), POLL_MS);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(id);
    };
  }, [load]);

  useEffect(() => {
    if (!canPlan) return undefined;
    const controller = new AbortController();
    apiGet("/operations/plans?status=approved&limit=100", { signal: controller.signal })
      .then(setPlans)
      .catch(() => setPlans([]));
    return () => controller.abort();
  }, [canPlan]);

  const sorted = useMemo(() => (board ? sortTrucks(board.trucks) : []), [board]);
  const counts = board?.counts;
  const needs = sorted.filter((truck) => !truck.ready);
  const readyRows = sorted.filter((truck) => truck.ready);
  const activeTab = tab || (needs.length ? "needs" : "all");

  // Backups are handed out in row order, so two damaged trucks never get the same one.
  const backups = useMemo(() => {
    const pool = [...(board?.backup_candidates || [])];
    const map = {};
    for (const truck of sorted) {
      if (!truck.ready && truck.damage?.heavy && truck.blockers.includes("damage_open") && pool.length) {
        map[truck.truck_code] = pool.shift();
      }
    }
    return map;
  }, [board, sorted]);

  const shown = activeTab === "needs" ? needs : activeTab === "ready" ? readyRows : sorted;
  const remindable = needs.filter(isRemindable);
  const activatable = readyRows.filter((truck) => truck.spj.status === "draft" && truck.spj.spj_id);
  const legend = board ? legendCounts(board) : null;

  const swapCode = needs.find((truck) => backups[truck.truck_code] && canPlan)?.truck_code ?? null;
  const openCode = open === undefined ? swapCode : open?.code;
  const openKind = open === undefined ? (swapCode ? "swap" : null) : open?.kind;

  const say = (tone, text) => setNotice({ tone, text });
  const time = (iso) => clockTime(iso);

  // A reminder is a private message to one truck's driver: the driver app inbox, plus a
  // private WhatsApp when the driver's number is on file (POST /api/driver/messages).
  async function sendReminder(truck, wl) {
    const { issue, recommendation } = reminderText(truck, (key) => translate(wl, key));
    await apiPost("/driver/messages", {
      truck_code: truck.truck_code,
      text: `${issue}. ${recommendation}.`,
      kind: "message",
      source: "console",
    });
  }

  // Each driver gets their own reminder; the alert group gets one list of every truck
  // (POST /api/whatsapp/summary) when an alert group is chosen.
  async function remindAll() {
    setBusy("remind");
    const wl = await whatsappLanguage();
    let done = 0;
    for (let i = 0; i < remindable.length; i += 6) {
      const batch = remindable.slice(i, i + 6).map((truck) => sendReminder(truck, wl));
      done += (await Promise.allSettled(batch)).filter((r) => r.status === "fulfilled").length;
    }
    let group = "s2_msg_group_sent";
    try {
      const text = reminderSummary(remindable, (key) => translate(wl, key));
      await apiPost("/whatsapp/summary", { text, lang: wl });
    } catch (error) {
      group = error?.status === 409 ? "s2_msg_group_none" : "s2_msg_group_failed";
    }
    setBusy(null);
    if (!done) say("danger", t("s2_msg_none"));
    else say("ok", `${fill(t("s2_msg_sent"), { n: done, m: remindable.length })} ${t(group)}`);
  }

  async function messageOne(truck) {
    setBusy(`msg:${truck.truck_code}`);
    try {
      await sendReminder(truck, await whatsappLanguage());
      say("ok", fill(t("s2_msg_one"), { truck: truck.truck_code }));
    } catch (error) {
      say("danger", reasonOf(lang, error, t("s2_msg_none")));
    }
    setBusy(null);
  }

  async function activateAll() {
    setBusy("activate");
    let done = 0;
    const failures = [];
    for (const truck of activatable) {
      try {
        await apiPost(`/spj/${truck.spj.spj_id}/activate`, {});
        done += 1;
      } catch (error) {
        failures.push(`${truck.truck_code}: ${reasonOf(lang, error, t("s2_act_failed"))}`);
      }
    }
    setBusy(null);
    const base = fill(t("s2_act_done"), { n: done, m: activatable.length });
    say(
      failures.length ? "warn" : "ok",
      failures.length ? `${base} ${failures.slice(0, 2).join(" · ")}` : base,
    );
    load();
  }

  async function swap(truck, backup) {
    const plan = planFor(plans || [], board.date, truck.truck_code);
    if (!plan) {
      say("danger", t("s2_swap_no_plan"));
      return;
    }
    setBusy(`swap:${truck.truck_code}`);
    try {
      await apiPost(`/operations/${plan.planId}/reassign`, {
        from_truck: truck.truck_code,
        to_truck: backup.truck_code,
        reason: t("s2_swap_reason"),
      });
      say("ok", fill(t("s2_swap_done"), { from: truck.truck_code, to: backup.truck_code }));
      setOpen(null);
      load();
    } catch (error) {
      say("danger", fill(t("s2_swap_failed"), { reason: reasonOf(lang, error, "") }));
    }
    setBusy(null);
  }

  async function submitOverride(truck) {
    setBusy(`ovr:${truck.truck_code}`);
    try {
      if (canGrant) {
        await apiPost("/safety/override", { truck_code: truck.truck_code, reason: reason.trim() });
        say("ok", fill(t("s2_ovr_granted"), { truck: truck.truck_code }));
      } else {
        await apiPost("/alert/follow-up", {
          alert_id: `duty-${truck.truck_code}`,
          status: "OPEN",
          note: reason.trim(),
        });
        say("ok", fill(t("s2_ovr_requested"), { truck: truck.truck_code }));
      }
      setReason("");
      setOpen(null);
      load();
    } catch (error) {
      say("danger", reasonOf(lang, error, t("s2_ovr_failed")));
    }
    setBusy(null);
  }

  const toggle = (truck, kind) => {
    setReason("");
    setOpen(openCode === truck.truck_code && openKind === kind ? null : { code: truck.truck_code, kind });
  };

  const listFormat = new Intl.ListFormat(localeFor(lang), { type: "conjunction" });

  // A cell whose item is among the truck's blockers is marked, so the reason is visible in the row.
  const flagged = (truck, prefix, node) =>
    truck.blockers.some((blocker) => blocker.startsWith(prefix)) ? (
      <span className="rdy-fail" data-testid="readiness-fail">
        {node}
      </span>
    ) : (
      node
    );

  const pretripCell = (truck) => flagged(truck, "pretrip", pretripCellRaw(truck));

  function pretripCellRaw(truck) {
    const failedItems = truck.pretrip.failed_items || [];
    if (failedItems.length) {
      const first = PRETRIP_ITEM_KEYS[failedItems[0]] ? t(PRETRIP_ITEM_KEYS[failedItems[0]]) : failedItems[0];
      const label = fill(t("s2_pre_failed"), { item: first });
      return (
        <StatusDot tone="danger">
          {label}
          {failedItems.length > 1 && ` +${failedItems.length - 1}`}
        </StatusDot>
      );
    }
    if (truck.pretrip.done) {
      return (
        <StatusDot tone="ok">
          {fill(t("s2_pre_done"), { time: time(truck.pretrip.at) ?? "" }).trim()}
        </StatusDot>
      );
    }
    return <StatusDot tone="warn">{t("s2_pre_not_started")}</StatusDot>;
  }

  const dutyCell = (truck) => flagged(truck, "duty", dutyCellRaw(truck));

  function dutyCellRaw(truck) {
    const { minutes, state, override, source } = truck.duty;
    if (minutes == null) return <span className="rdy-muted">—</span>;
    const text = formatDuty(minutes, t("lx_unit_h"));
    const simulated = source === "simulated";
    const tone = state === "blocked" ? "danger" : state === "warn" ? "warn" : "ok";
    const label =
      state === "blocked" ? fill(t(override ? "s2_duty_override" : "s2_duty_blocked"), { t: text }) : text;
    return (
      <span
        data-provenance={simulated ? "simulated" : undefined}
        title={simulated ? t("s2_prov_duty") : undefined}
      >
        <StatusDot tone={tone}>{label}</StatusDot>
      </span>
    );
  }

  const instructionCell = (truck) => flagged(truck, "instruction", instructionCellRaw(truck));

  function instructionCellRaw(truck) {
    const { status, updated_at: at } = truck.instruction;
    const stamp = time(at);
    if (status === "acknowledged")
      return <StatusDot tone="ok">{fill(t("s2_ins_confirmed"), { time: stamp ?? "" }).trim()}</StatusDot>;
    if (status === "pending")
      return (
        <StatusDot tone="warn">
          {stamp ? fill(t("s2_ins_sent"), { time: stamp }) : t("s2_ins_sent_plain")}
        </StatusDot>
      );
    if (status === "issue") return <StatusDot tone="danger">{t("s2_ins_issue")}</StatusDot>;
    if (status === "reassigned") return <StatusDot tone="idle">{t("s2_ins_moved")}</StatusDot>;
    return <StatusDot tone="idle">{t("s2_ins_none")}</StatusDot>;
  }

  const spjCell = (truck) => flagged(truck, "spj", spjCellRaw(truck));

  function spjCellRaw(truck) {
    const { status, spj_number: number } = truck.spj;
    const map = {
      draft: ["idle", "s2_spj_draft"],
      aktif: ["ok", "s2_spj_active"],
      selesai: ["idle", "s2_spj_closed"],
    };
    const [tone, key] = map[status] || ["warn", "s2_spj_none"];
    return (
      <span title={number || undefined}>
        <StatusDot tone={tone}>{t(key)}</StatusDot>
      </span>
    );
  }

  const vehicleCell = (truck) => flagged(truck, "damage", vehicleCellRaw(truck));

  function vehicleCellRaw(truck) {
    const tone = truck.damage?.heavy ? "danger" : truck.damage?.open ? "warn" : "ok";
    const key = truck.damage?.heavy ? "s2_veh_major" : truck.damage?.open ? "s2_veh_minor" : "s2_veh_ok";
    return (
      <span title={truck.service?.due_soon ? t("s2_veh_service") : undefined}>
        <StatusDot tone={tone}>{t(key)}</StatusDot>
        {truck.service?.due_soon && <span className="rdy-service-dot" aria-label={t("s2_veh_service")} />}
      </span>
    );
  }

  function actionCell(truck) {
    const backup = backups[truck.truck_code];
    const action = rowAction(truck, {
      canSwap: canPlan,
      canMessage: canDispatch,
      canOverride: canDispatch || canGrant,
      hasBackup: Boolean(backup),
    });
    if (action === "ready")
      return <CheckCircle2 size={17} className="rdy-check" role="img" aria-label={t("s2_row_ready")} />;
    if (action === "swap")
      return (
        <Button
          variant="primary"
          size="sm"
          onClick={() => toggle(truck, "swap")}
          aria-expanded={openCode === truck.truck_code && openKind === "swap"}
          data-testid="readiness-swap"
        >
          {fill(t("s2_act_swap"), { truck: backup.truck_code })}
        </Button>
      );
    if (action === "override")
      return (
        <Button
          size="sm"
          onClick={() => toggle(truck, "override")}
          aria-expanded={openCode === truck.truck_code && openKind === "override"}
          data-testid="readiness-override"
        >
          {t(canGrant ? "s2_act_override_grant" : "s2_act_override")}
        </Button>
      );
    if (action === "message")
      return (
        <Button
          size="sm"
          icon={MessageCircle}
          disabled={busy === `msg:${truck.truck_code}`}
          onClick={() => messageOne(truck)}
          data-testid="readiness-whatsapp"
        >
          {t("s2_act_remind")}
        </Button>
      );
    return (
      <Button
        size="sm"
        onClick={() => toggle(truck, "details")}
        aria-expanded={openCode === truck.truck_code && openKind === "details"}
      >
        {t("s2_act_details")}
      </Button>
    );
  }

  function expandedRow(truck) {
    if (openCode !== truck.truck_code || !openKind) return null;
    if (openKind === "swap") {
      const backup = backups[truck.truck_code];
      if (!backup) return null;
      const plan = planFor(plans || [], board.date, truck.truck_code);
      const what = [t("s2_swap_w_instruction")];
      if (plan?.stops) what.push(fill(t("s2_swap_w_trips"), { n: plan.stops }));
      if (plan?.slotStart) what.push(fill(t("s2_swap_w_slot"), { time: plan.slotStart }));
      const at = time(backup.pretrip_at);
      return (
        <div className="rdy-panel" data-testid="readiness-swap-card">
          <Sparkles size={16} aria-hidden="true" className="rdy-panel-icon" />
          <div className="rdy-panel-text">
            <strong>
              {fill(t(at ? "s2_swap_title" : "s2_swap_title_untimed"), {
                truck: backup.truck_code,
                time: at,
              })}
            </strong>
            <span>
              {fill(t("s2_swap_body"), {
                what: listFormat.format(what),
                to: backup.truck_code,
                driver: formatDriverName(backup.driver_name, t).label,
                from: truck.truck_code,
              })}
            </span>
          </div>
          <div className="rdy-panel-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy === `swap:${truck.truck_code}` || !plan}
              onClick={() => swap(truck, backup)}
              data-testid="readiness-swap-confirm"
            >
              {t("s2_swap_confirm")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
              {t("s2_cancel")}
            </Button>
          </div>
        </div>
      );
    }
    if (openKind === "override") {
      const valid = reason.trim().length >= OVERRIDE_MIN;
      return (
        <form
          className="rdy-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) submitOverride(truck);
          }}
        >
          <div className="rdy-panel-text">
            <label htmlFor={`rdy-reason-${truck.truck_code}`}>
              <strong>{fill(t("s2_ovr_label"), { truck: truck.truck_code })}</strong>
            </label>
            <input
              id={`rdy-reason-${truck.truck_code}`}
              className="rdy-input"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              autoFocus
            />
            <span>{t(canGrant ? "s2_ovr_hint_grant" : "s2_ovr_hint_request")}</span>
          </div>
          <div className="rdy-panel-actions">
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={!valid || busy === `ovr:${truck.truck_code}`}
            >
              {t(canGrant ? "s2_ovr_grant" : "s2_ovr_send")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
              {t("s2_cancel")}
            </Button>
          </div>
        </form>
      );
    }
    return (
      <div className="rdy-panel">
        <div className="rdy-panel-text">
          <strong>{fill(t("s2_details_title"), { truck: truck.truck_code })}</strong>
          <span>{truck.blockers.map((blocker) => t(`w12_blocker_${blocker}`)).join(" · ")}</span>
        </div>
        <div className="rdy-panel-actions">
          <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
            {t("s2_cancel")}
          </Button>
        </div>
      </div>
    );
  }

  const columns = [
    {
      key: "truck",
      label: t("s2_col_truck"),
      width: "15%",
      render: (truck) => (
        <span className="rdy-truck">
          <strong className="ui-code">{truck.truck_code}</strong>
          {truck.zone && (
            <small
              data-provenance={truck.zone_classification === "SIMULATED" ? "simulated" : undefined}
              title={truck.zone_classification === "SIMULATED" ? t("s2_prov_zone") : undefined}
            >
              {truck.zone}
            </small>
          )}
          {!truck.ready && truck.blockers.length > 0 && (
            <small className="rdy-why" data-testid="readiness-why">
              {truck.blockers.map((blocker) => t(`w12_blocker_${blocker}`)).join(" · ")}
            </small>
          )}
        </span>
      ),
    },
    {
      key: "driver",
      label: t("s2_col_driver"),
      width: "15%",
      render: (truck) => {
        if (!truck.driver_name) return <span className="rdy-muted">—</span>;
        const driver = formatDriverName(truck.driver_name, t);
        return (
          <span
            className="rdy-driver"
            data-provenance={driver.simulated ? "simulated" : undefined}
            title={driver.title}
          >
            <span className="rdy-chip" aria-hidden="true">
              {driver.number ?? driverTag(truck.driver_name)}
            </span>
            {driver.label}
          </span>
        );
      },
    },
    { key: "pretrip", label: t("s2_col_pretrip"), width: "15%", render: pretripCell },
    { key: "duty", label: t("s2_col_duty"), width: "14%", render: dutyCell },
    { key: "instruction", label: t("s2_col_instruction"), width: "15%", render: instructionCell },
    { key: "spj", label: t("s2_col_spj"), width: "10%", render: spjCell },
    { key: "vehicle", label: t("s2_col_vehicle"), width: "16%", render: vehicleCell },
    {
      key: "action",
      label: <span className="sr-only">{t("s2_col_action")}</span>,
      align: "right",
      render: actionCell,
    },
  ];

  const first = board?.first_departure;
  const subParts = [];
  if (first?.depart_at) subParts.push(fill(t("s2_rdy_sub_departure"), { time: first.depart_at }));
  if (board) {
    subParts.push(fill(t("s2_rdy_sub_ready"), { ready: counts.ready, total: board.trucks.length }));
  }

  let body;
  if (!board && failed) {
    body = (
      <ErrorState
        title={t("s2_rdy_error_title")}
        reason={t("s2_error_reason")}
        onRetry={() => load()}
        testId="readiness-error"
      />
    );
  } else if (!board) {
    body = <Skeleton rows={6} />;
  } else {
    const hiddenReady = activeTab === "needs" ? readyRows.length : 0;
    body = (
      <section className="rdy-card" aria-label={t("s2_rdy_title")}>
        <DataTable
          className="rdy-table"
          testId="readiness-list"
          caption={t("s2_rdy_title")}
          columns={columns}
          rows={shown}
          rowKey={(truck) => truck.truck_code}
          rowTone={(truck) => (!truck.ready && openCode === truck.truck_code ? "danger" : undefined)}
          expanded={expandedRow}
          empty={
            <EmptyState
              title={t(activeTab === "needs" ? "s2_rdy_empty_title" : "s2_rdy_none_title")}
              body={t(activeTab === "needs" ? "s2_rdy_empty_body" : "s2_rdy_none_body")}
            />
          }
        />
        <footer className="rdy-foot">
          <span>
            {t("s2_foot_sorted")}
            {hiddenReady > 0 && ` · ${fill(t("s2_foot_more"), { n: hiddenReady })}`}
          </span>
          {hiddenReady > 0 && (
            <button type="button" className="rdy-link" onClick={() => setTab("all")}>
              {fill(t("s2_foot_show_all"), { n: sorted.length })}
            </button>
          )}
        </footer>
      </section>
    );
  }

  return (
    <div className="rdy" data-testid="readiness-page" data-scope={board?.scope_used}>
      {failed && board && <OfflineBanner since={loadedAt} />}
      <div className="rdy-titlerow">
        <div className="rdy-titles">
          <h1>{t("s2_rdy_title")}</h1>
          <p>{subParts.join(" · ")}</p>
          {board?.scope_used === "fleet" && <p className="rdy-scope">{t("s2_rdy_scope_fleet")}</p>}
        </div>
        <div className="rdy-actions">
          <Button
            icon={MessageCircle}
            disabled={!canDispatch || !remindable.length || busy === "remind"}
            onClick={remindAll}
            data-testid="readiness-remind"
          >
            {fill(t(remindable.length === 1 ? "s2_rdy_remind_one" : "s2_rdy_remind"), {
              n: remindable.length,
            })}
          </Button>
          <Button
            variant="primary"
            icon={Play}
            disabled={!canDispatch || !activatable.length || busy === "activate"}
            onClick={activateAll}
            data-testid="readiness-activate"
          >
            {fill(t(activatable.length === 1 ? "s2_rdy_activate_one" : "s2_rdy_activate"), {
              n: activatable.length,
            })}
          </Button>
        </div>
      </div>

      {board && (
        <div className="rdy-filters">
          <Segmented
            label={t("s2_rdy_filter_label")}
            value={activeTab}
            onChange={setTab}
            options={[
              {
                value: "needs",
                label: t("s2_tab_needs"),
                count: needs.length,
                testId: "readiness-tab-needs",
              },
              {
                value: "ready",
                label: t("s2_tab_ready"),
                count: readyRows.length,
                testId: "readiness-tab-ready",
              },
              { value: "all", label: t("s2_tab_all"), count: sorted.length, testId: "readiness-tab-all" },
            ]}
          />
          <ul className="rdy-legend" aria-label={t("s2_legend_label")}>
            <li>
              <StatusDot tone="ok">{fill(t("s2_leg_ready"), { n: legend.ready })}</StatusDot>
            </li>
            {legend.pretrip > 0 && (
              <li>
                <StatusDot tone="warn">{fill(t("s2_leg_pretrip"), { n: legend.pretrip })}</StatusDot>
              </li>
            )}
            {legend.notRoadworthy > 0 && (
              <li>
                <StatusDot tone="danger">
                  {fill(t("s2_leg_roadworthy"), { n: legend.notRoadworthy })}
                </StatusDot>
              </li>
            )}
            {legend.dutyBlock > 0 && (
              <li>
                <StatusDot tone="danger">{fill(t("s2_leg_duty"), { n: legend.dutyBlock })}</StatusDot>
              </li>
            )}
            {legend.unread > 0 && (
              <li>
                <StatusDot tone="warn">{fill(t("s2_leg_unread"), { n: legend.unread })}</StatusDot>
              </li>
            )}
          </ul>
        </div>
      )}

      <p
        className={`rdy-notice${notice ? ` is-${notice.tone}` : ""}`}
        role="status"
        aria-live="polite"
        data-testid="readiness-notice"
      >
        {notice?.text}
      </p>

      {body}
    </div>
  );
}
