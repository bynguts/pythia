import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// While an overlay is open (AR, the stop proof, the stop list, a message), the phone's back
// button closes it instead of leaving the driver app: opening pushes one history entry marked
// with `name` and back pops it. Closing from the screen pops that entry too, so no dead back
// presses pile up, but only while it is still the newest: a tab change made in the same moment
// (a finished stop opens TPA) has already pushed past it and must stay.
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
      // The browser's own entry, not the rendered location, which can lag a transition.
      if (window.history.state?.usr?.overlay === name) window.history.back();
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
