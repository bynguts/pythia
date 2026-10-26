import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Check,
  Download,
  Pencil,
  Send,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  ClipboardList,
} from "lucide-react";
import { useConsole } from "../app/console/useConsole.js";
import { apiFetch } from "../shared/api/client.js";
import { localeFor, useLanguage } from "../shared/i18n/index.jsx";
import { Button, Card, EmptyState, ErrorState, Progress4, Tag, WaitingApproval } from "../shared/ui/index.js";
import { ROLE_PERMISSIONS } from "../features/settings/roles.js";
import { FieldFactsCard, ForecastCard, ResourcesCard } from "../features/planning/TomorrowForecast.jsx";
import { AllocationKpis, PlanFlags, useAllocationViews } from "../features/planning/PlanAllocation.jsx";
import { OutlookSection } from "../features/planning/TomorrowOutlook.jsx";
import {
  dayLabel,
  heldTrucks,
  planDateFor,
  planFlags,
  tomorrowIso,
  truckRows,
  wibTime,
} from "../features/planning/tomorrowModel.js";
import { buildTomorrowReportHtml } from "../features/planning/tomorrowReport.js";
import "../features/planning/tomorrow.css";

const POLL_MS = 15000;
const INBOX_POLL_MS = 30000;
const LIVE = ["draft", "proposed", "approved", "returned"];

