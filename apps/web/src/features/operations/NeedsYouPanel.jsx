import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  Construction,
  Hourglass,
  Package,
  Route,
  Send,
  Siren,
  Sparkles,
  Timer,
  Wrench,
} from "lucide-react";
import { apiPost } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { EmptyState } from "../../shared/ui/EmptyState.jsx";
import { ErrorState } from "../../shared/ui/ErrorState.jsx";
import { Skeleton } from "../../shared/ui/Skeleton.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";
import { createAlertDispatch } from "../fleet/alertDispatch.js";
import { decisionRoute, formatDistance, routeName } from "../fleet/decisionRoute.js";
import { jakartaTime, minutesOfDay } from "./useOperations.js";

const FILTERS = ["all", "trucks", "gate", "tps"];
// Severity square per kind: icon and tint, as on the design's rows.
const KIND_LOOK = {
  deviation: { icon: Route, tone: "red" },
  accident: { icon: Siren, tone: "red" },
  truck_breakdown: { icon: Wrench, tone: "grey" },
  road_closed: { icon: Construction, tone: "amber" },
  tps_empty: { icon: Package, tone: "amber" },
  gate_peak: { icon: Hourglass, tone: "blue" },
  duty_warn: { icon: Timer, tone: "amber" },
  duty_blocked: { icon: Timer, tone: "red" },
};

function fill(text, values) {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text);
}

function hoursMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return { h: Math.floor(total / 60), mm: String(total % 60).padStart(2, "0") };
}

function slotEnd(start, minutes = 15) {
  const at = minutesOfDay(start);
  if (at == null) return "";
  const end = (at + minutes) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

function ago(iso, lang) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((Date.now() - at) / 60000);
  const format = new Intl.RelativeTimeFormat(localeFor(lang), { numeric: "auto" });
  return minutes < 60
    ? format.format(-Math.max(0, minutes), "minute")
    : format.format(-Math.round(minutes / 60), "hour");
}

function list(items, lang) {
  return new Intl.ListFormat(localeFor(lang), { type: "conjunction" }).format(items);
}

// Title, sub text, tag and the one action a row offers, by kind (bindings §1).
// Also used by the top bar's bell, which lists the same items in short.
export function describe(item, { t, lang, alert }) {
  const facts = item.facts || {};
  const truck = item.truck_code || "—";
  const followUp = facts.follow_up;
  switch (item.kind) {
    case "deviation": {
      const parts = [
        facts.distance_meters != null
          ? fill(t("s1_dev_sub"), { d: formatDistance(facts.distance_meters, lang) })
          : t("s1_dev_sub_plain"),
      ];
      // The human work-order number in its short form (SPJ-000001); never the internal spj_id hash.
      const spjSeq = /\/(\d+)$/.exec(facts.spj_number || "");
      if (spjSeq) parts.push(`SPJ-${spjSeq[1]}`);
      return {
        title: fill(t("s1_dev_title"), { truck }),
        sub: parts.join(" · "),
        action: "send_route",
        route: decisionRoute(alert),
      };
    }
    case "accident": {
      const escalated = followUp?.status === "DISPATCHED";
      const lead = facts.note || fill(t("s1_acc_reported"), { time: jakartaTime(new Date(item.created_at)) });
      return {
        title: fill(t("s1_acc_title"), { truck }),
        sub: escalated
          ? fill(t("s1_acc_escalated"), { time: jakartaTime(new Date(followUp.at)) })
          : `${lead} ${t("s1_acc_now")}`,
        action: escalated ? "mark_handled" : "escalate",
      };
    }
    case "truck_breakdown": {
      const suggestion = item.suggestion?.kind === "reassign" ? item.suggestion : null;
      return {
        title: fill(t("s1_brk_title"), { truck }),
        sub: suggestion
          ? fill(t("s1_brk_backup"), { to: suggestion.to_truck })
          : t(facts.plan_id ? "s1_brk_no_backup" : "s1_brk_no_plan"),
        action: suggestion ? "reassign" : "mark_handled",
        suggestion,
      };
    }
    case "road_closed":
      return {
        title: fill(t("s1_road_title"), { truck }),
        sub: facts.note || facts.stop_name || t("s1_road_sub"),
        action: "mark_handled",
      };
    case "tps_empty": {
      const reports = facts.reports || 1;
      const skippable = (item.actions || []).includes("skip_stop");
      const by = fill(t(reports === 1 ? "s1_tps_by_one" : "s1_tps_by"), { n: reports });
      return {
        title: fill(t("s1_tps_title"), { stop: facts.stop_name || t("s1_tps_unknown") }),
        tag: reports > 1 ? <Tag tone="neutral">×{reports}</Tag> : null,
        sub: skippable ? `${by} ${t("s1_tps_skip_hint")}` : by,
        action: skippable ? "skip_stop" : "mark_handled",
      };
    }
    case "gate_peak": {
      const holds = facts.holds || [];
      const minutes = holds.map((hold) => hold.hold_minutes);
      const same = minutes.every((value) => value === minutes[0]);
      return {
        title: fill(t("s1_gate_title"), { from: facts.slot, to: slotEnd(facts.slot) }),
        tag: (
          <Tag tone="model" title={t("s1_model_hint")} data-provenance="model">
            {t("s1_model")}
          </Tag>
        ),
        sub: fill(t(same ? "s1_gate_sub" : "s1_gate_sub_upto"), {
          trucks: list(
            holds.map((hold) => hold.truck_code),
            lang,
          ),
          n: Math.max(0, ...minutes),
        }),
        action: "accept",
      };
    }
    case "duty_warn":
    case "duty_blocked": {
      const duty = hoursMinutes(facts.duty_minutes);
      return {
        title: fill(t("s1_duty_title"), { truck, h: duty.h, mm: duty.mm }),
        sub: fill(t(item.kind === "duty_blocked" ? "s1_duty_blocked" : "s1_duty_warn"), {
          h: Math.round((facts.block_at_minutes || 0) / 60),
        }),
        action: "plan_relief",
      };
    }
    default:
      return { title: truck, sub: "", action: "mark_handled" };
  }
}

