import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../shared/api/client.js";

const POLL_MS = 30000;

const settled = (result) => (result.status === "fulfilled" ? result.value : null);

// One read of everything the TPA gate screen shows. A source that fails reads as null, so the
// card that needs it falls back to "—" instead of a made-up number.
//   day: "today" | "tomorrow"; isoDay: the Jakarta date of that day.
export function useGateData(day, isoDay) {
  const [state, setState] = useState({ board: null, safety: null, recap: null, queue: null, facts: null });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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
    setFailed(board === null);
    setState((current) => ({ board: board ?? current.board, safety, recap, queue, facts }));
    setLoading(false);
  }, [day, isoDay]);

  useEffect(() => {
    setLoading(true);
    setState({ board: null, safety: null, recap: null, queue: null, facts: null });
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return { ...state, loading, failed, reload: load };
}