async function getJson(path, signal) {
  const response = await apiFetch(path, { signal });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await apiFetch(path, { method: "POST", body });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

// Wave 13 Tomorrow (iNFo4) and its supervisor mode (x4toSC): tomorrow's forecast and what
// moved it, the field facts (the only manual input), the CP-SAT pilot-fleet plan built from
// both, and the submit → approve / return loop. No sliders: every other input fills itself.
export function TomorrowPage() {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const { role, permissions, canSupervise, supervisorMode, setSubtitle } = useConsole();
  const granted = permissions?.length ? permissions : ROLE_PERMISSIONS[role] || [];
  const canPlan = granted.includes("operations:plan");
  const reviewing = Boolean(supervisorMode && canSupervise);
  // Tomorrow by default; `?date=` opens another day of the forecast week (e.g. Monday's plan
  // on a Friday). Anything outside it falls back to tomorrow.
  const [searchParams] = useSearchParams();
  const requested = searchParams.get("date");
  const date = useMemo(() => planDateFor(requested), [requested]);
  const isTomorrow = date === tomorrowIso();
  const day = dayLabel(date, locale);
  const title = t(isTomorrow ? "s3_title" : "s3_title_other").replace("{date}", day);

  const [forecast, setForecast] = useState(null);
  const [forecastError, setForecastError] = useState(false);
  const [facts, setFacts] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planLoaded, setPlanLoaded] = useState(false);
  const [board, setBoard] = useState(null);
  const [queueMetric, setQueueMetric] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [busy, setBusy] = useState(null); // "build" | "submit" | "approve" | "return" | "withdraw" | "swap"
  const [failure, setFailure] = useState(null); // { status } of a build that returned no plan
  const [actionError, setActionError] = useState(null);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  const [exportFailed, setExportFailed] = useState(false);
  const planRequest = useRef(0);

  useEffect(() => {
    setSubtitle?.(t("s3_crumb_sub").replace("{date}", day));
    return () => setSubtitle?.(null);
  }, [setSubtitle, t, day]);

  // Forecast, field facts, the gate slot board, the queue model and the fleet size.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    getJson(`/forecast/tomorrow?date=${date}`, signal)
      .then(setForecast)
      .catch((error) => error.name !== "AbortError" && setForecastError(true));
    getJson(`/field-facts?date=${date}`, signal)
      .then((body) => setFacts(body.facts || []))
      .catch((error) => error.name !== "AbortError" && setFacts([]));
    getJson(`/tpa/queue-metric`, signal)
      .then(setQueueMetric)
      .catch(() => {});
    getJson(`/fleet`, signal)
      .then((body) => setFleet(Array.isArray(body) ? body : null))
      .catch(() => {});
    return () => controller.abort();
  }, [date]);

  const loadBoard = useCallback(
    (signal) =>
      getJson(`/gate/slots?date=${date}`, signal)
        .then(setBoard)
        .catch(() => {}),
    [date],
  );
  useEffect(() => {
    const controller = new AbortController();
    loadBoard(controller.signal);
    return () => controller.abort();
  }, [loadBoard]);

  // The plan on screen: in supervisor mode the newest plan waiting for approval (tomorrow's
  // first); otherwise the newest live plan for tomorrow.
  const loadPlan = useCallback(
    async (signal) => {
      const request = ++planRequest.current;
      try {
        let next = null;
        if (reviewing) {
          const inbox = await getJson(`/operations/plans?status=proposed&limit=20`, signal);
          next = inbox.find((p) => p.plan_date === date) || inbox[0] || null;
        }
        if (!next) {
          const recent = await getJson(`/operations/plans?limit=20`, signal);
          next = recent.find((p) => p.plan_date === date && LIVE.includes(p.status)) || null;
          if (reviewing && next && next.status !== "approved") next = null;
        }
        if (request === planRequest.current) setPlan(next);
      } catch (error) {
        if (error.name !== "AbortError" && request === planRequest.current) setPlan(null);
      } finally {
        if (request === planRequest.current) setPlanLoaded(true);
      }
    },
    [reviewing, date],
  );
  useEffect(() => {
    const controller = new AbortController();
    setPlanLoaded(false);
    setFailure(null);
    setActionError(null);
    setReturning(false);
    loadPlan(controller.signal);
    return () => controller.abort();
  }, [loadPlan]);

  // Live update: a plan waiting for approval is read by id every 15 s, so the dispatcher
  // sees the approval (or the return) and the supervisor sees a withdrawal, without reloading.
  const waitingId = plan?.status === "proposed" ? plan.plan_id : null;
  useEffect(() => {
    if (!waitingId) return undefined;
    const controller = new AbortController();
    const id = setInterval(() => {
      getJson(`/operations/plans/${encodeURIComponent(waitingId)}`, controller.signal)
        .then((latest) => {
          if (latest?.status && latest.status !== "proposed")
            setPlan(latest.status === "withdrawn" ? null : latest);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [waitingId]);

  // Supervisor mode with an empty inbox: look again every 30 s.
  const inboxEmpty = reviewing && planLoaded && !plan;
  useEffect(() => {
    if (!inboxEmpty) return undefined;
    const controller = new AbortController();
    const id = setInterval(() => loadPlan(controller.signal), INBOX_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [inboxEmpty, loadPlan]);

  // ── Field facts ─────────────────────────────────────────────────────────
  async function addFact(fact) {
    const result = await postJson("/field-facts", { date, ...fact });
    if (!result.ok || !result.data) return false;
    setFacts((current) => [...(current || []), result.data]);
    return true;
  }
  async function removeFact(fact) {
    const response = await apiFetch(`/field-facts/${encodeURIComponent(fact.id)}`, {
      method: "DELETE",
    }).catch(() => null);
    if (!response?.ok) return false;
    setFacts((current) => (current || []).filter((f) => f.id !== fact.id));
    return true;
  }

  // ── Plan actions ────────────────────────────────────────────────────────
  async function build() {
    setBusy("build");
    setFailure(null);
    setActionError(null);
    try {
      // A rebuild replaces the plan on screen: the old one is withdrawn so it never
      // reaches the approver next to the new one.
      if (plan && ["draft", "proposed", "returned"].includes(plan.status)) {
        await postJson(`/operations/plans/${encodeURIComponent(plan.plan_id)}/withdraw`).catch(() => null);
      }
      const query = new URLSearchParams({ plan_date: date, auto_inputs: "true", top_n: "42", draft: "true" });
      const result = await postJson(`/operations/plan?${query}`);
      if (!result.ok || !result.data) {
        setPlan(null);
        setFailure({ status: result.status });
      } else if (!result.data.assignments?.length) {
        setPlan(null);
        setFailure({ status: 200, plan: result.data });
      } else {
        setPlan(result.data);
        loadBoard();
      }
    } catch {
      setPlan(null);
      setFailure({ status: 0 });
    } finally {
      setBusy(null);
    }
  }

  async function act(kind, path, body, errorKey, onDone) {
    setBusy(kind);
    setActionError(null);
    try {
      const result = await postJson(path, body);
      if (!result.ok || !result.data) {
        setActionError(errorKey);
        return;
      }
      onDone(result.data);
    } catch {
      setActionError(errorKey);
    } finally {
      setBusy(null);
    }
  }
  const planPath = (suffix) => `/operations/plans/${encodeURIComponent(plan.plan_id)}/${suffix}`;
  const submit = () => act("submit", planPath("submit"), undefined, "s3_submit_error", setPlan);
  const withdraw = () =>
    act("withdraw", planPath("withdraw"), undefined, "s3_withdraw_error", () => setPlan(null));
  const swap = (a, b) =>
    act("swap", planPath("swap"), { truck_a: a, truck_b: b }, "s3_swap_error", (next) => setPlan(next));
  const approve = () =>
    act(
      "approve",
      `/operations/${encodeURIComponent(plan.plan_id)}/approve`,
      undefined,
      "s3_approve_error",
      (next) => {
        setPlan(next);
        loadBoard();
      },
    );
  const sendBack = (event) => {
    event.preventDefault();
    if (note.trim().length < 3) return;
    act("return", planPath("return"), { note: note.trim() }, "s3_return_error", (next) => {
      setReturning(false);
      setNote("");
      setPlan(null);
      loadPlan();
      return next;
    });
  };

  // ── Derived view ────────────────────────────────────────────────────────
  const rows = useMemo(() => truckRows(plan), [plan]);
  const held = useMemo(() => heldTrucks(plan), [plan]);
  const flags = useMemo(() => planFlags(plan, rows), [plan, rows]);
  const status = plan?.status || null;
  const canSwap = canPlan && !reviewing && (status === "draft" || status === "proposed") && busy !== "swap";
  const { control: viewControl, body: viewBody } = useAllocationViews({
    plan,
    rows,
    board,
    canSwap,
    onSwap: swap,
  });
  const fleetCodes = useMemo(() => (fleet || []).map((truck) => truck.truck_code), [fleet]);
  const roleName = (value) => {
    const key = `pln6_profile_role_${value}`;
    return value && t(key) !== key ? t(key) : t("pln6_profile_role_unknown");
  };
  const submittedAt = wibTime(plan?.submitted_at || plan?.created_at);
  const approvedAt = wibTime(plan?.approved_at);
  const workOrders = plan?.spj_drafts?.filter((d) => d.spj_id).length ?? plan?.dispatches?.length ?? 0;

  let subtitle = t("s3_sub_dispatcher");
  if (reviewing) {
    subtitle =
      status === "proposed"
        ? t("s3_sub_supervisor")
            .replace("{who}", roleName(plan.proposed_by))
            .replace("{time}", submittedAt || "—")
        : status === "approved"
          ? t("s3_sub_approved").replace("{time}", approvedAt || "—")
          : t("s3_sub_supervisor_none");
  } else if (status === "proposed") subtitle = t("s3_sub_waiting").replace("{time}", submittedAt || "—");
  else if (status === "approved") subtitle = t("s3_sub_approved").replace("{time}", approvedAt || "—");
  else if (status === "returned") subtitle = t("s3_sub_returned");

  const factCount = facts?.length ?? null;
  const approvalNote =
    status === "approved"
      ? t("s3_note_approved")
      : status === "returned"
        ? t("s3_note_returned")
        : reviewing && status === "proposed"
          ? t("s3_note_your_turn")
          : t("s3_note_supervisor");
  const steps = [
    {
      key: "forecast",
      label: t(forecast ? "s3_step_forecast" : "s3_step_forecast_todo"),
      note: forecast
        ? wibTime(forecast.generated_at)
          ? t("s3_note_model_time").replace("{time}", wibTime(forecast.generated_at))
          : t("s3_note_model")
        : null,
    },
    {
      key: "facts",
      label: t("s3_step_facts"),
      note:
        factCount == null
          ? null
          : factCount === 0
            ? t("s3_note_facts_none")
            : factCount === 1
              ? t("s3_note_facts_one")
              : t("s3_note_facts").replace("{n}", factCount),
    },
    {
      key: "allocation",
      label: t("s3_step_allocation"),
      note: plan
        ? plan.solve_seconds != null
          ? t("s3_note_solver_time").replace(
              "{s}",
              Number(plan.solve_seconds).toLocaleString(locale, {
                maximumFractionDigits: plan.solve_seconds < 10 ? 1 : 0,
              }),
            )
          : t("s3_note_solver")
        : null,
    },
    { key: "approval", label: t("s3_step_approval"), note: approvalNote },
  ];
  const current = !forecast ? 0 : status === "approved" ? 4 : status === "proposed" ? 3 : plan ? 2 : 1;

  async function exportPdf() {
    const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
    const node = document.createElement("section");
    node.className = "pdf-report";
    node.innerHTML = buildTomorrowReportHtml({
      t,
      number,
      title,
      subtitle,
      forecast,
      facts,
      plan,
      rows,
    });
    setExportFailed(false);
    try {
      const { default: html2pdf } = await import("html2pdf.js");
      await html2pdf()
        .set({
          margin: 12,
          filename: `${t("s3_export_name").replace("{date}", date)}.pdf`,
          image: { type: "jpeg", quality: 0.95 },
          html2canvas: { scale: 2 },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(node)
        .save();
    } catch {
      setExportFailed(true);
    }
  }

  // ── Allocation card body by state ───────────────────────────────────────
  const reason = (code) => {
    const [binding, area] = String(code).split(":");
    const key = `pln6_binding_${binding}`;
    if (t(key) !== key) return area ? `${t(key)}: ${area.replace(/_/g, " ")}` : t(key);
    if (code === "no_available_vehicle") return t("w10num_reason_no_vehicle");
    if (code === "no_permit_compliant_vehicle") return t("w10num_reason_no_permit");
    if (code === "no_feasible_assignment") return t("w10num_reason_infeasible");
    return t("w10num_reason_other");
  };

  let cardBody;
  let footer = null;
  if (!planLoaded || busy === "build") {
    cardBody = (
      <div className="tmr-alloc-state" role="status" data-testid="tmr-alloc-loading">
        <EmptyState title={busy === "build" ? t("s3_building") : t("f_loading")} />
      </div>
    );
  } else if (failure) {
    const suggestions = [...new Set((failure.plan?.unmet_reasons || []).map(reason))];
    cardBody = (
      <div className="tmr-alloc-state">
        <ErrorState
          testId="tmr-plan-failed"
          title={t("s3_failed_title")}
          reason={
            failure.status === 0
              ? t("s3_failed_network")
              : failure.status === 200
                ? t("s3_failed_reason")
                : t("s3_failed_http").replace("{status}", failure.status)
          }
          suggestions={suggestions}
          onRetry={canPlan ? build : undefined}
        />
      </div>
    );
  } else if (!plan) {
    cardBody = (
      <div className="tmr-alloc-state">
        {reviewing ? (
          <EmptyState
            testId="tmr-review-empty"
            title={t("s3_supervisor_none_title")}
            body={t("s3_supervisor_none_body")}
          />
        ) : (
          <EmptyState
            testId="tmr-plan-empty"
            title={t("s3_build_title")}
            body={t("s3_build_body")}
            action={
              canPlan && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={ClipboardList}
                  data-testid="tmr-build"
                  disabled={!forecast}
                  onClick={build}
                >
                  {t("s3_build")}
                </Button>
              )
            }
          />
        )}
      </div>
    );
  } else {
    cardBody = (
      <>
        {!reviewing && status === "proposed" && (
          <div className="tmr-waiting">
            <WaitingApproval
              testId="plan-awaiting-approval"
              submittedAt={submittedAt}
              actions={
                canPlan && (
                  <Button size="sm" data-testid="tmr-withdraw" disabled={busy != null} onClick={withdraw}>
                    {t("s3_withdraw")}
                  </Button>
                )
              }
            />
          </div>
        )}
        {status === "returned" && (
          <p className="tmr-banner" role="status" data-testid="tmr-returned">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              <strong>{t("s3_returned_title").replace("{who}", roleName(plan.returned_by))}</strong>
              {plan.return_note && t("s3_returned_note").replace("{note}", plan.return_note)}
            </span>
          </p>
        )}
        <AllocationKpis
          plan={plan}
          rows={rows}
          fleetSize={fleet ? fleet.filter((truck) => !truck.is_damaged).length : null}
          held={held}
          board={board}
          queueMetric={queueMetric}
        />
        <PlanFlags flags={flags} review={reviewing} />
        {viewBody}
        <div className="tmr-spacer" />
      </>
    );

    const moved = plan.edits?.length || 0;
    if (reviewing && status === "proposed") {
      footer = (
        <div className="tmr-footer is-review" data-testid="tmr-footer">
          {returning ? (
            <form className="tmr-return" onSubmit={sendBack}>
              <label htmlFor="tmr-return-note">{t("s3_return_label")}</label>
              <textarea
                id="tmr-return-note"
                value={note}
                maxLength={500}
                placeholder={t("s3_return_placeholder")}
                data-testid="tmr-return-note"
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="tmr-return-actions">
                <Button size="sm" onClick={() => setReturning(false)}>
                  {t("s3_return_cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon={Undo2}
                  data-testid="tmr-return-send"
                  disabled={busy != null || note.trim().length < 3}
                >
                  {t("s3_return_send")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <ShieldCheck size={16} aria-hidden="true" />
              <p className="tmr-footer-text">
                {workOrders === 1
                  ? t("s3_approve_note_one")
                  : t("s3_approve_note").replace("{n}", workOrders)}
              </p>
              <div className="tmr-footer-actions">
                <Button
                  size="sm"
                  icon={Undo2}
                  data-testid="tmr-return"
                  disabled={busy != null}
                  onClick={() => setReturning(true)}
                >
                  {t("s3_return")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={Check}
                  data-testid="approve-plan"
                  disabled={busy != null}
                  onClick={approve}
                >
                  {t("s3_approve")}
                </Button>
              </div>
            </>
          )}
          {actionError && (
            <p className="tmr-inline-error" role="alert">
              {t(actionError)}
            </p>
          )}
        </div>
      );
    } else if (status === "approved") {
      footer = (
        <div className="tmr-footer is-review" data-testid="approval-done">
          <ShieldCheck size={16} aria-hidden="true" />
          <p className="tmr-footer-text" data-testid="approval-approved-by">
            {t("s3_footer_approved")
              .replace("{who}", roleName(plan.approved_by))
              .replace("{time}", approvedAt || "—")
              .replace("{n}", workOrders)}
          </p>
          <div className="tmr-footer-actions">
            <Link
              className="ui-btn ui-btn-secondary ui-btn-sm"
              to="/app/work-orders"
              data-testid="approval-spj-drafts"
            >
              <span className="ui-btn-face">{t("s3_open_work_orders")}</span>
            </Link>
          </div>
        </div>
      );
    } else if (!reviewing && canPlan) {
      const parts =
        status === "draft"
          ? [
              t("s3_footer_draft").replace("{time}", wibTime(plan.created_at) || "—"),
              moved
                ? moved === 1
                  ? t("s3_footer_moved_one")
                  : t("s3_footer_moved").replace("{n}", moved)
                : null,
              t("s3_footer_drag"),
            ]
          : status === "proposed"
            ? [t("s3_footer_sent").replace("{time}", submittedAt || "—"), moved ? t("s3_footer_drag") : null]
            : [t("s3_footer_returned").replace("{time}", wibTime(plan.returned_at) || "—")];
      footer = (
        <div className="tmr-footer" data-testid="tmr-footer">
          <Pencil size={14} aria-hidden="true" />
          <p className="tmr-footer-text">{parts.filter(Boolean).join(" · ")}</p>
          <div className="tmr-footer-actions">
            <Button size="sm" data-testid="tmr-rebuild" disabled={busy != null} onClick={build}>
              {t("s3_rebuild")}
            </Button>
            {status === "draft" && (
              <Button
                variant="primary"
                size="sm"
                icon={Send}
                data-testid="tmr-submit"
                disabled={busy != null}
                onClick={submit}
              >
                {t("s3_submit")}
              </Button>
            )}
          </div>
          {actionError && (
            <p className="tmr-inline-error" role="alert">
              {t(actionError)}
            </p>
          )}
        </div>
      );
    }
  }

  return (
    <div className="tmr" data-testid="tomorrow-page" data-mode={reviewing ? "supervisor" : "dispatcher"}>
      <div className="tmr-head">
        <div className="tmr-head-text">
          <h1 className="tmr-title" data-testid="tmr-title">
            {title}
          </h1>
          <p className="tmr-sub" data-testid="tmr-subtitle">
            {subtitle}
          </p>
          {exportFailed && (
            <p className="tmr-inline-error" role="alert">
              {t("s3_export_error")}
            </p>
          )}
        </div>
        <Button icon={Download} data-testid="tmr-export" onClick={exportPdf}>
          {t("s3_export_pdf")}
        </Button>
      </div>

      <Progress4 steps={steps} current={current} label={t("s3_steps_label")} className="planning-progress" />

      <div className="tmr-body">
        <div className="tmr-left">
          <ForecastCard forecast={forecast} error={forecastError} />
          <ResourcesCard forecast={forecast} />
          <FieldFactsCard
            facts={facts}
            fleetCodes={fleetCodes}
            canEdit={canPlan && !reviewing}
            onAdd={addFact}
            onRemove={removeFact}
          />
        </div>
        <Card
          className="tmr-alloc"
          title={t("s3_alloc_title")}
          titleId="tmr-alloc-title"
          flush
          data-testid="approval-plan"
          data-plan-id={plan?.plan_id || ""}
          data-status={status || "none"}
          data-provenance="model"
          actions={
            <>
              <Tag tone="real" className="tmr-alloc-head-tag" title={t("s3_solver_title")}>
                {t("s3_solver")}
              </Tag>
              {plan && viewControl}
            </>
          }
        >
          {cardBody}
          {footer}
        </Card>
      </div>

      <OutlookSection />
    </div>
  );
}
