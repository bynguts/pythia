import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, QrCode, RefreshCw, Users, X } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { qrSvgPath } from "./qrSvg.js";
import { tablePresenceText } from "./useTableSession.js";

/**
 * "Put this on the table" (lazy chunk with the QR encoder): a QR code and the
 * plain link + session code that open /xr already joined to the twin's table
 * session. The phone has to reach this address, so the host is editable and
 * remembered on this device (prefilled from VITE_PUBLIC_ORIGIN when set).
 * A modal dialog: focus stays inside, Esc closes, focus returns to the trigger.
 */
const ORIGIN_KEY = "pythia_table_origin";

function normalizeOrigin(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

function isLocalOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.startsWith("127.") ||
      host === "0.0.0.0" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

function storedOrigin() {
  try {
    return localStorage.getItem(ORIGIN_KEY) || "";
  } catch {
    return "";
  }
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

export function TwinTableHandoff({ session, city, onClose, returnFocusRef }) {
  const { t, lang } = useLanguage();
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const defaultOrigin = normalizeOrigin(import.meta.env.VITE_PUBLIC_ORIGIN) || window.location.origin;
  const [draft, setDraft] = useState(() => storedOrigin() || defaultOrigin);
  const [copied, setCopied] = useState(false);
  const typed = normalizeOrigin(draft);
  const origin = typed || defaultOrigin;
  const { code, status, participants, start, stop } = session;
  const url = code
    ? `${origin}/xr?${new URLSearchParams({ session: code, city, lang: lang === "en" ? "en" : "id" })}`
    : "";
  const qr = useMemo(() => (url ? qrSvgPath(url) : null), [url]);

  // Opening the panel is the intent to share: start the session if there is none.
  useEffect(() => {
    if (!code && status === "idle") start();
  }, [code, status, start]);

  // Modal: the rest of the page is inert, Tab cycles inside, Esc closes.
  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    const trigger = returnFocusRef?.current;
    const background = Array.from(document.body.children).filter((el) => el !== backdrop);
    const previousInert = background.map((el) => el.inert);
    background.forEach((el) => {
      el.inert = true;
    });
    const focusable = () =>
      Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0,
      );
    (focusable()[0] || dialog).focus();
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const inside = controls.includes(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }
    function onFocusIn(event) {
      if (!dialog.contains(event.target)) (focusable()[0] || dialog).focus();
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      background.forEach((el, index) => {
        el.inert = previousInert[index];
      });
      trigger?.focus();
    };
  }, [returnFocusRef]);

  function changeOrigin(value) {
    setDraft(value);
    const next = normalizeOrigin(value);
    try {
      if (!String(value).trim()) localStorage.removeItem(ORIGIN_KEY);
      else if (next) localStorage.setItem(ORIGIN_KEY, next);
    } catch {
      // Storage blocked: the address holds for this panel only.
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const presence = tablePresenceText(t, participants, (n) => n.toLocaleString(t("twin_locale")));

  return createPortal(
    <div
      className="twin-handoff-backdrop"
      ref={backdropRef}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="twin-handoff"
        role="dialog"
        aria-modal="true"
        aria-labelledby="twin-handoff-title"
        aria-describedby="twin-handoff-lead"
        tabIndex={-1}
        data-testid="twin-handoff"
      >
        <header className="twin-handoff-head">
          <h2 id="twin-handoff-title">
            <QrCode size={18} aria-hidden="true" /> {t("ho_title")}
          </h2>
          <button
            type="button"
            className="twin-handoff-icon"
            data-testid="twin-handoff-close"
            aria-label={t("ho_close")}
            title={t("ho_close")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <p id="twin-handoff-lead" className="twin-handoff-lead">
          {t("ho_lead")}
        </p>

        <div className="twin-handoff-body">
          <div className="twin-handoff-qr">
            {qr ? (
              <svg
                data-testid="twin-handoff-qr"
                role="img"
                aria-label={t("ho_qr_label")}
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                shapeRendering="crispEdges"
              >
                <rect width={qr.size} height={qr.size} className="twin-handoff-qr-bg" />
                <path d={qr.path} className="twin-handoff-qr-ink" />
              </svg>
            ) : status === "error" ? null : (
              <p className="twin-handoff-wait" role="status">
                <RefreshCw size={16} aria-hidden="true" className="twin-spin" /> {t("ho_starting")}
              </p>
            )}
          </div>

          <div className="twin-handoff-info">
            {code && (
              <>
                <p className="twin-handoff-code">
                  <span>{t("ho_code")}</span>
                  <strong data-testid="twin-handoff-code">{code}</strong>
                </p>
                <p className="twin-handoff-label">{t("ho_url_label")}</p>
                <code className="twin-handoff-url" data-testid="twin-handoff-url">
                  {url}
                </code>
                <button type="button" className="twin-btn secondary" onClick={copyLink}>
                  <Copy size={16} aria-hidden="true" /> {copied ? t("ho_copied") : t("ho_copy")}
                </button>
                <p
                  className="twin-handoff-presence"
                  data-testid="twin-handoff-presence"
                  data-count={participants}
                  role="status"
                >
                  <Users size={15} aria-hidden="true" /> {presence}
                </p>
              </>
            )}
            {status === "error" && (
              <p className="twin-handoff-error" role="alert" data-testid="twin-handoff-error">
                {t("ho_error")}{" "}
                <button type="button" className="twin-btn secondary" onClick={() => start()}>
                  {t("ho_retry")}
                </button>
              </p>
            )}

            <label className="twin-handoff-label" htmlFor="twin-handoff-origin">
              {t("ho_origin_label")}
            </label>
            <input
              id="twin-handoff-origin"
              className="twin-handoff-origin"
              data-testid="twin-handoff-origin"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              aria-invalid={Boolean(draft.trim()) && !typed}
              aria-describedby="twin-handoff-origin-help"
              onChange={(event) => changeOrigin(event.target.value)}
            />
            <p id="twin-handoff-origin-help" className="twin-handoff-help">
              {draft.trim() && !typed
                ? t("ho_origin_invalid")
                : isLocalOrigin(origin)
                  ? null
                  : t("ho_origin_help")}
            </p>
            {isLocalOrigin(origin) && (
              <p className="twin-handoff-hint" role="note" data-testid="twin-handoff-local-hint">
                {t("ho_local_hint")}
              </p>
            )}
          </div>
        </div>

        <p className="twin-handoff-honesty" data-testid="twin-handoff-honesty">
          {t("ho_honesty")}
        </p>
        <p className="twin-handoff-help">{t("ho_leads")}</p>

        <div className="twin-handoff-actions">
          {code && (
            <button
              type="button"
              className="twin-btn secondary"
              data-testid="twin-handoff-stop"
              onClick={() => {
                stop();
                onClose();
              }}
            >
              {t("ho_stop")}
            </button>
          )}
          <button type="button" className="twin-btn primary" onClick={onClose}>
            {t("ho_done")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
