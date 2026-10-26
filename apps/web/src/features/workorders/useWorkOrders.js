import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiGet } from "../../shared/api/client.js";
import { jakartaClock } from "../gate/gateModel.js";
import { planIdOf } from "./workOrdersModel.js";

const POLL_MS = 10000;

// The list of work orders (GET /spj, newest first) and the SPJ ids whose truck waits at the TPA gate.
export function useWorkOrders() {
  const [items, setItems] = useState([]);
  const [waiting, setWaiting] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offline, setOffline] = useState(false);
  const lastOk = useRef(null);

  const load = useCallback(async () => {
    const [list, safety] = await Promise.allSettled([apiGet("/spj?limit=500"), apiGet("/safety/overview")]);
    // A network failure keeps the last list on screen and says so.
    const unreachable =
      navigator.onLine === false || (list.status === "rejected" && !(list.reason instanceof ApiError));
    setOffline(unreachable);
    if (unreachable) {
      setLoading(false);
      return;
    }
    lastOk.current = jakartaClock(new Date());
    if (list.status === "fulfilled") {
      setItems(list.value.spj || []);
      setError(null);
    } else {
      setError(list.reason);
    }
    // Without the overview nothing reads "At TPA"; the list itself still stands.
    const trucks = safety.status === "fulfilled" ? safety.value.trucks || [] : [];
    setWaiting(new Set(trucks.filter((t) => t.gate_status === "waiting" && t.spj_id).map((t) => t.spj_id)));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener("online", load);
    window.addEventListener("offline", load);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", load);
      window.removeEventListener("offline", load);
    };
  }, [load]);

  return { items, waiting, loading, error, offline, since: lastOk.current, reload: load };
}

// Everything the detail pane reads for one SPJ: per-stop evidence, the audit trail, and the gate slot
// of the plan it was drafted from. Each source fails on its own; a failed one reads as null.
export function useWorkOrderDetail(spj, refreshKey) {
  const [detail, setDetail] = useState({ id: null, evidence: null, audit: null, slot: null });
  const id = spj?.spj_id;
  const planId = spj ? planIdOf(spj) : null;

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    const base = `/spj/${encodeURIComponent(id)}`;
    Promise.allSettled([
      apiGet(`${base}/evidence-summary`),
      apiGet(`${base}/audit`),
      planId ? apiGet(`/operations/plans/${encodeURIComponent(planId)}`) : Promise.resolve(null),
    ]).then(([evidence, audit, plan]) => {
      if (cancelled) return;
      const draft =
        plan.status === "fulfilled" ? (plan.value?.spj_drafts || []).find((d) => d.spj_id === id) : null;
      setDetail({
        id,
        evidence: evidence.status === "fulfilled" ? evidence.value : null,
        audit: audit.status === "fulfilled" ? audit.value : null,
        slot: draft?.gate_slot || null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [id, planId, refreshKey]);

  return { ...detail, loading: !!id && detail.id !== id };
}
