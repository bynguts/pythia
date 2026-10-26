import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { workspacePath } from "../workspaces.js";
import { describe } from "../../features/operations/NeedsYouPanel.jsx";
import { usePolled } from "../../features/operations/useOperations.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";

const POLL_MS = 60_000;
const SHOWN = 6;

/**
 * Top-bar bell: a count of the open "Needs you" items (GET /api/ops/needs-you) and a
 * popover with the newest few; each row and the footer open Operations.
 */
export function BellMenu() {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const feed = usePolled("/ops/needs-you", POLL_MS);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const items = feed.data?.items || [];
  const count = items.length;

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.querySelector("button")?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function go() {
    setOpen(false);
    navigate(workspacePath("operations"));
  }

  return (
    <div className="cx-bell-wrap" ref={rootRef}>
      <span ref={triggerRef}>
        <Button
          variant="ghost"
          iconOnly
          icon={Bell}
          className="cx-bell"
          aria-label={count ? t("f_bell_n").replace("{n}", count) : t("f_bell")}
          title={t("f_bell")}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="bell"
          onClick={() => {
            if (!open) feed.reload();
            setOpen((value) => !value);
          }}
        />
      </span>
      {count > 0 && (
        <span className="cx-bell-count" aria-hidden="true" data-testid="bell-count">
          {count > 9 ? "9+" : count}
        </span>
      )}
      {open && (
        <div className="cx-bell-pop" role="dialog" aria-label={t("f_bell")} data-testid="bell-popover">
          <p className="cx-bell-head">{t("f_bell")}</p>
          {count ? (
            <ul className="cx-bell-list">
              {items.slice(0, SHOWN).map((item) => {
                const view = describe(item, { t, lang, alert: null });
                return (
                  <li key={item.id}>
                    <button type="button" className="cx-bell-item" onClick={go} data-testid="bell-item">
                      <span
                        className={`cx-bell-dot is-${item.severity === "urgent" ? "urgent" : "normal"}`}
                      />
                      <span className="cx-bell-text">
                        <strong>{view.title}</strong>
                        <span>{view.sub}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="cx-bell-empty" data-testid="bell-empty">
              {feed.data ? t("f_bell_empty") : t("s1_loading")}
            </p>
          )}
          <button type="button" className="cx-bell-all" onClick={go} data-testid="bell-open-operations">
            {count > SHOWN ? t("f_bell_all_n").replace("{n}", count) : t("f_bell_all")}
          </button>
        </div>
      )}
    </div>
  );
}
