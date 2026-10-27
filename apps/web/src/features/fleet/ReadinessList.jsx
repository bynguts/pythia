import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { ListRow } from "../../shared/ui/ListRow.jsx";
import { MetricStrip } from "../../shared/ui/MetricStrip.jsx";

const POLL_MS = 30000;
// A hard stop: the truck may not leave until a supervisor acts.
const HARD_BLOCKERS = ["duty_blocked"];

// The morning readiness board (GET /api/readiness) as a plain list: the counts,
// then one row per truck saying it is ready or naming what holds it. Plain on purpose;
// the founder styles it.
export function ReadinessList() {
  const { t } = useLanguage();
  const [board, setBoard] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      apiFetch("/readiness?scope=plan", { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(response.status))))
        .then((body) => {
          setBoard(body);
          setFailed(false);
        })
        .catch((error) => error?.name !== "AbortError" && setFailed(true));
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  if (!board) {
    return <p className="rail-empty">{t(failed ? "w12_load_failed" : "w12_loading")}</p>;
  }
  const source = t("w12_src_in_app");
  return (
    <div data-testid="readiness-list" data-scope={board.scope_used}>
      <MetricStrip
        label={t("w12_ready_title")}
        metrics={[
          { label: t("w12_ready_ready"), value: board.counts.ready, source, testId: "readiness-count-ready" },
          {
            label: t("w12_ready_not_ready"),
            value: board.counts.not_ready,
            source,
            testId: "readiness-count-not-ready",
          },
          {
            label: t("w12_ready_blocked"),
            value: board.counts.blocked,
            source,
            tone: board.counts.blocked ? "danger" : undefined,
            testId: "readiness-count-blocked",
          },
        ]}
      />
      <p className="kec-note">
        {t(board.scope_used === "plan" ? "w12_ready_scope_plan" : "w12_ready_scope_fleet").replace(
          "{date}",
          board.date,
        )}
      </p>
      <ul className="ui-list">
        {board.trucks.map((truck) => {
          const hard =
            truck.damage?.heavy || truck.blockers.some((blocker) => HARD_BLOCKERS.includes(blocker));
          return (
            <ListRow
              key={truck.truck_code}
              icon={truck.ready ? CheckCircle2 : hard ? AlertTriangle : Clock}
              tone={truck.ready ? "success" : hard ? "danger" : "warning"}
              title={truck.truck_code}
              meta={
                truck.ready
                  ? t("w12_ready_yes")
                  : truck.blockers.map((blocker) => t(`w12_blocker_${blocker}`)).join(" · ")
              }
              testId="readiness-row"
            />
          );
        })}
      </ul>
    </div>
  );
}
