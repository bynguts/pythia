import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiGet } from "../../shared/api/client.js";
import { jakartaClock } from "./gateModel.js";

const POLL_MS = 30000;

const settled = (result) => (result.status === "fulfilled" ? result.value : null);

// One read of everything the TPA gate screen shows. A source that fails reads as null, so the
// card that needs it falls back to "—" instead of a made-up number.
//   day: "today" | "tomorrow"; isoDay: the Jakarta date of that day.
export function useGateData(day, isoDay) {
  const [state, setState] = useState({ board: null, safety: null, recap: null, queue: null, facts: null });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const lastOk = useRef(null);

  const load = useCallback(async () => {
    const today = day === "today";
    const boardPath = today ? "/gate/slots" : `/gate/slots?date=${isoDay}`;
    const results = await Promise.allSettled([
      apiGet(boardPath),
      today ? apiGet("/safety/overview") : Promise.resolve(null),
      today ? apiGet("/recap/daily") : Promise.resolve(null),
      today ? apiGet("/tpa/queue-status") : Promise.resolve(null),
      apiGet(`/field-facts?date=${isoDay}`),
    ]);
    const [board, safety, recap, queue, facts] = results.map(settled);
    // A network failure (not an HTTP error) keeps the last data on screen and says so.
    const unreachable =
      navigator.onLine === false ||
      (results[0].status === "rejected" && !(results[0].reason instanceof ApiError));
    if (!unreachable) lastOk.current = jakartaClock(new Date());
    setOffline(unreachable);
    setFailed(board === null);
    setState((current) =>
      unreachable ? current : { board: board ?? current.board, safety, recap, queue, facts },
    );
    setLoading(false);
  }, [day, isoDay]);

  useEffect(() => {
    setLoading(true);
    setState({ board: null, safety: null, recap: null, queue: null, facts: null });
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

  return { ...state, loading, failed, offline, since: lastOk.current, reload: load };
}
