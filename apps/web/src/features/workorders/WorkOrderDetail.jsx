import { Check, Lock, MessageCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { ApiError, apiPost } from "../../shared/api/client.js";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { useConsole } from "../../app/console/useConsole.js";
import { Button, Skeleton, StatusDot, Tag } from "../../shared/ui/index.js";
import { jakartaClock, jakartaDay } from "../gate/gateModel.js";
import { EvidencePhoto, ReceiptReview } from "../fleet/SpjPanel.jsx";
import { AUDIT_KEYS, FRACTIONS, mergeAudit, tonnes } from "./workOrdersModel.js";
import { useWorkOrderDetail } from "./useWorkOrders.js";

const ACTOR_NAMES = { operations_optimizer: "Pythia", optimizer: "Pythia", manager_central: "Dispatcher" };

function actorLabel(actor) {
  if (!actor) return "";
  if (ACTOR_NAMES[actor]) return ACTOR_NAMES[actor];
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function whenLabel(iso, lang) {
  const clock = jakartaClock(iso);
  if (!clock) return "";
  if (jakartaDay(new Date(iso)) === jakartaDay()) return clock;
  const day = new Intl.DateTimeFormat(localeFor(lang), { timeZone: "Asia/Jakarta", weekday: "short" }).format(
    new Date(iso),
  );
  return `${clock} ${day}`;
}

function errorText(err, t) {
  if (!(err instanceof ApiError)) return t("s4_wo_network_error");
  if (err.status === 401) return t("s4_wo_err_session");
  if (err.status === 403) return t("s4_wo_err_forbidden");
  return err.detail || err.message;
}

function stopGaps(stop, weighingRequired) {
  const gaps = [];
  if (!stop.has_arrival) gaps.push("photo");
  if (!stop.officer_name) gaps.push("officer");
  if (weighingRequired && !stop.weighing_count) gaps.push("weights");
  return gaps;
}

function Check_({ ok, children, testId }) {
  return (
    <StatusDot tone={ok ? "ok" : "warn"} data-testid={testId}>
      {children}
    </StatusDot>
  );
}

function StopProof({ spj, stop, listStop, number, t, lang }) {
  const done = stop.status === "completed";
  const skipped = stop.status === "skipped";
  const gaps = done ? stopGaps(stop, stop.weighing_required) : [];
  const tone = done ? (gaps.length ? "warn" : "ok") : "idle";
  const fractions = stop.fractions || {};
  const showWeights = stop.weighing_required || stop.weighing_count > 0;
  const when = done
    ? t("s4_wo_done_at").replace("{time}", jakartaClock(listStop?.completed_at) || "—")
    : skipped
      ? t("s4_wo_skipped")
      : stop.has_arrival
        ? t("s4_wo_arrived")
        : t("s4_wo_next");
  const geotag = stop.geotag;
  const approx = geotag?.status === "approx" || geotag?.flagged;

  return (
    <li className={`wo-stop is-${tone}`} data-testid="wo-stop">
      <span className="wo-stop-mark" aria-hidden="true">
        {done ? gaps.length ? <TriangleAlert size={13} /> : <Check size={14} /> : number}
      </span>
      <div className="wo-stop-body">
        <div className="wo-stop-head">
          <h4>{stop.name}</h4>
          <span className="wo-muted">{when}</span>
        </div>
        {(stop.photos || stop.has_arrival || showWeights) && (done || stop.has_arrival) && (
          <div className="wo-proof">
            {(stop.photos || []).length > 0 && (
              <span className="wo-photos">
                {stop.photos.slice(0, 3).map((photo) => (
                  <EvidencePhoto
                    key={photo.n}
                    spjId={spj.spj_id}
                    photo={photo}
                    stopName={stop.name}
                    width={64}
                    height={48}
                  />
                ))}
              </span>
            )}
            {showWeights && (
              <span className="wo-weights">
                {FRACTIONS.map((fraction) => {
                  const kg = fractions[fraction];
                  return (
                    <span key={fraction} className={`wo-weight${kg == null ? " is-missing" : ""}`}>
                      <small>{t(`s4_wo_fraction_${fraction.toLowerCase()}`)}</small>
                      <strong>{kg == null ? t("s4_wo_missing") : `${tonnes(kg, localeFor(lang))} t`}</strong>
                    </span>
                  );
                })}
              </span>
            )}
          </div>
        )}
        {(done || stop.has_arrival) && (
          <div className="wo-checks">
            <Check_ ok={stop.has_arrival && !approx} testId="spj-geotag">
              {!stop.has_arrival
                ? t("s4_wo_photo_missing")
                : approx
                  ? t("s4_wo_geo_approx")
                  : t("s4_wo_geo_ok")}
            </Check_>
            <Check_ ok={!!stop.officer_name}>
              {stop.officer_name
                ? t(stop.photos?.length ? "s4_wo_officer_photo" : "s4_wo_officer_named")
                : t("s4_wo_officer_missing")}
            </Check_>
          </div>
        )}
        {stop.override && (
          <p className="wo-muted wo-override-note">
            {t("s4_wo_stop_override")
              .replace("{reason}", stop.override.reason)
              .replace("{who}", stop.override.actor)}
          </p>
        )}
      </div>
    </li>
  );
}

export function WorkOrderDetail({ spj, state, onChanged }) {
  const { t, lang } = useLanguage();
  const { permissions } = useConsole();
  const canDispatch = permissions.includes("dispatch:create");
  const canOverride = permissions.includes("spj:override");
  const [refreshKey, setRefreshKey] = useState(0);
  const { evidence, audit, slot, loading } = useWorkOrderDetail(
    spj,
    `${refreshKey}:${spj.status}:${spj.stops?.length}`,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);

  const base = `/spj/${encodeURIComponent(spj.spj_id)}`;
  const proofMissing = state === "proof";
  const evidenceStops = evidence?.stops || [];
  const receipt = spj.receipt || evidence?.receipt;
  const entries = mergeAudit(audit?.audit, audit?.plan_events);

  async function run(fn, done) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      setRefreshKey((n) => n + 1);
      onChanged();
      return true;
    } catch (err) {
      setError(errorText(err, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const askProof = () =>
    run(
      () =>
        apiPost("/dispatch", {
          truck_code: spj.truck_code,
          instruction: t("s4_wo_proof_request").replace("{spj}", spj.spj_number),
        }),
      t("s4_wo_proof_sent"),
    );

  async function closeSpj() {
    if (proofMissing && canOverride) {
      setOverriding(true);
      return;
    }
    const closed = await run(() => apiPost(`${base}/complete`));
    // The server may know of a gap the list does not show: a supervisor can then override.
    if (!closed && canOverride) setOverriding(true);
  }

  async function submitOverride(event) {
    event.preventDefault();
    if (reason.trim().length < 10) {
      setReasonError(true);
      return;
    }
    setReasonError(false);
    const closed = await run(() => apiPost(`${base}/complete`, { override: true, reason: reason.trim() }));
    if (closed) {
      setOverriding(false);
      setReason("");
    }
  }

  const priority = spj.priority === "vip" ? t("s4_wo_priority_vip") : t("s4_wo_priority_normal");
  const stateTag = {
    aktif: ["success", t("s4_wo_tag_active")],
    draft: ["neutral", t("s4_wo_tab_drafts")],
    selesai: ["neutral", t("s4_wo_tab_closed")],
  }[spj.status] || ["neutral", spj.status];

  return (
    <section className="ui-card wo-detail" aria-labelledby="wo-detail-title" data-testid="wo-detail">
      <header className="wo-detail-head">
        <div className="wo-detail-title">
          <h2 id="wo-detail-title">{spj.spj_number}</h2>
          <Tag tone={stateTag[0]}>{stateTag[1]}</Tag>
          {proofMissing && <Tag tone="warn">{t("s4_wo_state_proof")}</Tag>}
        </div>
        <div className="wo-detail-actions">
          {spj.status === "aktif" && canDispatch && (
            <Button icon={MessageCircle} onClick={askProof} disabled={busy} data-testid="wo-ask-proof">
              {t("s4_wo_ask_proof")}
            </Button>
          )}
          {spj.status === "aktif" && (
            <Button variant="primary" onClick={closeSpj} disabled={busy} data-testid="wo-close">
              {t("s4_wo_close")}
            </Button>
          )}
          {spj.status === "draft" && canDispatch && (
            <Button
              variant="primary"
              onClick={() => run(() => apiPost(`${base}/activate`))}
              disabled={busy}
              data-testid="wo-activate"
            >
              {t("s4_wo_activate")}
            </Button>
          )}
          {["draft", "aktif"].includes(spj.status) && canDispatch && (
            <Button
              variant="ghost"
              onClick={() => run(() => apiPost(`${base}/cancel`))}
              disabled={busy}
              data-testid="wo-cancel"
            >
              {t("s4_wo_cancel")}
            </Button>
          )}
        </div>
      </header>

      <dl className="wo-meta">
        <div>
          <dt>{t("s4_wo_truck")}</dt>
          <dd>{spj.truck_code}</dd>
        </div>
        <div>
          <dt>{t("s4_wo_driver")}</dt>
          <dd>{spj.driver_name}</dd>
        </div>
        <div>
          <dt>{t("s4_wo_destination")}</dt>
          <dd>{spj.destination}</dd>
        </div>
        <div>
          <dt>{t("s4_wo_priority")}</dt>
          <dd>{priority}</dd>
        </div>
        <div>
          <dt>{t("s4_wo_weigh")}</dt>
          <dd>{spj.weigh_on_site ? t("s4_wo_required") : t("s4_wo_not_required")}</dd>
        </div>
      </dl>

      {(error || notice) && (
        <p
          className={error ? "wo-message is-error" : "wo-message"}
          role={error ? "alert" : "status"}
          data-testid="wo-message"
        >
          {error || notice}
        </p>
      )}
      {overriding && (
        <form className="wo-override" onSubmit={submitOverride} data-testid="wo-override-form">
          <label htmlFor="wo-override-reason">{t("s4_wo_override_label")}</label>
          <input
            id="wo-override-reason"
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={reasonError}
            data-testid="wo-override-reason"
          />
          {reasonError && (
            <p className="wo-message is-error" role="alert">
              {t("s4_wo_override_short")}
            </p>
          )}
          <div className="wo-override-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy}
              data-testid="wo-override-submit"
            >
              {t("s4_wo_override_submit")}
            </Button>
            <Button size="sm" onClick={() => setOverriding(false)}>
              {t("s4_wo_override_cancel")}
            </Button>
          </div>
        </form>
      )}

      <div className="wo-body">
        <div className="wo-timeline">
          <h3 className="wo-section">{t("s4_wo_stops")}</h3>
          {loading ? (
            <Skeleton rows={2} />
          ) : (
            <ol className="wo-stops">
              {evidenceStops.length === 0
                ? (spj.stops || []).map((stop, index) => (
                    <li key={index} className="wo-stop is-idle">
                      <span className="wo-stop-mark" aria-hidden="true">
                        {index + 1}
                      </span>
                      <div className="wo-stop-body">
                        <div className="wo-stop-head">
                          <h4>{stop.name}</h4>
                        </div>
                      </div>
                    </li>
                  ))
                : evidenceStops.map((stop, index) => (
                    <StopProof
                      key={stop.index}
                      spj={spj}
                      stop={stop}
                      listStop={(spj.stops || [])[index]}
                      number={index + 1}
                      t={t}
                      lang={lang}
                    />
                  ))}
              <li className="wo-stop is-idle">
                <span className="wo-stop-mark" aria-hidden="true">
                  {(spj.stops || []).length + 1}
                </span>
                <div className="wo-stop-body">
                  <div className="wo-stop-head">
                    <h4>{spj.destination}</h4>
                    {slot?.start && (
                      <span className="wo-muted">{t("s4_wo_gate_slot").replace("{time}", slot.start)}</span>
                    )}
                  </div>
                  {receipt ? (
                    <ReceiptReview
                      spj={{ ...spj, receipt }}
                      act={async (path, payload) => run(() => apiPost(path, payload))}
                      pendingAction={busy ? "busy" : ""}
                      words={{ close: t("s4_wo_override_cancel") }}
                    />
                  ) : (
                    <p className="wo-muted">{t("s4_wo_weigh_ticket_hint")}</p>
                  )}
                </div>
              </li>
            </ol>
          )}
        </div>

        <aside className="wo-audit" aria-labelledby="wo-audit-title">
          <h3 className="wo-section" id="wo-audit-title">
            {t("s4_wo_audit")}
          </h3>
          {entries.length === 0 ? (
            <p className="wo-muted">{loading ? t("s4_wo_loading") : t("s4_wo_audit_empty")}</p>
          ) : (
            <ol className="wo-audit-list" data-testid="wo-audit">
              {entries.map((entry, index) => (
                <li key={`${entry.action}-${entry.created_at}-${index}`}>
                  <strong>
                    {AUDIT_KEYS[entry.action]
                      ? t(AUDIT_KEYS[entry.action]).replace("{n}", (entry.payload?.stop_index ?? 0) + 1)
                      : entry.action}
                  </strong>
                  <small>
                    {whenLabel(entry.created_at, lang)} · {actorLabel(entry.actor)}
                    {entry.reason ? ` · ${entry.reason}` : ""}
                  </small>
                </li>
              ))}
            </ol>
          )}
          <p className="wo-override-note-box">
            <Lock size={14} aria-hidden="true" />
            {t("s4_wo_override_note")}
          </p>
        </aside>
      </div>
    </section>
  );
}
