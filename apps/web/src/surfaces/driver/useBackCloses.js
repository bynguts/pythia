import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// While an overlay is open (AR, the stop proof, the stop list, a message), the phone's back
// button closes it instead of leaving the driver app: opening pushes one history entry marked
// with `name` and back pops it. Closing from the screen only clears the mark in place: going
// back a step there would undo a tab change made in the same moment (a finished stop opens TPA).
export function useBackCloses(name, open, close) {
  const navigate = useNavigate();
  const location = useLocation();
  const pushed = useRef(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const marked = location.state?.overlay === name;

  useEffect(() => {
    if (open && !pushed.current) {
      pushed.current = true;
      navigate({ pathname: location.pathname, search: location.search }, { state: { overlay: name } });
    } else if (!open && pushed.current) {
      pushed.current = false;
      // The browser's own entry, not the rendered location: a tab change in the same moment
      // has already pushed a newer entry, which must stay.
      if (window.history.state?.usr?.overlay === name) {
        navigate({ pathname: window.location.pathname, search: window.location.search }, { replace: true });
      }
    }
    // Only the open flag drives this; the location is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    // Back pressed: the marked entry is gone while the overlay is still open.
    if (pushed.current && !marked) {
      pushed.current = false;
      closeRef.current();
    }
  }, [marked]);
}
