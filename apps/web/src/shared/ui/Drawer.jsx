import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useLanguage } from "../i18n/index.jsx";
import { Button } from "./Button.jsx";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Right-side panel (440 px) over a light veil (#EDEBE499). Traps focus, closes on
 * Esc or a veil click, makes the app behind it inert and returns focus on close.
 * @param {{
 *   open: boolean, onClose: () => void,
 *   title: any, subtitle?: any,
 *   avatar?: any,          // 32 px slot left of the title (e.g. <Mascot />)
 *   actions?: any,         // header buttons before the close button
 *   initialFocus?: string, // selector inside the drawer to focus first
 *   testId?: string, className?: string, children: any
 * }} props
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  avatar,
  actions,
  initialFocus,
  testId,
  className = "",
  children,
}) {
  const { t } = useLanguage();
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const opener = document.activeElement;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    const focusable = () =>
      Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
    const first = initialFocus ? panel.querySelector(initialFocus) : null;
    (first && !first.disabled ? first : focusable()[0] || panel).focus();

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const head = controls[0];
      const tail = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === head || !panel.contains(document.activeElement))) {
        event.preventDefault();
        tail.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === tail || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        head.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (root) root.inert = Boolean(wasInert);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open, initialFocus]);

  if (!open) return null;
  return createPortal(
    // Portalled to <body>: it carries the console's .cx root so .cx-scoped styles apply.
    <div className="cx ui-drawer-layer">
      <div className="ui-drawer-veil" role="presentation" onMouseDown={() => closeRef.current()} />
      <section
        ref={panelRef}
        className={`ui-drawer ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-drawer-title"
        tabIndex={-1}
        data-testid={testId}
      >
        <header className="ui-drawer-head">
          {avatar && <span className="ui-drawer-avatar">{avatar}</span>}
          <div className="ui-drawer-titles">
            <h2 id="ui-drawer-title" className="ui-drawer-title">
              {title}
            </h2>
            {subtitle && <p className="ui-drawer-subtitle">{subtitle}</p>}
          </div>
          {actions}
          <Button
            variant="ghost"
            iconOnly
            icon={X}
            aria-label={t("f_close")}
            onClick={() => closeRef.current()}
          />
        </header>
        <div className="ui-drawer-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
