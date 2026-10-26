import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { formatDriverName } from "../../shared/format/driverName.js";
import { useConsole } from "../../app/console/useConsole.js";
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  OfflineBanner,
  Segmented,
  Skeleton,
  StatusDot,
  Tag,
} from "../../shared/ui/index.js";
import { SpjCreateForm } from "../fleet/SpjPanel.jsx";
import { WorkOrderDetail } from "./WorkOrderDetail.jsx";
import {
  STATE_TONE,
  TABS,
  inTab,
  matches,
  receiptNeedsReview,
  rowState,
  stopsDone,
  tabCounts,
} from "./workOrdersModel.js";
import { useWorkOrders } from "./useWorkOrders.js";
import "./workorders.css";

export function WorkOrdersScreen() {
  const { t } = useLanguage();
  const { permissions, setSubtitle } = useConsole();
  const canCreate = permissions.includes("dispatch:create");
  const { items, waiting, loading, error, offline, since, reload } = useWorkOrders();
  const [tab, setTab] = useState("active");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setSubtitle(t("s4_wo_crumb"));
    return () => setSubtitle(null);
  }, [t, setSubtitle]);

  const counts = useMemo(() => tabCounts(items), [items]);
  const visible = useMemo(
    () => items.filter((spj) => inTab(spj, tab) && matches(spj, query)),
    [items, tab, query],
  );
  const selected = visible.find((spj) => spj.spj_id === selectedId) || visible[0] || null;
  const waitingForProof = counts.proof;

  const summary = t("s4_wo_sub").replace("{active}", counts.active).replace("{proof}", waitingForProof);

  return (
    <div className="wo-page" data-testid="work-orders-page">
      <header className="wo-head">
        <div>
          <h1>{t("s4_wo_title")}</h1>
          <p className="wo-sub">{summary}</p>
        </div>
        <div className="wo-head-actions">
          <Segmented
            label={t("s4_wo_tabs")}
            value={tab}
            onChange={setTab}
            options={TABS.map((value) => ({
              value,
              label: t(`s4_wo_tab_${value}`),
              count: counts[value],
              testId: `wo-tab-${value}`,
            }))}
          />
          {canCreate && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} data-testid="wo-new">
              {t("s4_wo_new")}
            </Button>
          )}
        </div>
      </header>

      {offline && <OfflineBanner since={since} />}
      {(error || offline) && !items.length ? (
        <ErrorState
          title={t("s4_wo_error_title")}
          reason={error?.detail || error?.message || t("s4_error_reason")}
          onRetry={reload}
        />
      ) : loading ? (
        <Skeleton rows={5} />
      ) : (
        <div className="wo-grid">
          <section className="ui-card wo-list" aria-label={t("s4_wo_list")}>
            <div className="wo-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("s4_wo_search")}
                aria-label={t("s4_wo_search_label")}
                data-testid="wo-search"
              />
            </div>
            {visible.length === 0 ? (
              <EmptyState title={t("s4_wo_empty_title")} body={t(`s4_wo_empty_${tab}`)} testId="wo-empty" />
            ) : (
              <ul className="wo-rows" data-testid="wo-rows">
                {visible.map((spj) => {
                  const state = rowState(spj, waiting);
                  return (
                    <li key={spj.spj_id}>
                      <button
                        type="button"
                        className="wo-row"
                        aria-current={selected?.spj_id === spj.spj_id ? "true" : undefined}
                        onClick={() => setSelectedId(spj.spj_id)}
                        data-testid="wo-row"
                      >
                        <span className="wo-row-main">
                          <strong>{spj.spj_number}</strong>
                          <small>
                            {spj.truck_code} ·{" "}
                            {(() => {
                              const driver = formatDriverName(spj.driver_name, t);
                              return (
                                <span
                                  data-provenance={driver.simulated ? "simulated" : undefined}
                                  title={driver.title}
                                >
                                  {driver.label}
                                </span>
                              );
                            })()}{" "}
                            ·{" "}
                            {t("s4_wo_stops_count")
                              .replace("{done}", stopsDone(spj).split("/")[0])
                              .replace("{total}", (spj.stops || []).length)}
                          </small>
                        </span>
                        <span className="wo-row-state">
                          {receiptNeedsReview(spj) && (
                            <Tag tone="warn" data-testid="spj-receipt-needs-review">
                              {t("spj7_receipt_needs_review")}
                            </Tag>
                          )}
                          <StatusDot tone={STATE_TONE[state]}>{t(`s4_wo_state_${state}`)}</StatusDot>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {selected ? (
            <WorkOrderDetail
              key={selected.spj_id}
              spj={selected}
              state={rowState(selected, waiting)}
              onChanged={reload}
            />
          ) : (
            <section className="ui-card wo-detail">
              <EmptyState title={t("s4_wo_pick_title")} body={t("s4_wo_pick_body")} />
            </section>
          )}
        </div>
      )}

      <Drawer
        open={creating}
        onClose={() => setCreating(false)}
        title={t("s4_wo_new")}
        testId="wo-new-drawer"
      >
        <SpjCreateForm
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      </Drawer>
    </div>
  );
}