const ACTION_KEYS = {
  send_route: "s1_send_route",
  mark_handled: "s1_mark_handled",
  escalate: "s1_escalate",
  accept: "s1_accept",
  skip_stop: "s1_skip_stop",
  plan_relief: "s1_plan_relief",
  reassign: "s1_reassign",
};

/**
 * The floating "Needs you" panel: open items from GET /api/ops/needs-you, one action each.
 * @param {{
 *   feed: { data: any, error: any, reload: () => Promise<void> },
 *   alerts: any[],                // /command-center alerts: a deviation's computed reroute
 *   openId: string|null,          // the expanded deviation (its route is drawn on the map)
 *   onSelect: (id: string|null) => void,
 *   onFocusTruck: (code: string) => void,
 *   trucksOnRoute: number|null,   // for the empty state (simulated fleet)
 *   role: string|null
 * }} props
 */
export function NeedsYouPanel({ feed, alerts, openId, onSelect, onFocusTruck, trucksOnRoute, role }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [rowState, setRowState] = useState({});
  const [confirming, setConfirming] = useState(null);
  // Folded to its header so the dispatcher can see the map underneath.
  const [collapsed, setCollapsed] = useState(false);

  const data = feed.data;
  const counts = data?.counts || {};
  const items = (data?.items || []).filter((item) => filter === "all" || item.category === filter);
  const alertFor = (item) => (alerts || []).find((alert) => alert.id === item.id) || null;

  const setRow = (id, next) => setRowState((current) => ({ ...current, [id]: next }));

  async function run(item, work) {
    setRow(item.id, { busy: true });
    try {
      const done = await work();
      setRow(item.id, { done: done || null });
      await feed.reload();
    } catch (error) {
      setRow(item.id, { error: t(error?.status === 403 ? "s1_err_denied" : "s1_err_failed") });
    }
  }

  const followUp = (item, status, note = "") =>
    apiPost("/alert/follow-up", { alert_id: item.id, status, note, operator: role || "dispatcher" });

  function act(item, view) {
    const action = view.action;
    if (action === "plan_relief") {
      navigate("/app/fleet");
      return;
    }
    if (action === "reassign") {
      setConfirming(item.id);
      return;
    }
    run(item, async () => {
      if (action === "mark_handled") {
        await followUp(item, "RESOLVED");
      } else if (action === "escalate") {
        await followUp(item, "DISPATCHED", t("s1_escalate_note"));
        // The WhatsApp alert is best effort: the escalation is already on record.
        apiPost("/whatsapp/alert", {
          truck_code: item.truck_code,
          issue: fill(t("s1_acc_title"), { truck: item.truck_code }),
          recommendation: t("s1_escalate_note"),
        }).catch(() => {});
      } else if (action === "accept") {
        for (const hold of item.facts?.holds || []) {
          await apiPost(`/gate/slots/recommendations/${encodeURIComponent(hold.rec_id)}/accept`, {});
        }
      } else if (action === "skip_stop") {
        await apiPost(`/spj/${encodeURIComponent(item.spj_id)}/stops/${item.facts.stop_index}/skip`, {
          reason: fill(t("s1_skip_reason"), { n: item.facts.reports || 1 }),
        });
      } else if (action === "send_route") {
        const alert = alertFor(item);
        if (!alert) throw new Error("no alert");
        const response = await createAlertDispatch(alert, t);
        if (!response.ok) throw Object.assign(new Error("dispatch"), { status: response.status });
        await followUp(item, "DISPATCHED", t("s1_route_sent_note"));
        return fill(t("s1_route_sent"), { truck: item.truck_code });
      }
      return null;
    });
  }

  function reassign(item, suggestion) {
    setConfirming(null);
    run(item, async () => {
      await apiPost(`/operations/${encodeURIComponent(suggestion.plan_id)}/reassign`, {
        from_truck: suggestion.from_truck,
        to_truck: suggestion.to_truck,
        reason: fill(t("s1_reassign_reason"), { truck: suggestion.from_truck }),
      });
      await followUp(item, "RESOLVED", fill(t("s1_reassigned_note"), { to: suggestion.to_truck }));
      return null;
    });
  }

  function select(item) {
    onSelect(item.id === openId ? null : item.id);
    if (item.truck_code) onFocusTruck(item.truck_code);
  }

  let body;
  if (!data && feed.error) {
    body = (
      <ErrorState
        className="ops-needs-error"
        title={t("s1_feed_error")}
        reason={t("s1_feed_error_reason")}
        onRetry={feed.reload}
      />
    );
  } else if (!data) {
    body = <Skeleton rows={4} label={t("s1_loading")} className="ops-needs-skeleton" />;
  } else if (!(data.items || []).length) {
    body = (
      <EmptyState
        className="ops-needs-empty"
        testId="needs-you-empty"
        title={t("s1_empty_title")}
        body={
          trucksOnRoute != null ? fill(t("s1_empty_body"), { n: trucksOnRoute }) : t("s1_empty_body_plain")
        }
      />
    );
  } else {
    body = (
      <ul className="ops-needs-list" data-testid="action-queue">
        {items.map((item) => {
          const look = KIND_LOOK[item.kind] || KIND_LOOK.road_closed;
          const Icon = look.icon;
          const view = describe(item, { t, lang, alert: alertFor(item) });
          const state = rowState[item.id] || {};
          const open = item.kind === "deviation" && item.id === openId;
          const when = ago(item.created_at, lang);
          const simulated = item.classification === "SIMULATED";
          const action = (
            <Button
              size="sm"
              variant={open ? "primary" : "secondary"}
              icon={open ? Send : undefined}
              disabled={state.busy || (view.action === "send_route" && !view.route)}
              aria-busy={state.busy || undefined}
              data-testid={`needs-action-${view.action}`}
              onClick={(event) => {
                event.stopPropagation();
                act(item, view);
              }}
            >
              {t(ACTION_KEYS[view.action])}
            </Button>
          );
          return (
            <li
              key={item.id}
              className={`ops-item${open ? " is-open" : ""}`}
              data-testid="action-row"
              data-kind={item.kind}
              data-item-id={item.id}
              data-severity={item.severity}
              {...(simulated
                ? { "data-provenance": "simulated", title: t("s1_item_simulated") }
                : { "data-provenance": item.classification === "FIELD" ? "field" : "model" })}
            >
              <div className="ops-item-top">
                <span className={`ops-sev ops-sev-${look.tone}`} aria-hidden="true">
                  <Icon size={16} />
                </span>
                <div className="ops-item-text">
                  <div className="ops-item-head">
                    {item.truck_code || item.kind === "deviation" ? (
                      <button
                        type="button"
                        className="ops-item-title"
                        aria-expanded={item.kind === "deviation" ? open : undefined}
                        onClick={() => select(item)}
                      >
                        {view.title}
                      </button>
                    ) : (
                      <span className="ops-item-title">{view.title}</span>
                    )}
                    {view.tag}
                    {open && when && <span className="ops-item-when">{when}</span>}
                  </div>
                  <p className="ops-item-sub">{view.sub}</p>
                  {item.next_step && item.rule && (
                    <p className="ops-item-sub" data-testid="needs-next-step">
                      {fill(t(item.next_step.key), item.next_step.params || {})} ·{" "}
                      {fill(t(item.rule.key), item.rule.params || {})}
                    </p>
                  )}
                  {state.done && (
                    <p className="ops-item-note" role="status">
                      {state.done}
                    </p>
                  )}
                  {state.error && (
                    <p className="ops-item-note is-error" role="alert">
                      {state.error}
                    </p>
                  )}
                </div>
                {!open && action}
              </div>

              {open && (
                <>
                  <div className="ops-suggest" data-testid="needs-suggestion">
                    <Sparkles size={15} aria-hidden="true" />
                    <div>
                      <span className="ops-suggest-key">{t("s1_suggests")}</span>
                      <p data-testid="decision-route-name">
                        {view.route
                          ? fill(
                              t(
                                view.route.distance_km != null ? "s1_suggest_route" : "s1_suggest_route_nokm",
                              ),
                              {
                                route: routeName(t, view.route),
                                km: Number(view.route.distance_km).toLocaleString(localeFor(lang), {
                                  maximumFractionDigits: 1,
                                }),
                                eta: view.route.eta_minutes ?? "—",
                              },
                            )
                          : t("s1_suggest_none")}
                      </p>
                    </div>
                  </div>
                  <div className="ops-item-actions">
                    {action}
                    <button
                      type="button"
                      className="ops-link"
                      disabled={state.busy}
                      onClick={() => act(item, { action: "mark_handled" })}
                      data-testid="needs-action-mark_handled"
                    >
                      {t("s1_mark_handled")}
                    </button>
                  </div>
                </>
              )}

              {confirming === item.id && view.suggestion && (
                <div className="ops-confirm" role="group" aria-label={t("s1_reassign")}>
                  <p>
                    {fill(t("s1_reassign_confirm"), {
                      from: view.suggestion.from_truck,
                      to: view.suggestion.to_truck,
                    })}
                  </p>
                  <div className="ops-item-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      data-testid="needs-reassign-confirm"
                      onClick={() => reassign(item, view.suggestion)}
                    >
                      {t("s1_reassign")}
                    </Button>
                    <button type="button" className="ops-link" onClick={() => setConfirming(null)}>
                      {t("s1_cancel")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {!items.length && <li className="ops-needs-none">{t("s1_filter_empty")}</li>}
      </ul>
    );
  }

  return (
    <section className="ops-needs" aria-labelledby="ops-needs-title" data-testid="needs-you">
      <header className="ops-needs-head">
        <h2 id="ops-needs-title">{t("s1_needs_title")}</h2>
        {data && (
          <Tag tone="soon" className="ops-needs-count" data-testid="needs-you-count">
            {counts.all ?? 0}
          </Tag>
        )}
        <span className="ops-needs-spacer" />
        {counts.urgent > 0 && (
          <span className="ops-needs-urgent" data-testid="needs-you-urgent">
            {fill(t("s1_urgent"), { n: counts.urgent })}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={collapsed ? ChevronDown : ChevronUp}
          aria-expanded={!collapsed}
          aria-controls="ops-needs-content"
          aria-label={fill(t(collapsed ? "s1_expand" : "s1_collapse"), { name: t("s1_needs_title") })}
          data-testid="needs-you-toggle"
          onClick={() => setCollapsed((value) => !value)}
        />
      </header>
      <div id="ops-needs-content" className="ops-needs-content" hidden={collapsed}>
        {data && (data.items || []).length > 0 && (
          <div className="ops-needs-filters" role="group" aria-label={t("s1_filter_label")}>
            {FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                className="ops-chip"
                aria-pressed={filter === id}
                data-testid={`needs-filter-${id}`}
                onClick={() => setFilter(id)}
              >
                <span>
                  {t(`s1_filter_${id}`)} {counts[id] ?? 0}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="ops-needs-body">{body}</div>
      </div>
    </section>
  );
}
